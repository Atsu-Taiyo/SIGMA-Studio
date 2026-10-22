import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { handleRequest } from "./worker.mjs";

const env = { APP_ORIGIN: "https://web.example.test", SIGMA_COLLABORATION_URL: "https://sync.example.test", SIGMA_SUPABASE_URL: "https://auth.example.test",
  SIGMA_SUPABASE_ANON_KEY: "sb_publishable_fixture", SESSION_SECRET: "fixture-session-encryption-key-32-bytes-minimum" };
const documentId = "00000000-0000-4000-8000-000000000001";
const tokens = { access_token: "fixture-private-access", refresh_token: "fixture-private-refresh", expires_in: 3600, user: { id: "fixture-actor", email: "fixture@example.test" } };
const request = (path, options = {}) => new Request(`${env.APP_ORIGIN}${path}`, { ...options, headers: { Origin: env.APP_ORIGIN,
  ...(path.startsWith("/api/collaboration/") ? { "X-Sigma-Actor": tokens.user.id } : {}), ...options.headers } });
async function login(issued = tokens) {
  const start = await handleRequest(request("/api/auth/login", { method: "POST" }), env);
  const startBody = await start.json(), url = new URL(startBody.url);
  assert.equal(url.origin, env.SIGMA_SUPABASE_URL);
  assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  const loginCookie = start.headers.getSetCookie()[0].split(";")[0];
  const callback = new URL(url.searchParams.get("redirect_to"));
  callback.searchParams.set("code", "fixture-code");
  const finish = await handleRequest(new Request(callback, { headers: { Cookie: loginCookie } }), env, async (url, options) => {
    assert.equal(url, `${env.SIGMA_SUPABASE_URL}/auth/v1/token?grant_type=pkce`);
    const body = JSON.parse(options.body);
    assert.equal(body.auth_code, "fixture-code");
    assert.equal(typeof body.code_verifier, "string");
    return Response.json(issued);
  });
  assert.equal(finish.status, 303);
  const cookie = finish.headers.getSetCookie().find(value => value.startsWith("sigma-web-session="));
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes(tokens.access_token)); assert.ok(!cookie.includes(tokens.refresh_token));
  return cookie.split(";")[0];
}

