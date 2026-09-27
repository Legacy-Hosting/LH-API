#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 || $# -ne 1 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "Usage as root: $0 VERSION" >&2
  exit 2
fi
base=/opt/legacy-hosting/api
target="$base/releases/$1"
if [[ ! -f $target/dist/server.js || ! -f $target/ecosystem.config.cjs ]]; then
  echo "API release does not exist: $target" >&2
  exit 1
fi
current=$(readlink -f "$base/current" 2>/dev/null || true)
if [[ -n $current && $current == "$base/releases/"* && -d $current ]]; then
  ln -sfn "$current" "$base/previous"
fi
ln -sfn "$target" "$base/current"
pm2 delete lh-api lh-certificate-worker lh-monitoring-worker >/dev/null 2>&1 || true
pm2 start "$target/ecosystem.config.cjs" --update-env
pm2 save
curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8080/health | grep -q '"status":"ok"'
printf '%s\n' "$1" > "$base/current-release"
echo "LH-API rolled back to $1. Database migrations were left in place."
