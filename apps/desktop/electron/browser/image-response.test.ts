import { describe, expect, it, vi } from "vitest";
import { readImageDataUrl } from "./image-response";

describe("browser icon response", () => {
  it("returns small images and accepts exactly the byte limit", async () => {
    expect(await readImageDataUrl(new Response("icon", { headers: { "content-type": "image/png; charset=binary" } })))
      .toBe("data:image/png;base64,aWNvbg==");
    const bytes = new Uint8Array(128 * 1024);
    expect(await readImageDataUrl(new Response(bytes, { headers: { "content-type": "image/png" } })))
      .toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it.each<Record<string, string>>([{}, { "content-length": "1" }])("cancels oversized streamed images even with missing or false lengths: %j", async headers => {
    const cancel = vi.fn();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel,
    }, { highWaterMark: 0 });
    expect(await readImageDataUrl(new Response(body, { headers: { "content-type": "image/png", ...headers } }))).toBeNull();
    expect(reads).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each<Record<string, string>>([
    { "content-type": "image/png", "content-length": "131073" },
    { "content-type": "text/html" },
  ])("cancels rejected responses without reading: %j", async headers => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    expect(await readImageDataUrl(new Response(body, { headers }))).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects failed and empty responses", async () => {
    expect(await readImageDataUrl(new Response("error", { status: 404, headers: { "content-type": "image/png" } }))).toBeNull();
    expect(await readImageDataUrl(new Response(null, { headers: { "content-type": "image/png" } }))).toBeNull();
  });
});