test("uses PKCE and returns only identity to the browser, with encrypted HttpOnly tokens", async () => {
  const cookie = await login();
  const response = await handleRequest(request("/api/auth/session", { headers: { Cookie: cookie } }), env);
  assert.deepEqual(await response.json(), { user: { actorId: "fixture-actor", email: "fixture@example.test" } });
});
test("rejects login CSRF and callbacks without the browser's verifier cookie", async () => {
  assert.equal((await handleRequest(request("/api/auth/login", { method: "POST", headers: { Origin: "https://evil.test" } }), env)).status, 403);
  assert.equal((await handleRequest(request("/auth/callback/web?code=forged&state=forged"), env)).status, 400);
});
test("never proxies unauthenticated requests or unconfigured server keys", async () => {
  assert.equal((await handleRequest(request(`/api/collaboration/documents/${documentId}/snapshot`), env)).status, 401);
  assert.equal((await handleRequest(request("/api/auth/session"), { ...env, SIGMA_SUPABASE_ANON_KEY: "sb_secret_forbidden" })).status, 503);
});
test("rejects a stale tab's account before forwarding edits, assets or opening a socket", async () => {
  const cookie = await login({ ...tokens, user: { id: "other-account" } });
  let forwarded = 0;
  for (const [route, method, headers] of [
    [`/documents/${documentId}/updates`, "POST", {}],
    [`/documents/${documentId}/assets/${documentId}`, "PUT", {}],
    [`/documents/${documentId}/snapshot`, "GET", {}],
    [`/documents/${documentId}/socket?actor=${tokens.user.id}`, "GET", { Upgrade: "websocket" }],
  ]) {
    const response = await handleRequest(request(`/api/collaboration${route}`, { method, headers: { Cookie: cookie, ...headers } }), env,
      async () => { forwarded++; return Response.json({}); });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "ACCOUNT_CHANGED" });
  }
  assert.equal(forwarded, 0);
});
test("requires an account binding for collaboration requests", async () => {
  const cookie = await login();
  const response = await handleRequest(request(`/api/collaboration/documents/${documentId}/updates`, {
    method: "POST", headers: { Cookie: cookie, "X-Sigma-Actor": "" },
  }), env, async () => { throw new Error("Must not forward an unbound edit"); });
  assert.equal(response.status, 409);
});
test("forwards the signed-in user's authority to the fixed existing backend and strips injected headers", async () => {
  const cookie = await login();
  const response = await handleRequest(request(`/api/collaboration/documents/${documentId}/sync`, { method: "POST", headers: { Cookie: cookie, Authorization: "Bearer injected", "X-Sigma-Internal": "injected", "Content-Type": "application/json" }, body: "{}" }), env,
    async (url, options) => {
      assert.equal(url, `${env.SIGMA_COLLABORATION_URL}/documents/${documentId}/sync`);
      assert.equal(options.headers.get("Authorization"), `Bearer ${tokens.access_token}`);
      assert.equal(options.headers.get("X-Sigma-Internal"), null);
      assert.equal(options.redirect, "manual");
      return Response.json({ update: "fixture" });
    });
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-sigma-actor"), "fixture-actor");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("does not expose new-document creation, share creation, billing or arbitrary forwarding", async () => {
  const cookie = await login();
  for (const route of ["documents", "catalog/share/begin", "billing/checkout", "https://evil.test"])
    assert.equal((await handleRequest(request(`/api/collaboration/${route}`, { method: "POST", headers: { Cookie: cookie } }), env)).status, 404);
});
test("rejects tampered cookies and returns no upstream exception details", async () => {
  const cookie = await login();
  assert.equal((await handleRequest(request("/api/auth/session", { headers: { Cookie: `${cookie.slice(0, -8)}tampered` } }), env)).status, 401);
  const response = await handleRequest(request(`/api/collaboration/documents/${documentId}/snapshot`, { headers: { Cookie: cookie } }), env, async () => { throw new Error("private-provider-error"); });
  assert.deepEqual(await response.json(), { error: "WEB_REQUEST_FAILED" });
});
test("refuses upstream redirects rather than forwarding user credentials to another origin", async () => {
  const cookie = await login();
  const response = await handleRequest(request(`/api/collaboration/documents/${documentId}/snapshot`, { headers: { Cookie: cookie } }), env, async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return Response.redirect("https://untrusted.example.test", 302);
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(await response.json(), { error: "UPSTREAM_REDIRECT" });
});
test("refreshes an expiring session without exposing either token to browser JavaScript", async () => {
  const cookie = await login({ ...tokens, expires_in: 1 });
  const response = await handleRequest(request("/api/auth/session", { headers: { Cookie: cookie } }), env, async (url, options) => {
    assert.equal(url, `${env.SIGMA_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`);
    assert.deepEqual(JSON.parse(options.body), { refresh_token: tokens.refresh_token });
    return Response.json({ ...tokens, access_token: "refreshed-access", refresh_token: "refreshed-private" });
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith("sigma-web-session=")));
  assert.ok(!JSON.stringify(await response.json()).includes("refreshed"));
});
test("preserves compressed upstream responses and lets the runtime determine their length", async () => {
  const cookie = await login(), payload = JSON.stringify({ revision: 1, nodes: [], tombstones: [] });
  const bytes = gzipSync(payload);
  const response = await handleRequest(request("/api/collaboration/catalog/delta", { method: "POST", body: "{}", headers: { Cookie: cookie } }), env,
    async () => new Response(bytes, { headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(bytes.length) } }));
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), payload);
});
test("uses the existing collaboration Worker binding with the signed-in user's token", async () => {
  const cookie = await login();
  let calls = 0;
  const response = await handleRequest(request("/api/collaboration/catalog/delta", { method: "POST", body: "{}", headers: { Cookie: cookie } }), {
    ...env, COLLABORATION: { async fetch(url, options) {
      calls++;
      assert.equal(url, `${env.SIGMA_COLLABORATION_URL}/catalog/delta`);
      assert.equal(options.headers.get("Authorization"), `Bearer ${tokens.access_token}`);
      return Response.json({ revision: 1, nodes: [], tombstones: [] });
    } },
  }, async () => { throw new Error("Public Worker URL must not be fetched"); });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
});
