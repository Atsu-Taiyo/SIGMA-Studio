import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DshGatewayAccount {
  authorization(): Promise<string>;
  accountSignal(): AbortSignal;
}

/** Keep the SIGMA account credential in Electron main. DSH receives only a key for this local turn. */
export async function startDshGatewaySession(
  upstream: string,
  account: DshGatewayAccount,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const accountSignal = account.accountSignal();
  const lifetime = new AbortController();
  const server = createServer(async (request, response) => {
    const presented = Buffer.from(request.headers.authorization ?? "");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      response.writeHead(401).end();
      return;
    }
    const chat = request.method === "POST" && request.url === "/v1/chat/completions";
    if (!chat && !(request.method === "GET" && request.url === "/v1/models")) {
      response.writeHead(404).end();
      return;
    }
    const connection = new AbortController();
    response.once("close", () => connection.abort());
    const signal = AbortSignal.any([lifetime.signal, accountSignal, connection.signal]);
    try {
      signal.throwIfAborted();
      const authorization = await account.authorization();
      signal.throwIfAborted();
      const result = await fetcher(`${upstream}/${chat ? "chat/completions" : "models"}`, {
        method: request.method,
        headers: { authorization, ...(chat ? { "content-type": "application/json" } : {}) },
        ...(chat ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
        redirect: "error",
        signal,
      });
      const type = result.headers.get("content-type") ?? "application/json";
      const retryAfter = result.headers.get("retry-after");
      response.writeHead(result.status, { "content-type": type, "cache-control": "no-store", ...(retryAfter ? { "retry-after": retryAfter } : {}) });
      if (result.body) await pipeline(Readable.from(result.body as unknown as AsyncIterable<Uint8Array>), response, { signal });
      else response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(accountSignal.aborted ? 401 : 502).end();
    }
  });
  const close = () => {
    lifetime.abort();
    server.close();
    server.closeAllConnections();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    close();
    throw new Error("The local SIGMA AI gateway could not start.");
  }
  return { url: `http://127.0.0.1:${address.port}/v1`, token, close };
}
