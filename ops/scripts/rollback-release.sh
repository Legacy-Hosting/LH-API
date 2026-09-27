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
if [[ -z $current || $current != "$base/releases/"* || ! -d $current ]]; then
  echo "Current API symlink does not reference a valid release" >&2
  exit 1
fi
if [[ $current == "$target" ]]; then
  echo "API release $1 is already current" >&2
  exit 1
fi

rollback_on_error() {
  failure=$?
  trap - ERR
  ln -sfn "$current" "$base/current"
  pm2 delete lh-api lh-certificate-worker lh-monitoring-worker >/dev/null 2>&1 || true
  pm2 start "$current/ecosystem.config.cjs" --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  exit "$failure"
}
trap rollback_on_error ERR
ln -sfn "$target" "$base/current"
pm2 delete lh-api lh-certificate-worker lh-monitoring-worker >/dev/null 2>&1 || true
pm2 start "$target/ecosystem.config.cjs" --update-env
pm2 save
curl --fail --silent --show-error --retry 10 --retry-delay 2 \
  http://127.0.0.1:8080/health | grep -q '"status":"ok"'
ln -sfn "$current" "$base/previous"
printf '%s\n' "$1" > "$base/current-release"
trap - ERR
echo "LH-API rolled back to $1. Database migrations were left in place."
