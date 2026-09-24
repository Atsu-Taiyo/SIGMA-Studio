import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
const t = createCurrentLocaleTranslator("chrome");

/** A short-lived IPv4 loopback receiver. Neither tokens nor the verifier enter the browser. */
export async function googleAuthorization(
  authUrl: string,
  openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const callbackPath = `/auth/callback/${randomBytes(32).toString("base64url")}`;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let claimed = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler before opening the browser, which can itself take time.
  void code.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    const address = server.address();
    const host = typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method !== "GET" || request.headers.host !== host || url.pathname !== callbackPath || claimed) {
      response.writeHead(404).end();
      return;
    }
    const value = url.searchParams.get("code");
    if (url.searchParams.has("error")) {
      claimed = true;
      response.writeHead(400).end(t("collaboration.googleCallbackFailed"), () => rejectCode(new Error("AUTH_FAILED")));
    } else if (value && /^[A-Za-z0-9_-]{1,2048}$/.test(value) && url.searchParams.getAll("code").length === 1) {
      claimed = true;
      response.end(t("collaboration.googleCallbackReturn"), () => resolveCode(value));
    } else {
      response.writeHead(400).end();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  const cancel = () => rejectCode(new Error("AUTH_CANCELLED"));
  const timeout = setTimeout(() => rejectCode(new Error("AUTH_TIMEOUT")), 180_000);
  timeout.unref();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("AUTH_CANCELLED");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => rejectCode(new Error("AUTH_FAILED")));
    if (signal.aborted) throw new Error("AUTH_CANCELLED");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("AUTH_FAILED");
    const url = new URL(`${authUrl}/auth/v1/authorize`);
    url.search = new URLSearchParams({
      provider: "google",
      redirect_to: `http://127.0.0.1:${address.port}${callbackPath}`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "s256",
      prompt: "select_account",
    }).toString();
    await Promise.race([openBrowser(url.href), code.then(() => {})]);
    return { code: await code, verifier };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
