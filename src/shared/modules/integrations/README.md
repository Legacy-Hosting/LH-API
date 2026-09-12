# Integrations

Provider connections are owned by a team, never globally by a user.

## Cloudflare

- `platform` connection: Legacy Hosting's private account for node records such as `ams3.web-01.legacyh.fyi`.
- `customer` connection: a customer's own Cloudflare account, authorized through OAuth and isolated by `team_id`.
- Customers choose which returned accounts and zones are enabled for the team.
- Access and refresh tokens are encrypted before database storage.
- Disconnecting revokes the OAuth grant and marks the integration disconnected.
- DNS changes must record an audit event and may only target zones enabled in `integration_resources`.

The OAuth callback must validate a one-time, expiring state stored in `oauth_authorization_states`. Do not expose the callback flow until user sessions and team authorization middleware are active.

## Cloudflare OAuth client

The existing `Legacy Hosting SSO` client can be reused with these scopes:

- `dns.read`
- `dns.write`
- `zone.read`
- `user-details.read`
- `offline_access`

Before customer launch:

1. Register the exact production callback URL: `https://api.legacyhosting.xyz/api/v1/integrations/cloudflare/callback`.
2. Keep the Client ID and Client Secret in production environment secrets, never in source control.
3. Change the client from private to public only when the integration is ready for customer use.
4. Confirm the verified publisher domain, logo, client URL, privacy policy, and terms shown on the consent screen.
5. Test authorization, token refresh, revocation, account selection, zone selection, and an actual DNS record change with a non-production zone.

Cloudflare public visibility is permanent. Complete the callback, authorization checks, encryption, and disconnect flow before changing visibility.
