#!/bin/bash
# Build and publish to https://life.petruha.ge (vps-germany, nginx static root),
# and install/refresh the shared counters API (server/stats.py as systemd unit
# life-stats on 127.0.0.1:8787, proxied at /api/ by deploy/life.petruha.ge.conf).
# The nginx vhost itself is certbot-managed on the server: after editing
# deploy/life.petruha.ge.conf, upload it by hand and `nginx -t && systemctl reload nginx`.
set -euo pipefail
cd "$(dirname "$0")"
npx vite build
# nginx serves these via gzip_static; -9 beats its on-the-fly level 1 by ~15%
find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.wasm' \) -exec gzip -9 -k -f {} \;
rsync -az --delete --chmod=D755,F644 dist/ vps-germany:/var/www/life.petruha.ge/
sshub exec vps-germany --timeout 30 -- chown -R www-data:www-data /var/www/life.petruha.ge

# stats API: restart only when the code or the unit changed
changed=$(rsync -ai --chmod=F644 server/stats.py vps-germany:/opt/life-stats/ --rsync-path='mkdir -p /opt/life-stats && rsync';
          rsync -ai --chmod=F644 deploy/life-stats.service vps-germany:/etc/systemd/system/)
if [ -n "$changed" ]; then
  sshub exec vps-germany --timeout 30 -- 'systemctl daemon-reload && systemctl enable --now life-stats && systemctl restart life-stats'
fi
echo "deployed: https://life.petruha.ge"
