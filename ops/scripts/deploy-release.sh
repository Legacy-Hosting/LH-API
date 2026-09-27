#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 || $# -ne 4 ]]; then
  echo "Usage as root: $0 ARCHIVE CHECKSUM SIGNATURE VERSION" >&2
  exit 2
fi
version=$4
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid API release version" >&2
  exit 1
fi
verifier=/usr/local/lib/legacy-hosting-ops/verify-release-artifact.sh
public_key=/etc/legacy-hosting/release-keys/lh-api.pub
if [[ ! -x $verifier || ! -r $public_key ]]; then
  echo "API release verifier or pinned public key is not installed" >&2
  exit 1
fi
"$verifier" "$public_key" "$1" "$2" "$3"
archive=$(readlink -f "$1")

base=/opt/legacy-hosting/api
release="$base/releases/$version"
environment_file=/etc/legacy-hosting/api.env
if [[ -e $release ]]; then
  echo "API release already exists: $release" >&2
  exit 1
fi
for certificate_file in fullchain.pem privkey.pem; do
  if [[ ! -r /etc/letsencrypt/live/api.legacyhosting.xyz/$certificate_file ]]; then
    echo "Missing TLS certificate file for api.legacyhosting.xyz" >&2
    exit 1
  fi
done
install -d -m 0755 "$base/releases"
staging=$(mktemp -d "$base/releases/.staging-${version}.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
tar -xzf "$archive" --no-same-owner --strip-components=1 -C "$staging"
for path in package.json pnpm-lock.yaml ecosystem.config.cjs dist/server.js public/favicon.svg \
  database/migrations ops/nginx/api.legacyhosting.xyz.conf \
  ops/scripts/validate-production-env.sh; do
  if [[ ! -e "$staging/$path" ]]; then
    echo "API release is missing $path" >&2
    exit 1
  fi
done
"$staging/ops/scripts/validate-production-env.sh" "$environment_file"
ln -s "$environment_file" "$staging/.env"
pnpm --dir "$staging" install --prod --frozen-lockfile
if [[ -x /usr/local/lib/legacy-hosting-ops/backup-mysql.sh && \
      -f /etc/legacy-hosting/backups/api.env ]]; then
  /usr/local/lib/legacy-hosting-ops/backup-mysql.sh /etc/legacy-hosting/backups/api.env
else
  echo "A verified API backup job is required before migrations" >&2
  exit 1
fi
(cd "$staging" && node dist/core/database/migrate.js)
chown -R root:root "$staging"
chmod 0755 "$staging"
mv "$staging" "$release"
trap - EXIT

previous=
if [[ -L $base/current ]]; then
  previous=$(readlink -f "$base/current" 2>/dev/null || true)
  if [[ -n $previous && $previous == "$base/releases/"* && -d $previous ]]; then
    ln -sfn "$previous" "$base/previous"
  else
    echo "Current API symlink points outside the release directory" >&2
    exit 1
  fi
elif [[ -e $base/current ]]; then
  echo "$base/current must be a release symlink" >&2
  exit 1
fi
ln -sfn "$release" "$base/current"

rollback_on_error() {
  pm2 delete lh-api lh-certificate-worker lh-monitoring-worker >/dev/null 2>&1 || true
  if [[ -n $previous && -d $previous ]]; then
    ln -sfn "$previous" "$base/current"
    pm2 start "$previous/ecosystem.config.cjs" --update-env || true
  else
    rm -f -- "$base/current"
  fi
}
trap rollback_on_error ERR
pm2 delete lh-api lh-certificate-worker lh-monitoring-worker >/dev/null 2>&1 || true
pm2 start "$release/ecosystem.config.cjs" --update-env
pm2 save
curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:8080/health | grep -q '"status":"ok"'

install -m 0644 "$release/ops/nginx/api.legacyhosting.xyz.conf" \
  /etc/nginx/sites-available/api.legacyhosting.xyz.conf
ln -sfn /etc/nginx/sites-available/api.legacyhosting.xyz.conf \
  /etc/nginx/sites-enabled/api.legacyhosting.xyz.conf
nginx -t
systemctl reload nginx
trap - ERR

printf '%s\n' "$version" > "$base/current-release"
echo "LH-API $version deployed and verified."
