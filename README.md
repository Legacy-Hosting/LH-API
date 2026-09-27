# Legacy Hosting API

Shared modular backend for Legacy Hosting products.

## Structure

```text
src/core/                       API infrastructure and configuration
src/shared/modules/             Cross-product modules such as auth and teams
src/products/panel/modules/     Hosting panel capabilities
src/products/billing/modules/   Billing capabilities
```

Every new product owns its routes and modules under `src/products/<product>`. Code belongs in `shared` only when two or more products genuinely use it.

Cloudflare and GitHub connections live in `src/shared/modules/integrations` because they can be reused by the panel, billing, and future Legacy Hosting products. Connections are isolated per team. Legacy Hosting's private infrastructure connection is stored separately from customer OAuth connections.

## Development

Copy `.env.example` to `.env`, set the DigitalOcean Managed MySQL 8 connection string, then run:

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Production also requires `DATABASE_SSL_CA` to point to DigitalOcean's downloaded CA certificate. The API and migration runner remove client-specific `ssl-mode` URL parameters and establish a verified TLS connection with that CA.

The migration runner applies the numbered SQL files in order, uses a MySQL advisory lock, and rejects previously applied migrations that have been edited.

Panel routes require an authenticated database session. The first account is created with `INITIAL_ADMIN_TOKEN`; later registration follows the database-controlled `open`, `invite_only`, or `closed` mode. Authentication uses WebAuthn/passkeys, including Windows Hello.

Browser mutations are protected by an exact Origin check plus a session-bound CSRF token. The panel obtains the token from `GET /api/v1/auth/csrf` and sends it through `X-CSRF-Token`. Authentication endpoints have tighter per-IP limits than the general API. Production startup requires separate `CSRF_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` values.

The supported server baseline and PM2 deployment instructions are documented in `SERVER.md`.

Tags named `v*` run verification and place the immutable archive in `LH-Releases/LH-API`. Its SHA-256 checksum is stored separately in `LH-Releases/LH-API/SHA256`.

`LH-Agent` posts signed heartbeats to `POST /api/v1/agent/heartbeat`. Each node has an independent credential; the API stores only its SHA-256-derived authentication key and validates request age plus an HMAC signature before accepting metrics.

Node registration keeps public and private network identities separate. Each node has a public FQDN, optional private FQDN, dedicated IPv4 and IPv6 fields for both networks, and an independent application CNAME target. At least one public IP address is required.

Agent v1 signatures include a one-time UUID nonce persisted in MySQL, preventing a captured signed request from being replayed within the timestamp window. The agent also sends its legacy signature during the rolling upgrade. Keep `ALLOW_LEGACY_AGENT_SIGNATURES=true` only until every node runs agent v1, then set it to `false`.

## Authentication and secrets

- Accounts use discoverable WebAuthn passkeys, including Windows Hello.
- The first platform administrator requires `INITIAL_ADMIN_TOKEN` and can be created even while registration is closed.
- Session tokens, invitation tokens, OAuth state, node tokens, and command leases are stored only as hashes.
- Provider credentials and application environment values are encrypted with AES-256-GCM. Generate `CREDENTIAL_ENCRYPTION_KEY` with `openssl rand -base64 32` and keep it outside source control.
- Every panel query is scoped to a team membership. The panel sends the selected team through `X-Team-ID`.

## Cloudflare OAuth

Configure the existing Cloudflare OAuth client with this callback URL:

```text
https://api.legacyhosting.xyz/api/v1/integrations/cloudflare/callback
```

Required scopes are `dns.read`, `dns.write`, `zone.read`, `user-details.read`, and `offline_access`. Customer authorizations are stored per team. Application creation selects one of the authorized zones and provisions a proxied CNAME pointing to the selected node's configured CNAME target.

Set `CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD` to the token endpoint authentication method configured on the Cloudflare client: `client_secret_basic` or `client_secret_post`. New server-side clients should default to `client_secret_basic` unless the client is explicitly configured for POST authentication.

Server-side token, refresh, revoke, and user-info requests use `CLOUDFLARE_OAUTH_API_ORIGIN` (default `https://api.cloudflare.com`). Interactive user authorization remains on `https://dash.cloudflare.com`; keeping the two origins separate prevents dashboard bot challenges from blocking backend OAuth requests.

