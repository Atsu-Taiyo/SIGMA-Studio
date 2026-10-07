import { describe, expect, it, vi } from "vitest";
import { inspectLink } from "@/lib/link-confirmation";
import { LinkConfirmation } from "./link-confirmation";

describe("link confirmation", () => {
  it("requires an explicit reply for the exact request and never replaces its destination", async () => {
    const changed = vi.fn();
    const gate = new LinkConfirmation(changed);
    const first = gate.confirm("https://example.test/first", "browser");
    const request = gate.pending()!;
    gate.respond("wrong-id", true);
    expect(gate.pending()).toEqual(request);
    expect(await gate.confirm("https://example.test/replacement", "browser")).toBe(false);
    expect(gate.pending()?.url).toBe("https://example.test/first");
    gate.respond(request.id, true);
    expect(await first).toBe(true);
    expect(gate.pending()).toBeNull();
    const next = gate.confirm("https://example.test/next", "browser");
    gate.respond(request.id, true);
    gate.cancel();
    expect(await next).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("fails closed on cancellation, renderer reload and destroyed browser tabs", async () => {
    const gate = new LinkConfirmation(vi.fn());
    const controller = new AbortController();
    const pending = gate.confirm("https://example.test/", "browser", controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(gate.pending()).toBeNull();
    expect(await gate.confirm("https://example.test/", "browser", controller.signal)).toBe(false);
    const reload = gate.confirm("https://example.test/", "external");
    gate.cancel();
    expect(await reload).toBe(false);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,unsafe", "sigma-doc-storage://private", "not a url"])("rejects unsupported destinations: %s", async url => {
    const gate = new LinkConfirmation(vi.fn());
    expect(await gate.confirm(url, "browser")).toBe(false);
    expect(gate.pending()).toBeNull();
  });

  it("shows the actual host, redacts credentials and highlights suspicious URL features", () => {
    expect(inspectLink("http://trusted.test:secret@127.0.0.1/path", "browser")).toEqual({
      url: "http://127.0.0.1/path", host: "127.0.0.1", destination: "browser", warnings: ["unencrypted", "credentials", "address"],
    });
    const international = inspectLink("https://例え.jp/path", "browser")!;
    expect(international.host).toMatch(/^xn--/);
    expect(international.warnings).toEqual(["international"]);
    expect(inspectLink("https://safe.example/path", "browser")?.warnings).toEqual([]);
    expect(inspectLink("mailto:hello@example.test", "browser")).toBeNull();
    expect(inspectLink("mailto:hello@example.test", "external")).not.toBeNull();
  });
});
