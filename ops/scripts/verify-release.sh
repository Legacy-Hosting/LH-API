#!/usr/bin/env bash
set -Eeuo pipefail

base=/opt/legacy-hosting/api
test -L "$base/current"
test -f "$base/current-release"
curl --fail --silent --show-error http://127.0.0.1:8080/health | \
  grep -q '"database":"connected"'
for process_name in lh-api lh-certificate-worker lh-monitoring-worker; do
  pm2 describe "$process_name" >/dev/null
done
current_release=$(readlink -f "$base/current")
recorded_release=$(cat "$base/current-release")
if [[ $recorded_release != "$(basename "$current_release")" ]]; then
  echo "API current-release marker does not match the current symlink" >&2
  exit 1
fi
CURRENT_RELEASE="$current_release" node <<'NODE'
const { execFileSync } = require("node:child_process");
const currentRelease = process.env.CURRENT_RELEASE;
const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }));
for (const name of ["lh-api", "lh-certificate-worker", "lh-monitoring-worker"]) {
  const processInfo = processes.find((item) => item.name === name);
  if (!processInfo?.pm2_env?.pm_exec_path?.startsWith(`${currentRelease}/`)) {
    throw new Error(`${name} is not running from ${currentRelease}`);
  }
}
NODE
nginx -t
echo "LH-API release verification passed for $(cat "$base/current-release")."
