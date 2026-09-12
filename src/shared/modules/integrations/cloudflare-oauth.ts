import { env } from '../../../core/config/env.js'

const endpoints = {
  authorization: 'https://dash.cloudflare.com/oauth2/auth',
  token: 'https://dash.cloudflare.com/oauth2/token',
  revoke: 'https://dash.cloudflare.com/oauth2/revoke',
  userInfo: 'https://dash.cloudflare.com/oauth2/userinfo',
} as const

function configuration() {
  const values = {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    redirectUri: env.CLOUDFLARE_OAUTH_REDIRECT_URI,
    scopes: env.CLOUDFLARE_OAUTH_SCOPES,
  }

  if (!values.clientId || !values.clientSecret || !values.redirectUri || !values.scopes) {
    throw new Error('Cloudflare OAuth is not configured')
  }
  return values as Record<keyof typeof values, string>
}

export function cloudflareAuthorizationUrl(state: string) {
  const config = configuration()
  const url = new URL(endpoints.authorization)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', config.scopes)
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeCloudflareCode(code: string) {
  const config = configuration()
  const response = await fetch(endpoints.token, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
  })

  if (!response.ok) throw new Error(`Cloudflare token exchange failed with status ${response.status}`)
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number; token_type: string; scope?: string }>
}

export const cloudflareOAuthEndpoints = endpoints
