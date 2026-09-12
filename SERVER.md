# Legacy Hosting server baseline

The first supported production baseline is:

- Ubuntu 26.04 LTS
- Node.js 22.22.1
- npm 9.2.0
- pnpm 12.4.1
- PM2 7.0.4

## API deployment

```bash
pnpm install --frozen-lockfile
pnpm build
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
```

The API listens on `127.0.0.1:8080` by default. Put Nginx, Caddy, or another reverse proxy in front of it for HTTPS and public traffic.

Do not put database credentials or provider secrets in `ecosystem.config.cjs`. Keep production values in a protected environment file or secret manager and load them before `pm2 startOrReload`.

## Panel deployment

The panel is a static Vite build:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Serve `LH-Panel/dist` through Nginx or Caddy. The panel does not need its own PM2 process.

## Application detection defaults

When the panel detects a Node.js repository without an explicit version, use Node.js 22.22.1 as the initial suggestion. Repository files such as `.nvmrc`, `.node-version`, or `package.json#engines` take priority.

## Certbot and Cloudflare DNS

The node uses the Certbot Snap with the Cloudflare DNS plugin:

```bash
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

Future panel certificate requests must be queued through the API and executed by the authenticated node agent. The public API must never accept arbitrary Certbot arguments or shell commands.
