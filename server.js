const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mm = require('music-metadata');

// Pasta da música (muda com: MUSIC_DIR=/caminho node server.js)
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const PORT = process.env.PORT || 3000;
const EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac']);
const CACHE_FILE = path.join(__dirname, 'cache.json');
const PL_FILE = path.join(__dirname, 'playlists.json');
const FOLDER_COVERS = ['cover.jpg', 'folder.jpg', 'front.jpg', 'cover.png', 'folder.png', 'front.png'];

fs.mkdirSync(MUSIC_DIR, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

let cache = readJSON(CACHE_FILE, {});
let playlists = readJSON(PL_FILE, []);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

async function readTrack(full) {
  const rel = path.relative(MUSIC_DIR, full);
  const mtime = fs.statSync(full).mtimeMs;
  if (cache[rel] && cache[rel].mtime === mtime && cache[rel].v === 2) return cache[rel];
  const parts = rel.split(path.sep);
  const base = path.basename(full, path.extname(full));
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  const t = {
    id: rel, mtime, v: 2, hasAlbumTag: false,
    title: m ? m[2] : base,
    artist: m ? m[1] : (parts.length > 1 ? parts[0] : 'Desconhecido'),
    album: parts.length > 1 ? parts[parts.length - 2] : 'Singles',
    albumArtist: '', no: 0, dur: 0, year: null, tagCover: false
  };
  try {
    const { common, format } = await mm.parseFile(full);
    if (common.title) t.title = common.title;
    if (common.artist) t.artist = common.artist;
    if (common.album) { t.album = common.album; t.hasAlbumTag = true; }
    t.albumArtist = common.albumartist || common.artist || t.artist;
    t.no = (common.track && common.track.no) || 0;
    t.year = common.year || null;
    t.dur = format.duration || 0;
    t.tagCover = !!(common.picture && common.picture.length);
  } catch { t.albumArtist = t.artist; }
  return (cache[rel] = t);
}

async function scan() {
  const files = walk(MUSIC_DIR);
  const out = [];
  for (const f of files) out.push(await readTrack(f)); // sequencial, para não sobrecarregar
  const ids = new Set(out.map(t => t.id));
  for (const k of Object.keys(cache)) if (!ids.has(k)) delete cache[k];
  writeJSON(CACHE_FILE, cache);
  return out;
}

const safe = id => {
  const file = path.resolve(MUSIC_DIR, String(id || ''));
  return file.startsWith(MUSIC_DIR + path.sep) && fs.existsSync(file) ? file : null;
};


// ---- Capas online (MusicBrainz + Cover Art Archive, com iTunes como alternativa) ----
const COVERS_DIR = path.join(__dirname, 'covers');
const MISS_FILE = path.join(__dirname, 'covers-miss.json');
const ONLINE = process.env.NO_ONLINE_COVERS !== '1';
const UA = 'CHmusic/1.0 (leitor de musica pessoal)';
fs.mkdirSync(COVERS_DIR, { recursive: true });
let misses = readJSON(MISS_FILE, {});
const coverKey = t => crypto.createHash('md5').update((t.hasAlbumTag ? t.albumArtist + '|' + t.album : t.artist + '|' + t.title).toLowerCase()).digest('hex');
const coverPath = t => path.join(COVERS_DIR, coverKey(t) + '.jpg');
const folderCover = file => FOLDER_COVERS.map(n => path.join(path.dirname(file), n)).find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const queue = [], queued = new Set();
let running = false, found = 0;

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function getImage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const b = Buffer.from(await r.arrayBuffer());
  return b.length > 2000 ? b : null;
}

