# Changelog

## 1.3.2 — 2026-10-06

- Allow application edits to add public Web/API processes with separate hostnames in workspace-connected Cloudflare zones.
- Save dedicated domains and process settings atomically; preserve existing process IDs, assigned ports and encrypted environment values.
- Provision CNAME and hostname-specific HTTPS routes after saving, with retryable warnings for partial provisioning failures.
- Reject hostname ownership conflicts and shared-alias misuse; defer provisioning for disabled processes.
- Add isolated MySQL and service-level regression tests. No new production database migrations.
