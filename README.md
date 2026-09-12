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

Copy `.env.example` to `.env`, set the DigitalOcean Managed MySQL 8 connection string, then run `npm install` and `npm run dev`.

The supported server baseline and PM2 deployment instructions are documented in `SERVER.md`.

`LH-Agent` posts signed heartbeats to `POST /api/v1/agent/heartbeat`. Each node has an independent credential; the API stores only its SHA-256-derived authentication key and validates request age plus an HMAC signature before accepting metrics.
