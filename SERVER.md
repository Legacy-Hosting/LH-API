# Legacy Hosting server baseline

The first supported production baseline is:

- Ubuntu 26.04 LTS
- Node.js 24.21.0 LTS
- npm 9.2.0
- pnpm 12.4.1
- PM2 7.0.4

## API deployment

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
```

Tagged releases include the guarded scripts under `ops/scripts`. The production path is `/opt/legacy-hosting/api/releases/VERSION`, with `current` and `previous` release symlinks. `deploy-release.sh` verifies the SHA-256 archive, validates protected environment files, installs frozen production dependencies, creates an encrypted backup, applies forward-only migrations, switches the release, reloads PM2, and restores the previous application release if local health verification fails.

Use the Nginx configurations under `ops/nginx`, then validate with `nginx -t`. The API configuration includes SSE buffering rules, proxy headers, HSTS, request-size limits, and an edge request limit. Set `TRUST_PROXY=true` only when the API is reachable exclusively through that trusted local proxy.

The API listens on `127.0.0.1:8080` by default. Put Nginx, Caddy, or another reverse proxy in front of it for HTTPS and public traffic.

Command output uses Server-Sent Events. The public API proxy must not buffer that route and must allow long reads. For Nginx, include a dedicated location before the general API location:

```nginx
location ~ ^/api/v1/panel/applications/.*/commands/.*/events$ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 35m;
}
```

Do not put database credentials or provider secrets in `ecosystem.config.cjs`. Keep production values in a protected environment file or secret manager and load them before `pm2 startOrReload`.

## Application detection defaults

When the panel detects a Node.js repository without an explicit version, use Node.js 24.21.0 as the initial suggestion. Repository files such as `.nvmrc`, `.node-version`, or `package.json#engines` take priority.

## Certbot and Cloudflare DNS

Each application node needs Nginx plus the Certbot Snap with the Cloudflare DNS plugin:

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo systemctl enable --now nginx
sudo snap install core
sudo snap refresh core
sudo apt-get remove -y certbot
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
sudo snap set certbot trust-plugin-with-root=ok
sudo snap install certbot-dns-cloudflare
```

Create the protected credentials directory and file:

```bash
mkdir -p ~/.secrets/certbot
chmod 700 ~/.secrets/certbot
chmod 600 ~/.secrets/certbot/cloudflare.ini
```

The credentials file must contain a scoped Cloudflare API token:

```ini
dns_cloudflare_api_token = CLOUDFLARE_API_TOKEN
```

Request the node certificate:

```bash
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/certbot/cloudflare.ini \
  -d ams3.web-01.legacyh.fyi \
  -m angel@legacyhosting.xyz \
  --agree-tos \
  --non-interactive
```

Test renewal after issuance:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

Use a Cloudflare token restricted to `Zone:DNS:Edit` for only the required zones. Never store the plaintext token in PM2 configuration, source control, application logs, or deployment records.

Panel certificate requests are queued through the API and executed by the authenticated node agent. The public API never accepts arbitrary Certbot arguments or shell commands.

The application DNS flow creates proxied CNAME records through each customer's Cloudflare OAuth connection. It then queues a signed node command that issues a certificate for the exact customer hostname and proxies HTTPS to the application's assigned loopback port. This supports Cloudflare Full (strict), because the origin presents a certificate matching the requested hostname.

Set `ACME_EMAIL` in the API environment and run every entry in `ecosystem.config.cjs`. `lh-certificate-worker` checks every six hours and queues renewal 30 days before expiry by default. Change the lead time with `CERTIFICATE_RENEWAL_DAYS`.

`lh-monitoring-worker` runs health checks, detects missing node heartbeats and PM2 processes, evaluates resource limits, dispatches alerts, and applies metric retention. Set `MONITORING_INTERVAL_MS` to change its 30-second default. To enable e-mail alerts, configure `RESEND_API_KEY` and a verified `ALERT_EMAIL_FROM`; panel and webhook alerts do not require Resend.

The agent writes one managed access log per application under `/var/log/nginx/lh-HOSTNAME.access.log`. Keep those logs in the node's normal logrotate policy. The agent persists byte offsets in `/var/lib/legacy-hosting-agent/traffic-offsets.json` so rotations and restarts do not repeatedly count old traffic.

Customer OAuth tokens are never kept in a node credentials directory. For each certificate command, the API refreshes the customer's token if needed; the agent writes it to a temporary mode-`0600` file and removes that file when Certbot exits. Certbot's generic renewal timer cannot independently renew these OAuth-backed customer lineages after the temporary file is removed, so renewal for them is owned by `lh-certificate-worker`. A separately configured node-hostname certificate may continue to use its own persistent, narrowly scoped private token and the normal Certbot timer.

Before starting the agent, verify the node prerequisites:

```bash
nginx -t
certbot plugins | grep dns-cloudflare
```

## Backup and restore

Install the shared tooling from `LH-Ops`, configure `/etc/legacy-hosting/backups/api.env` with mode `0600`, and enable `lh-mysql-backup@api.timer`. Backups are compressed, encrypted before they receive their final filename, checksummed, and retained locally for a bounded period. Follow the root `BACKUP.md` runbook for disposable restore drills and DigitalOcean point-in-time recovery.

## Agent distribution

Set `AGENT_DISTRIBUTION_DIRECTORY=/var/lib/legacy-hosting/agent-distributions/current` in the protected API environment. Promote a verified LH-Agent archive with `LH-Ops/scripts/install-agent-distribution.sh` before the first API deployment. The public installer endpoints then serve only the active, checksummed distribution; they do not read files from another source checkout.