The current private Cloudflare client can only serve accounts allowed by that private client. Promoting it to public is a separate, permanent Cloudflare-side decision.

## GitHub App

Use a GitHub App instead of a classic OAuth app or personal access token. Configure it with:

- User authorization callback URL: `https://api.legacyhosting.xyz/api/v1/integrations/github/callback`
- Webhook URL: `https://api.legacyhosting.xyz/api/v1/integrations/github/webhook`
- Repository permissions: Metadata (read) and Contents (read-only)
- Webhook event: Push
- Install the App once on each personal account or organization that should grant repository access; account and organization owners control repository selection

Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_BASE64`, and `GITHUB_WEBHOOK_SECRET`. `GITHUB_OAUTH_REDIRECT_URI` should match the configured user authorization callback URL.

App installation and user authorization are separate. Every panel user authorizes the GitHub App through the OAuth web flow; no OAuth scopes are requested because GitHub App user access tokens inherit the App's fine-grained permissions. The encrypted user token discovers the App installations available to that GitHub user and calls `/user/installations/{installation_id}/repositories` for each personal account or organization. Only repositories where GitHub reports both read and write permission are exposed in the panel. Expiring user tokens are refreshed and kept encrypted at rest.

Deploys never use the user's token. Installation tokens are generated only when needed, expire through GitHub, and are restricted to the selected repository. Existing repository resources remain intact when users connect or disconnect. The webhook delivery ID is persisted for idempotency, so a redelivered push does not queue duplicate deployments.

## Deployment flow

Repository inspection reads `package.json` and lockfiles through the GitHub App, detects the package manager, build script, start script, and common Node.js framework, then stores the detected runtime in MySQL. Each deployment becomes a leased node command. The agent validates storage paths, PM2 names, executable allowlists, command signatures, and one-time leases before executing it.

After DNS provisioning, the API queues a separate `configure_proxy` command. The node agent obtains a hostname-specific certificate with Certbot's Cloudflare DNS-01 plugin, writes an Nginx reverse proxy to the application's internal port, validates it with `nginx -t`, and reloads Nginx. Cloudflare OAuth access tokens are sent only inside expiring node-command leases and exist on the node only in a temporary mode-`0600` credentials file.

The dedicated `lh-certificate-worker` scans every six hours. Certificates missing an expiry or expiring within `CERTIFICATE_RENEWAL_DAYS` are queued for the responsible node, while an existing queued or leased certificate command prevents duplicates.

Successful deployments report the checked-out Git commit back from the node. The Applications view uses that revision history for auditable rollback jobs; rollback is another normal repository-scoped deployment rather than a filesystem swap or arbitrary node command. PM2 log requests are bounded to 10–500 lines and use the same signed, leased queue. Environment secret values are write-only: the panel can list keys, replace individual values, or delete keys, but the API never returns decrypted values to the browser.

While a command runs, the agent sends throttled output chunks through the authenticated lease. The API keeps the latest 200,000 characters in MySQL and the panel follows changed snapshots over Server-Sent Events. This remains compatible with multiple API instances because SSE readers poll shared database state instead of relying on an in-memory event bus. Progress calls renew the command lease and carry cancellation requests back to the node.

Deployment failures, cancellations, and certificate failures create team notifications. Notifications are shared with the workspace, while read state is stored independently for each user.

## Monitoring and alerting

`lh-monitoring-worker` evaluates node heartbeats, PM2 process samples, HTTP health checks, and effective resource limits every `MONITORING_INTERVAL_MS`. Workspace defaults act as the plan-level CPU, memory, storage, and monthly traffic limits; each application can inherit those limits or override them independently.

Raw node, process, application, and health-check samples are stored in MySQL. The monitoring API aggregates them into one-minute, five-minute, hourly, or four-hour buckets for the one-hour, 24-hour, seven-day, and 30-day panel graphs. The worker removes samples after each workspace's configured retention period.

Alerts are stateful and deduplicated. A node, process, health check, or resource limit creates one active alert, sends reminders only after the configured cooldown, and emits a recovery event when it becomes healthy again. Panel notifications are available without external services. Email delivery uses Resend when both `RESEND_API_KEY` and `ALERT_EMAIL_FROM` are configured. Customer webhook URLs and signing secrets are AES-256-GCM encrypted; enabled webhooks require HTTPS and include `X-LH-Signature-256`.
