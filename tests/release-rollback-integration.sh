#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${LH_ROLLBACK_TEST_CONTAINER:-} != 1 || ${EUID} -ne 0 ]]; then
  echo "Run only as root inside the isolated rollback test container" >&2
  exit 2
fi

repository_root=$(cd "$(dirname "$0")/.." && pwd)
base=/opt/legacy-hosting/api
fake_bin=$(mktemp -d)
trap 'rm -rf -- "$fake_bin"' EXIT
export PATH="$fake_bin:$PATH"

cat > "$fake_bin/pm2" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${FAIL_ROLLBACK:-0} == 1 && $1 == start && ${2:-} == */1.0.0/* ]]; then
  exit 1
fi
exit 0
SCRIPT
cat > "$fake_bin/curl" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' '{"status":"ok","database":"connected"}'
SCRIPT
cat > "$fake_bin/nginx" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
cat > "$fake_bin/node" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
chmod 0755 "$fake_bin"/*

for version in 1.0.0 1.1.0; do
  release="$base/releases/$version"
  mkdir -p "$release/dist"
  touch "$release/dist/server.js" "$release/ecosystem.config.cjs"
done
ln -s "$base/releases/1.1.0" "$base/current"
ln -s "$base/releases/1.0.0" "$base/previous"
printf '1.1.0\n' > "$base/current-release"

if FAIL_ROLLBACK=1 bash "$repository_root/ops/scripts/rollback-release.sh" 1.0.0 >/dev/null 2>&1; then
  echo "Failed API rollback unexpectedly succeeded" >&2
  exit 1
fi
[[ $(readlink -f "$base/current") == "$base/releases/1.1.0" ]]
[[ $(readlink -f "$base/previous") == "$base/releases/1.0.0" ]]
[[ $(cat "$base/current-release") == 1.1.0 ]]

bash "$repository_root/ops/scripts/rollback-release.sh" 1.0.0
[[ $(readlink -f "$base/current") == "$base/releases/1.0.0" ]]
[[ $(readlink -f "$base/previous") == "$base/releases/1.1.0" ]]
[[ $(cat "$base/current-release") == 1.0.0 ]]

printf '9.9.9\n' > "$base/current-release"
if bash "$repository_root/ops/scripts/verify-release.sh" >/dev/null 2>&1; then
  echo "API verification accepted a stale release marker" >&2
  exit 1
fi
printf '1.0.0\n' > "$base/current-release"
bash "$repository_root/ops/scripts/verify-release.sh"

echo "API transactional rollback integration test passed"
