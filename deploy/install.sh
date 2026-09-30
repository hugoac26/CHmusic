#!/usr/bin/env bash
# Correr DENTRO do container (Debian 12), como root, com a app já copiada para /opt/chmusic
set -euo pipefail
APP=/opt/chmusic

apt-get update
apt-get install -y nodejs npm ffmpeg python3 curl ca-certificates openssl

# yt-dlp (binário oficial, sempre a versão mais recente) + atualização semanal
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
printf '#!/bin/sh\n/usr/local/bin/yt-dlp -U >/dev/null 2>&1\n' > /etc/cron.weekly/yt-dlp-update
chmod +x /etc/cron.weekly/yt-dlp-update

# Utilizador dedicado com UID fixo (1000 -> 101000 no host, se o container for não privilegiado)
id chmusic >/dev/null 2>&1 || useradd --system --uid 1000 --home-dir "$APP" --shell /usr/sbin/nologin chmusic
mkdir -p /srv/musica
chown -R chmusic:chmusic "$APP"

cd "$APP"
sudo -u chmusic npm install --omit=dev 2>/dev/null || su -s /bin/sh chmusic -c "npm install --omit=dev"

if [ ! -f /etc/chmusic.env ]; then
  PASS=$(openssl rand -base64 12 | tr -d '/+=')
  cat > /etc/chmusic.env <<ENV
MUSIC_DIR=/srv/musica
PORT=3000
AUTH_USER=chmusic
AUTH_PASS=$PASS
ENV
  chmod 600 /etc/chmusic.env
  echo ">>> Utilizador: chmusic   Palavra-passe: $PASS   (guardada em /etc/chmusic.env)"
fi

cp "$APP/deploy/chmusic.service" /etc/systemd/system/chmusic.service
systemctl daemon-reload
systemctl enable --now chmusic
echo ">>> CHmusic a correr em http://$(hostname -I | awk '{print $1}'):3000"
