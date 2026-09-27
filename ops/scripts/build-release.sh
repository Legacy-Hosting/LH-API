#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 VERSION [RELEASES_REPOSITORY]" >&2
  exit 1
fi

version=$1
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid semantic version: $version" >&2
  exit 1
fi

repository_root=$(cd "$(dirname "$0")/../.." && pwd)
releases_root=${2:-"$repository_root/../LH-Releases"}
service_directory="$releases_root/LH-API"
checksum_directory="$service_directory/SHA256"
archive_name="lh-api-$version.tar.gz"
archive="$service_directory/$archive_name"
checksum="$checksum_directory/$archive_name.sha256"

if [[ ! -d $releases_root/.git ]]; then
  echo "LH-Releases repository not found: $releases_root" >&2
  exit 1
fi
if [[ -e $archive || -e $checksum ]]; then
  echo "Release $version already exists and cannot be overwritten" >&2
  exit 1
fi

pnpm --dir "$repository_root" build
mkdir -p "$service_directory" "$checksum_directory"

temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
release_root="$temporary_directory/lh-api-$version"
mkdir -p "$release_root"
cp -a "$repository_root"/{dist,database,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,ecosystem.config.cjs,.env.example,README.md,SERVER.md} "$release_root/"

{
  printf 'service=LH-API\n'
  printf 'version=%s\n' "$version"
  printf 'commit=%s\n' "$(git -C "$repository_root" rev-parse HEAD)"
  printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$release_root/RELEASE-MANIFEST.txt"

tar -C "$temporary_directory" -czf "$archive" "lh-api-$version"
(cd "$service_directory" && sha256sum "$archive_name" > "SHA256/$archive_name.sha256")

echo "Created $archive"
echo "Created $checksum"
