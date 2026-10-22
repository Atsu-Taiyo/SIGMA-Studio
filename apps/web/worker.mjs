const SESSION = "sigma-web-session";
const LOGIN = "sigma-web-login";
const encoder = new TextEncoder();

function origin(value, development = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(development && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("INVALID_CONFIGURATION");
  return url.origin;
}
function config(env) {
  const site = origin(env.APP_ORIGIN, env.ALLOW_LOCAL_AUTH === "true");
  if (typeof env.SESSION_SECRET !== "string" || encoder.encode(env.SESSION_SECRET).length < 32) throw new Error("INVALID_CONFIGURATION");
  const key = env.SIGMA_SUPABASE_ANON_KEY;
  let publishable = typeof key === "string" && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publishable) {
    try { publishable = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "anon"; } catch { /* Fail closed on server keys. */ }
  }
  if (!publishable) throw new Error("INVALID_CONFIGURATION");
  return { site, api: origin(env.SIGMA_COLLABORATION_URL, env.ALLOW_LOCAL_AUTH === "true"), auth: origin(env.SIGMA_SUPABASE_URL, env.ALLOW_LOCAL_AUTH === "true"), key };
}
function base64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64(value) { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0)); }
async function cipher(secret) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`${env.APP_ORIGIN}/${purpose}`) }, await cipher(env.SESSION_SECRET), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
async function unseal(value, env, purpose) {
  try {
    if (!value || value.length > 12_000) return null;
    const [iv, data] = value.split(".");
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: encoder.encode(`${env.APP_ORIGIN}/${purpose}`) }, await cipher(env.SESSION_SECRET), unbase64(data))));
  } catch { return null; }
}
function cookie(request, name) {
  return request.headers.get("Cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
function setCookie(name, value, seconds, env) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${env.APP_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
}
function json(value, status = 200, cookies = []) {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(JSON.stringify(value), { status, headers });
}
async function boundedFetch(fetcher, url, options, consume = response => response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try { return await consume(await fetcher(url, { ...options, signal: controller.signal })); }
  finally { clearTimeout(timer); }
}
async function authRequest(settings, route, body, fetcher) {
  const result = await boundedFetch(fetcher, `${settings.auth}/auth/v1${route}`, {
    method: "POST", redirect: "manual", headers: { apikey: settings.key, "content-type": "application/json" }, body: JSON.stringify(body),
  }, async response => {
    if (!response.ok) { await response.body?.cancel(); throw new Error("AUTH_FAILED"); }
    return response.json();
  });
  if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string" || typeof result.user?.id !== "string" || !Number.isFinite(result.expires_in)) throw new Error("AUTH_FAILED");
  return { access: result.access_token, refresh: result.refresh_token, expires: Date.now() + result.expires_in * 1000,
    until: Date.now() + 30 * 86400_000, user: { actorId: result.user.id, email: result.user.email,
      displayName: result.user.user_metadata?.full_name || result.user.user_metadata?.name } };
}

/** Only the existing shared-document API is exposed. No share creation, billing or local library uploads. */
function permitted(path, method) {
  const id = "[a-fA-F0-9-]{36}";
  if (method === "GET") return path === "/catalog/capabilities" || path === "/documents"
    || new RegExp(`^/documents/${id}/(snapshot|socket|members|backups|backups/${id}|assets/${id})$`).test(path);
  if (method === "POST") return path === "/catalog/delta" || path === "/catalog/invitations/accept" || path === "/invitations/accept"
    || new RegExp(`^/documents/${id}/(sync|updates|presence)$`).test(path);
  return method === "PUT" && new RegExp(`^/documents/${id}/assets/${id}$`).test(path);
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const api = url.pathname.startsWith("/api/");
  const callback = url.pathname === "/auth/callback/web";
  if (!api && !callback) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    return new Response(response.body, { status: response.status, headers });
  }
  let settings;
  try { settings = config(env); } catch { return json({ error: "WEB_NOT_CONFIGURED" }, 503); }
  if (url.origin !== settings.site) return json({ error: "INVALID_ORIGIN" }, 403);
  if ((request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() === "websocket")
    && request.headers.get("Origin") !== settings.site) return json({ error: "INVALID_ORIGIN" }, 403);
  try {
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      const verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
      const state = base64(crypto.getRandomValues(new Uint8Array(24)));
      const redirect = new URL("/auth/callback/web", settings.site);
      redirect.searchParams.set("state", state);
      const authorization = new URL("/auth/v1/authorize", settings.auth);
      authorization.search = new URLSearchParams({ provider: "google", redirect_to: redirect.href,
        code_challenge: base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)))), code_challenge_method: "s256", prompt: "select_account" }).toString();
      return json({ url: authorization.href }, 200, [setCookie(LOGIN, await seal({ verifier, state, until: Date.now() + 180_000 }, env, LOGIN), 180, env)]);
    }
    if (callback) {
      const login = await unseal(cookie(request, LOGIN), env, LOGIN);
      if (!login || login.until < Date.now() || login.state !== url.searchParams.get("state") || !url.searchParams.get("code"))
        return json({ error: "AUTH_CALLBACK_INVALID" }, 400, [setCookie(LOGIN, "", 0, env)]);
      const session = await authRequest(settings, "/token?grant_type=pkce", { auth_code: url.searchParams.get("code"), code_verifier: login.verifier }, fetcher);
      const headers = new Headers({ Location: `${settings.site}/workspace`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      headers.append("Set-Cookie", setCookie(SESSION, await seal(session, env, SESSION), 30 * 86400, env));
      headers.append("Set-Cookie", setCookie(LOGIN, "", 0, env));
      return new Response(null, { status: 303, headers });
    }
    let session = await unseal(cookie(request, SESSION), env, SESSION);
    const cookies = [];
    if (session?.until < Date.now() || !session?.user?.actorId || typeof session.access !== "string" || typeof session.refresh !== "string") session = null;
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      if (session) await boundedFetch(fetcher, `${settings.auth}/auth/v1/logout?scope=local`, {
        method: "POST", redirect: "manual", headers: { apikey: settings.key, Authorization: `Bearer ${session.access}` },
      }, response => response.body?.cancel()).catch(() => {});
      return json({ ok: true }, 200, [setCookie(SESSION, "", 0, env), setCookie(LOGIN, "", 0, env)]);
    }
    if (!session) return json({ error: "AUTH_REQUIRED" }, 401);
    if (session.expires <= Date.now() + 60_000) {
      session = await authRequest(settings, "/token?grant_type=refresh_token", { refresh_token: session.refresh }, fetcher);
      cookies.push(setCookie(SESSION, await seal(session, env, SESSION), 30 * 86400, env));
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") return json({ user: session.user }, 200, cookies);
    const prefix = "/api/collaboration";
    const path = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(`${prefix}/`) || url.search || !permitted(path, request.method)) return json({ error: "NOT_FOUND" }, 404);
    const headers = new Headers({ Authorization: `Bearer ${session.access}` });
    const websocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (websocket) headers.set("Upgrade", "websocket");
    if (request.headers.has("Content-Type")) headers.set("Content-Type", request.headers.get("Content-Type"));
    // Workers on the same workers.dev zone must communicate through a Service
    // Binding. Local previews retain the injectable HTTP transport.
    const collaborationFetch = env.COLLABORATION?.fetch ? env.COLLABORATION.fetch.bind(env.COLLABORATION) : fetcher;
    const response = await boundedFetch(collaborationFetch, `${settings.api}${path}`, { method: request.method, headers, body: request.body, duplex: "half", redirect: "manual" });
    if (response.status === 101) {
      if (!cookies.length) return response;
      const headers = new Headers(response.headers);
      cookies.forEach(value => headers.append("Set-Cookie", value));
      return new Response(null, { status: 101, headers, webSocket: response.webSocket });
    }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return json({ error: "UPSTREAM_REDIRECT" }, 502); }
    const resultHeaders = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "x-sigma-actor": session.user.actorId });
    // fetch can forward an encoded upstream body. Preserve its coding; a copied
    // Content-Length could become stale when Cloudflare changes the encoding.
    for (const name of ["content-type", "content-encoding", "retry-after"]) if (response.headers.has(name)) resultHeaders.set(name, response.headers.get(name));
    cookies.forEach(value => resultHeaders.append("Set-Cookie", value));
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  } catch (error) {
    // Never return upstream bodies, credentials, callback URLs or exception details.
    return json({ error: error instanceof Error && error.message === "AUTH_FAILED" ? "AUTH_FAILED" : "WEB_REQUEST_FAILED" }, error instanceof Error && error.message === "AUTH_FAILED" ? 401 : 502);
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