// devolve imagem | null (procurou e não achou) | undefined (sem ligação à net)
async function lookup(t) {
  const artist = t.hasAlbumTag ? t.albumArtist : t.artist;
  const name = t.hasAlbumTag ? t.album : t.title;
  let reached = false;
  try {
    const q = encodeURIComponent(t.hasAlbumTag ? `release:"${name}" AND artist:"${artist}"` : `recording:"${name}" AND artist:"${artist}"`);
    const d = await getJSON(`https://musicbrainz.org/ws/2/${t.hasAlbumTag ? 'release' : 'recording'}/?query=${q}&fmt=json&limit=5`);
    reached = true;
    const ids = t.hasAlbumTag ? (d.releases || []).map(r => r.id) : (d.recordings || []).flatMap(r => (r.releases || []).map(x => x.id));
    for (const id of [...new Set(ids)].slice(0, 4)) {
      const img = await getImage(`https://coverartarchive.org/release/${id}/front-500`).catch(() => null);
      if (img) return img;
    }
  } catch {}
  try {
    const d = await getJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + name)}&entity=${t.hasAlbumTag ? 'album' : 'song'}&limit=1`);
    reached = true;
    const u = d.results && d.results[0] && d.results[0].artworkUrl100;
    if (u) { const img = await getImage(u.replace('100x100bb', '600x600bb')).catch(() => null); if (img) return img; }
  } catch {}
  return reached ? null : undefined;
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const t = queue.shift();
    const img = await lookup(t).catch(() => undefined);
    if (img) { fs.writeFileSync(coverPath(t), img); found++; delete misses[coverKey(t)]; }
    else if (img === null) misses[coverKey(t)] = Date.now(); // tenta de novo daqui a 7 dias
    queued.delete(coverKey(t));
    writeJSON(MISS_FILE, misses);
    await sleep(1100); // MusicBrainz pede no máximo 1 pedido por segundo
  }
  running = false;
}

function wantCover(t) {
  if (!ONLINE) return;
  const k = coverKey(t);
  if (queued.has(k) || t.tagCover || folderCover(path.join(MUSIC_DIR, t.id)) || fs.existsSync(coverPath(t))) return;
  if (misses[k] && Date.now() - misses[k] < 7 * 864e5) return;
  queued.add(k); queue.push(t); runQueue();
}

const app = express();
app.use(express.json());

// Autenticação básica opcional (ativa se AUTH_USER e AUTH_PASS estiverem definidos)
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  const expected = Buffer.from('Basic ' + Buffer.from(process.env.AUTH_USER + ':' + process.env.AUTH_PASS).toString('base64'));
  app.use((req, res, next) => {
    const got = Buffer.from(req.headers.authorization || '');
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="CHmusic"').sendStatus(401);
  });
}
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tracks', async (req, res) => {
  const tracks = await scan();
  tracks.sort((a, b) => a.album.localeCompare(b.album) || a.no - b.no || a.title.localeCompare(b.title));
  const seen = new Set();
  for (const t of tracks) { const k = t.album + '\0' + t.albumArtist; if (!seen.has(k)) { seen.add(k); wantCover(t); } }
  res.json(tracks.map(({ mtime, ...t }) => t));
});

app.get('/api/stream', (req, res) => {
  const file = safe(req.query.id);
  file ? res.sendFile(file) : res.sendStatus(404);
});

// Capa: primeiro a embebida nas tags, depois cover.jpg/folder.jpg na pasta
app.get('/api/cover', async (req, res) => {
  const file = safe(req.query.id);
  if (!file) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  const t = cache[path.relative(MUSIC_DIR, file)];
  if (t && t.tagCover) {
    try {
      const { common } = await mm.parseFile(file);
      const pic = mm.selectCover(common.picture);
      if (pic) return res.type(pic.format).send(Buffer.from(pic.data));
    } catch {}
  }
  for (const n of FOLDER_COVERS) {
    const p = path.join(path.dirname(file), n);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  if (t && fs.existsSync(coverPath(t))) return res.sendFile(coverPath(t));
  res.set('Cache-Control', 'no-store');
  res.sendStatus(404);
});
app.get('/api/covers/status', (req, res) => res.json({ pending: queued.size, found }));

// Playlists
const savePl = () => writeJSON(PL_FILE, playlists);
app.get('/api/playlists', (req, res) => res.json(playlists));
app.post('/api/playlists', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Nome em falta.' });
  const pl = { id: crypto.randomUUID(), name, tracks: Array.isArray(req.body.tracks) ? req.body.tracks : [] };
  playlists.push(pl); savePl(); res.json(pl);
});
app.patch('/api/playlists/:id', (req, res) => {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.sendStatus(404);
  const { name, add, remove } = req.body;
  if (name) pl.name = String(name).trim().slice(0, 80);
  if (add && !pl.tracks.includes(add)) pl.tracks.push(add);
  if (remove) pl.tracks = pl.tracks.filter(t => t !== remove);
  savePl(); res.json(pl);
});
app.delete('/api/playlists/:id', (req, res) => {
  playlists = playlists.filter(p => p.id !== req.params.id);
  savePl(); res.json({ ok: true });
});

// Download com yt-dlp + ffmpeg (embebe tags e capa no mp3)
app.post('/api/download', (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL inválido.' });
  const args = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist',
    '--embed-metadata', '--embed-thumbnail',
    '-o', path.join(MUSIC_DIR, '%(artist,uploader)s - %(title)s.%(ext)s'), url];
  const p = spawn('yt-dlp', args);
  let err = '';
  p.stderr.on('data', d => (err += d));
  p.on('error', () => res.status(500).json({ error: 'yt-dlp não encontrado. Instala-o (e o ffmpeg) e tenta de novo.' }));
  p.on('close', code => code === 0 ? res.json({ ok: true }) : res.status(500).json({ error: err.split('\n').filter(Boolean).pop() || 'Falha no download.' }));
});

app.listen(PORT, () => console.log(`A tocar em http://localhost:${PORT}  (música: ${MUSIC_DIR})`));
