import { beforeEach, expect, it, vi } from "vitest";
import { LinkConfirmation } from "../link-confirmation";

const { handlers, openExternal } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, url: string) => Promise<{ ok: boolean }>>(),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({ shell: { openExternal } }));
vi.mock("../trusted-ipc", () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, url: string) => Promise<{ ok: boolean }>) => handlers.set(channel, handler) } }));
import { registerShellIpc } from "./shell";

beforeEach(() => { handlers.clear(); openExternal.mockClear(); });

it("does not open an external application until the exact destination is approved", async () => {
  const gate = new LinkConfirmation(vi.fn());
  registerShellIpc({ confirm: url => gate.confirm(url, "external") });
  const invoke = handlers.get("shell:open-external")!;
  const cancelled = invoke({}, "https://example.test/cancel");
  expect(openExternal).not.toHaveBeenCalled();
  gate.cancel();
  expect(await cancelled).toEqual({ ok: false });
  expect(openExternal).not.toHaveBeenCalled();
  const approved = invoke({}, "https://example.test/approved");
  expect(gate.pending()?.url).toBe("https://example.test/approved");
  gate.respond(gate.pending()!.id, true);
  expect(await approved).toEqual({ ok: true });
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.test/approved");
});

it.each(["javascript:alert(1)", "file:///private", "data:text/html,unsafe"])("never offers unsupported destinations: %s", async url => {
  const gate = new LinkConfirmation(vi.fn());
  registerShellIpc({ confirm: value => gate.confirm(value, "external") });
  expect((await handlers.get("shell:open-external")!({}, url)).ok).toBe(false);
  expect(gate.pending()).toBeNull();
  expect(openExternal).not.toHaveBeenCalled();
});
