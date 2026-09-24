import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, before, test } from "node:test";
import { env } from "../src/core/config/env.js";
import {
	exchangeGitHubUserCode,
	getGitHubOrganizationInstallation,
	githubAppInstallationUrl,
	githubAuthorizationErrorCode,
	GitHubApiError,
	githubUserAuthorizationUrl,
	hasGitHubRepositoryReadWriteAccess,
	listGitHubUserInstallationAccess,
	listGitHubUserInstallationRepositories,
	listGitHubUserInstallations,
} from "../src/shared/modules/integrations/github-app.js";

const originalFetch = globalThis.fetch;

before(() => {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	Object.assign(env, {
		GITHUB_APP_ID: "12345",
		GITHUB_APP_SLUG: "legacy-hosting-deployments",
		GITHUB_CLIENT_ID: "Iv1.test-client",
		GITHUB_CLIENT_SECRET: "test-secret",
		GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(
			privateKey.export({ type: "pkcs8", format: "pem" }),
		).toString("base64"),
		GITHUB_OAUTH_REDIRECT_URI:
			"https://api.legacyhosting.xyz/api/v1/integrations/github/callback",
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("GitHub users are sent to OAuth authorization, never installation update", () => {
	const url = new URL(githubUserAuthorizationUrl("test-state"));
	assert.equal(url.origin, "https://github.com");
	assert.equal(url.pathname, "/login/oauth/authorize");
	assert.equal(url.searchParams.get("client_id"), "Iv1.test-client");
	assert.equal(url.searchParams.get("state"), "test-state");
	assert.equal(
		url.searchParams.get("redirect_uri"),
		"https://api.legacyhosting.xyz/api/v1/integrations/github/callback",
	);
	assert.equal(url.searchParams.has("setup_action"), false);
	assert.doesNotMatch(url.toString(), /installations\/new|setup_action=update/);
	const installationUrl = githubAppInstallationUrl();
	assert.equal(
		installationUrl,
		"https://github.com/apps/legacy-hosting-deployments/installations/new",
	);
	assert.doesNotMatch(installationUrl ?? "", /setup_action=update/);
});

test("GitHub App user OAuth exchanges the code without broad OAuth scopes", async () => {
	let requestBody: Record<string, string> = {};
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "https://github.com/login/oauth/access_token");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				access_token: "ghu_user-token",
				expires_in: 28_800,
				refresh_token: "ghr_refresh-token",
				refresh_token_expires_in: 15_897_600,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const token = await exchangeGitHubUserCode("oauth-code");
	assert.equal(requestBody.code, "oauth-code");
	assert.equal(requestBody.grant_type, "authorization_code");
	assert.equal("scope" in requestBody, false);
	assert.equal(token.accessToken, "ghu_user-token");
	assert.equal(token.refreshToken, "ghr_refresh-token");
});

test("the existing NextarchStudio installation is resolved by the App", async () => {
	let requestedPath = "";
	globalThis.fetch = async (input) => {
		requestedPath = new URL(String(input)).pathname;
		return new Response(
			JSON.stringify({
				id: 987654,
				account: { id: 42, login: "NextarchStudio", type: "Organization" },
				repository_selection: "all",
				permissions: { contents: "read", metadata: "read" },
				suspended_at: null,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const installation =
		await getGitHubOrganizationInstallation("NextarchStudio");
	assert.equal(requestedPath, "/orgs/NextarchStudio/installation");
	assert.equal(installation.id, 987654);
	assert.equal(installation.account.login, "NextarchStudio");
});

test("repository listing uses the user-to-server installation endpoint", async () => {
	const requests: string[] = [];
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		requests.push(`${url.pathname}${url.search}`);
		assert.equal(
			(init?.headers as Record<string, string>).Authorization,
			"Bearer ghu_person-a",
		);
		return new Response(
			JSON.stringify({
				total_count: 2,
				repositories: [
					{
						id: 1,
						name: "Web",
						full_name: "NextarchStudio/Web",
						private: true,
						default_branch: "main",
						html_url: "https://github.com/NextarchStudio/Web",
						owner: { login: "NextarchStudio" },
						permissions: { pull: true, push: true, admin: false },
					},
					{
						id: 2,
						name: "API",
						full_name: "NextarchStudio/API",
						private: true,
						default_branch: "main",
						html_url: "https://github.com/NextarchStudio/API",
						owner: { login: "NextarchStudio" },
						permissions: { pull: true, push: false, admin: false },
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const repositories = await listGitHubUserInstallationRepositories(
		987654,
		"ghu_person-a",
	);
	assert.deepEqual(requests, [
		"/user/installations/987654/repositories?per_page=100&page=1",
	]);
	assert.deepEqual(
		repositories.map((repository) => repository.full_name),
		["NextarchStudio/Web", "NextarchStudio/API"],
	);
});

test("different GitHub users receive different team-filtered repositories", async () => {
	globalThis.fetch = async (_input, init) => {
		const authorization = (init?.headers as Record<string, string>)
			.Authorization;
		const suffix = authorization === "Bearer ghu_person-a" ? "Web" : "API";
		return new Response(
			JSON.stringify({
				total_count: 1,
				repositories: [
					{
						id: suffix === "Web" ? 1 : 2,
						name: suffix,
						full_name: `NextarchStudio/${suffix}`,
						private: true,
						default_branch: "main",
						html_url: `https://github.com/NextarchStudio/${suffix}`,
						owner: { login: "NextarchStudio" },
						permissions: { pull: true },
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const [personA, personB] = await Promise.all([
		listGitHubUserInstallationRepositories(987654, "ghu_person-a"),
		listGitHubUserInstallationRepositories(987654, "ghu_person-b"),
	]);
	assert.deepEqual(
		personA.map((repository) => repository.full_name),
		["NextarchStudio/Web"],
	);
	assert.deepEqual(
		personB.map((repository) => repository.full_name),
		["NextarchStudio/API"],
	);
});

test("personal and organization installations expose only writable repositories", async () => {
	const requests: string[] = [];
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		requests.push(`${url.pathname}${url.search}`);
		assert.equal(
			(init?.headers as Record<string, string>).Authorization,
			"Bearer ghu_multi-account",
		);
		if (url.pathname === "/user/installations")
			return new Response(
				JSON.stringify({
					total_count: 3,
					installations: [
						{
							id: 101,
							account: {
								id: 1,
								login: "NextarchStudio",
								type: "Organization",
							},
							repository_selection: "all",
							permissions: { contents: "read", metadata: "read" },
							suspended_at: null,
						},
						{
							id: 202,
							account: { id: 2, login: "PersonA", type: "User" },
							repository_selection: "selected",
							permissions: { contents: "read", metadata: "read" },
							suspended_at: null,
						},
						{
							id: 303,
							account: { id: 3, login: "PausedOrg", type: "Organization" },
							repository_selection: "all",
							permissions: { contents: "read" },
							suspended_at: "2026-09-24T00:00:00Z",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const owner = url.pathname.includes("/101/")
			? "NextarchStudio"
			: "PersonA";
		const repositories =
			owner === "NextarchStudio"
				? [
						{
							id: 11,
							name: "Writable",
							full_name: "NextarchStudio/Writable",
							private: true,
							default_branch: "main",
							html_url: "https://github.com/NextarchStudio/Writable",
							owner: { login: "NextarchStudio" },
							permissions: { pull: true, push: true },
						},
						{
							id: 12,
							name: "ReadOnly",
							full_name: "NextarchStudio/ReadOnly",
							private: true,
							default_branch: "main",
							html_url: "https://github.com/NextarchStudio/ReadOnly",
							owner: { login: "NextarchStudio" },
							permissions: { pull: true, push: false },
						},
					]
				: [
						{
							id: 21,
							name: "Personal",
							full_name: "PersonA/Personal",
							private: true,
							default_branch: "main",
							html_url: "https://github.com/PersonA/Personal",
							owner: { login: "PersonA" },
							permissions: { pull: true, push: false, admin: true },
						},
					];
		return new Response(
			JSON.stringify({ total_count: repositories.length, repositories }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const installations = await listGitHubUserInstallations(
		"ghu_multi-account",
	);
	assert.equal(installations.length, 3);
	requests.length = 0;
	const access = await listGitHubUserInstallationAccess(
		"ghu_multi-account",
	);
	assert.deepEqual(
		access.map((entry) => entry.installation.account.login),
		["NextarchStudio", "PersonA"],
	);
	assert.deepEqual(
		access.flatMap((entry) =>
			entry.repositories.map((repository) => repository.full_name),
		),
		["NextarchStudio/Writable", "PersonA/Personal"],
	);
	assert.equal(requests.some((request) => request.includes("memberships")), false);
	assert.equal(requests.some((request) => request.includes("/303/")), false);
});

test("repository access requires write permission", () => {
	const repository = {
		id: 1,
		name: "ReadOnly",
		full_name: "NextarchStudio/ReadOnly",
		private: true,
		default_branch: "main",
		html_url: "https://github.com/NextarchStudio/ReadOnly",
		owner: { login: "NextarchStudio" },
	};
	assert.equal(
		hasGitHubRepositoryReadWriteAccess({
			...repository,
			permissions: { pull: true, push: false },
		}),
		false,
	);
	assert.equal(
		hasGitHubRepositoryReadWriteAccess({
			...repository,
			permissions: { pull: true, push: true },
		}),
		true,
	);
});

test("SSO failures receive a dedicated actionable error", () => {
	const error = new GitHubApiError(
		403,
		"Resource protected by organization SAML enforcement",
		"required; url=https://github.com/orgs/NextarchStudio/sso",
	);
	assert.equal(githubAuthorizationErrorCode(error), "github_sso_required");
});

test("user authorization preserves deployments and is not fixed to one organization", async () => {
	const routes = await readFile(
		new URL(
			"../src/shared/modules/integrations/integration.routes.ts",
			import.meta.url,
		),
		"utf8",
	);
	const service = await readFile(
		new URL(
			"../src/shared/modules/integrations/github-user.service.ts",
			import.meta.url,
		),
		"utf8",
	);
	assert.doesNotMatch(routes, /githubInstallationUrl|setup_action/);
	assert.doesNotMatch(routes, /ensureGitHubOrganizationInstallation/);
	assert.doesNotMatch(service, /DELETE FROM integration_resources/);
	assert.doesNotMatch(service, /integration_resources SET enabled=FALSE/);
	assert.doesNotMatch(service, /listGitHubUserOrganizations/);
	assert.match(service, /listGitHubUserInstallationAccess/);
	assert.match(service, /github_no_repository_access/);
});
