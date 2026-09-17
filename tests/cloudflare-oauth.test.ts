import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCloudflareTokenRequest,
  cloudflareOAuthEndpoints,
} from "../src/shared/modules/integrations/cloudflare-oauth.js";

test("Cloudflare backend OAuth endpoints use the API origin", () => {
  assert.equal(
    cloudflareOAuthEndpoints.authorization,
    "https://dash.cloudflare.com/oauth2/auth",
  );
  assert.equal(
    cloudflareOAuthEndpoints.token,
    "https://api.cloudflare.com/oauth2/token",
  );
  assert.equal(
    cloudflareOAuthEndpoints.userInfo,
    "https://api.cloudflare.com/oauth2/userinfo",
  );
});

test("Cloudflare basic token authentication keeps credentials out of the body", () => {
  const request = buildCloudflareTokenRequest(
    "client_secret_basic",
    "client-id",
    "client-secret",
    { grant_type: "authorization_code", code: "test-code" },
  );

  assert.equal(
    request.headers.Authorization,
    `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
  );
  assert.equal(request.body.get("client_id"), null);
  assert.equal(request.body.get("client_secret"), null);
});

test("Cloudflare POST token authentication sends credentials in the form body", () => {
  const request = buildCloudflareTokenRequest(
    "client_secret_post",
    "client-id",
    "client-secret",
    { grant_type: "refresh_token", refresh_token: "test-refresh-token" },
  );

  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.body.get("client_id"), "client-id");
  assert.equal(request.body.get("client_secret"), "client-secret");
});
