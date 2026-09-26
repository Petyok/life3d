#!/bin/bash
# Build and publish to https://life.petruha.ge (vps-germany, nginx static root).
# The nginx vhost lives in deploy/life.petruha.ge.conf (certbot-managed on the server).
set -euo pipefail
cd "$(dirname "$0")"
npx vite build
# nginx serves these via gzip_static; -9 beats its on-the-fly level 1 by ~15%
find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.wasm' \) -exec gzip -9 -k -f {} \;
rsync -az --delete --chmod=D755,F644 dist/ vps-germany:/var/www/life.petruha.ge/
sshub exec vps-germany --timeout 30 -- chown -R www-data:www-data /var/www/life.petruha.ge
echo "deployed: https://life.petruha.ge"
