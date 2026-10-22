// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PersistentWorkspace } from "./persistent-workspace";

function editors() {
  const workspace = new PersistentWorkspace();
  const a = workspace.addPane("a");
  const b = workspace.addPane("b");
  a.ready = b.ready = true;
  return { workspace, a, b };
}
describe("mounted workspace document lifecycle", () => {
  it("reserves a pending pane for its file while its shell is still booting", () => {
    const { workspace, b } = editors();
    b.ready = false;
    workspace.report(b, "temporary-draft", false);
    expect(b.fileId).toBe("b");
    expect(workspace.panes.filter(pane => pane.fileId === "b")).toHaveLength(1);
  });
  it("flushes an unfocused document before permitting window close", async () => {
    const { workspace, a, b } = editors();
    b.save = vi.fn(async () => ({ ok: false, error: "disk-full" }));
    b.dirty = () => true;
    expect(await workspace.saveOthers(a.id, "app-close")).toEqual({ ok: false, error: "disk-full" });
    expect(b.save).toHaveBeenCalledWith("app-close");
  });
  it("preserves a dirty pane whose boundary save was skipped", async () => {
    const { workspace, a, b } = editors();
    b.save = async () => ({ ok: true, skipped: true, skippedReason: "ai-write-in-progress" });
    b.dirty = () => true;
    expect(await workspace.saveOthers(a.id, "app-close")).toMatchObject({ skipped: true });
    await workspace.release(b, () => true);
    expect(workspace.panes).toContain(b);
  });
  it("releases a hidden document only after a successful save and a second visibility check", async () => {
    const { workspace, b } = editors();
    let finish!: () => void;
    b.save = () => new Promise(resolve => { finish = () => resolve({ ok: true }); });
    let hidden = true;
    const releasing = workspace.release(b, () => hidden);
    expect(workspace.panes).toContain(b);
    hidden = false;
    finish();
    await releasing;
    expect(workspace.panes).toContain(b);
    const next = workspace.release(b, () => true);
    finish();
    await next;
    expect(workspace.panes).not.toContain(b);
  });
});
