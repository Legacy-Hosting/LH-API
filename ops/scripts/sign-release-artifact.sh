#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 PRIVATE_KEY ARCHIVE CHECKSUM SIGNATURE" >&2
  exit 2
fi

signature_target=$4
signature_directory=$(dirname "$signature_target")

for command in openssl readlink sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

for path in "$1" "$2" "$3"; do
  if [[ ! -f $path || -L $path ]]; then
    echo "Release signing input must be a regular, non-symlink file: $path" >&2
    exit 1
  fi
done
if [[ -e $signature_target || -L $signature_target ]]; then
  echo "Release signature already exists and cannot be overwritten: $signature_target" >&2
  exit 1
fi

private_key=$(readlink -f "$1")
archive=$(readlink -f "$2")
checksum=$(readlink -f "$3")
private_key_mode=$(stat -c '%a' "$private_key")
if (( (8#$private_key_mode & 077) != 0 )); then
  echo "Release private key must not be accessible by group or other users" >&2
  exit 1
fi

read -r expected_hash checksum_name extra < "$checksum"
archive_name=$(basename "$archive")
actual_hash=$(sha256sum "$archive" | cut -d ' ' -f 1)
if [[ -n ${extra:-} || ! $expected_hash =~ ^[a-f0-9]{64}$ || \
      $checksum_name != "$archive_name" || $actual_hash != "$expected_hash" ]]; then
  echo "Release checksum is invalid or does not describe $archive_name" >&2
  exit 1
fi

mkdir -p "$signature_directory"
signature=$(mktemp "$signature_directory/.${archive_name}.XXXXXX.sig")
public_key=$(mktemp)
cleanup() {
  rm -f -- "$signature" "$public_key"
}
trap cleanup EXIT

openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
openssl pkeyutl -sign -rawin -inkey "$private_key" -in "$archive" -out "$signature"
openssl pkeyutl -verify -rawin -pubin -inkey "$public_key" \
  -in "$archive" -sigfile "$signature" >/dev/null

if [[ $(wc -c < "$signature") -ne 64 ]]; then
  echo "Release key must be Ed25519 and produce a 64-byte signature" >&2
  exit 1
fi

chmod 0644 "$signature"
mv -f -- "$signature" "$signature_target"
trap - EXIT
rm -f -- "$public_key"
echo "Signed $archive_name"
