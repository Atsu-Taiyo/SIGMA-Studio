import { expect, it, vi } from "vitest";
import { startDshGatewaySession } from "./dsh-gateway-session";

it("forwards an image request with main's credential and stops forwarding after an account change", async () => {
  const account = new AbortController();
  const authorization = vi.fn(async () => "Bearer fixture-account-credential");
  const body = JSON.stringify({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
  ] }] });
  const upstream = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://gateway.example.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-account-credential");
    expect(await new Response(init?.body).text()).toBe(body);
    expect(init?.redirect).toBe("error");
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const session = await startDshGatewaySession("https://gateway.example.test/v1", {
    authorization, accountSignal: () => account.signal,
  }, upstream);
  try {
    const send = (path: string, token?: string) => fetch(session.url + path, {
      method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await send("/chat/completions")).status).toBe(401);
    expect((await send("/anything", session.token)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    const success = await send("/chat/completions", session.token);
    expect(success.headers.get("content-type")).toBe("text/event-stream");
    expect(await success.text()).toBe("data: [DONE]\n\n");
    expect(authorization).toHaveBeenCalledTimes(1);
    account.abort();
    expect((await send("/chat/completions", session.token)).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
  } finally {
    session.close();
  }
});
