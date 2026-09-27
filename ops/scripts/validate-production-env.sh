#!/usr/bin/env bash
set -Eeuo pipefail

environment_file=${1:-/etc/legacy-hosting/api.env}
if [[ ! -f $environment_file ]]; then
  echo "Missing protected API environment: $environment_file" >&2
  exit 1
fi
permissions=$(stat -c '%a' "$environment_file")
if (( (8#$permissions & 077) != 0 )); then
  echo "$environment_file must have mode 0600 or stricter" >&2
  exit 1
fi

set -a
. "$environment_file"
set +a
required=(
  NODE_ENV PANEL_ORIGIN AGENT_DISTRIBUTION_DIRECTORY DATABASE_URL
  DATABASE_SSL_CA WEBAUTHN_RP_ID
  WEBAUTHN_ORIGIN CREDENTIAL_ENCRYPTION_KEY CSRF_SECRET
  SSO_INTERNAL_URL SSO_ISSUER SSO_IDENTITY_BRIDGE_TOKEN
  CLOUDFLARE_OAUTH_CLIENT_ID CLOUDFLARE_OAUTH_CLIENT_SECRET
  CLOUDFLARE_OAUTH_REDIRECT_URI CLOUDFLARE_OAUTH_API_ORIGIN
  CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD GITHUB_APP_ID GITHUB_APP_SLUG
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_OAUTH_REDIRECT_URI
  GITHUB_APP_PRIVATE_KEY_BASE64 GITHUB_WEBHOOK_SECRET ACME_EMAIL
)
for name in "${required[@]}"; do
  if [[ -z ${!name:-} ]]; then
    echo "Missing API setting: $name" >&2
    exit 1
  fi
done
if [[ $NODE_ENV != production ]]; then
  echo "NODE_ENV must be production" >&2
  exit 1
fi
for url in "$PANEL_ORIGIN" "$WEBAUTHN_ORIGIN" "$CLOUDFLARE_OAUTH_REDIRECT_URI" \
  "$CLOUDFLARE_OAUTH_API_ORIGIN" "$GITHUB_OAUTH_REDIRECT_URI" \
  "$SSO_INTERNAL_URL" "$SSO_ISSUER"; do
  if [[ $url != https://* ]]; then
    echo "Production origins and OAuth URLs must use HTTPS" >&2
    exit 1
  fi
done
if [[ ! -r $DATABASE_SSL_CA ]]; then
  echo "Cannot read the database CA certificate" >&2
  exit 1
fi
for file in install-node-agent.sh lh-agent-runtime.tar.gz \
  lh-agent-runtime.tar.gz.sha256; do
  if [[ ! -r "$AGENT_DISTRIBUTION_DIRECTORY/$file" ]]; then
    echo "Cannot read agent distribution file: $file" >&2
    exit 1
  fi
done
if [[ $CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD != client_secret_basic && \
      $CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD != client_secret_post ]]; then
  echo "Invalid Cloudflare OAuth token authentication method" >&2
  exit 1
fi
if [[ ${#CSRF_SECRET} -lt 32 || ${#GITHUB_WEBHOOK_SECRET} -lt 32 || \
      ${#SSO_IDENTITY_BRIDGE_TOKEN} -lt 32 ]]; then
  echo "CSRF_SECRET, GITHUB_WEBHOOK_SECRET, and SSO_IDENTITY_BRIDGE_TOKEN must contain at least 32 characters" >&2
  exit 1
fi
decoded_key_bytes=$(printf '%s' "$CREDENTIAL_ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c)
if [[ $decoded_key_bytes -ne 32 ]]; then
  echo "CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes" >&2
  exit 1
fi

echo "API production environment validation passed without printing secrets."
