import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { registerPluginIpc } from "./plugins";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), pick: vi.fn(), open: vi.fn(), send: vi.fn(), quit: [] as Array<() => void> }));
vi.mock("electron", () => ({
  app: { once: (_event: string, fn: () => void) => mocks.quit.push(fn) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, mainFrame: {}, send: mocks.send } }] },
  dialog: { showOpenDialog: mocks.pick }, shell: { openPath: mocks.open },
}));
vi.mock("../trusted-ipc", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  isTrustedMainSender: () => true,
}));
afterEach(() => { for (const quit of mocks.quit.splice(0)) quit(); vi.clearAllMocks(); mocks.handlers.clear(); });
function setup() {
  const manager = Object.assign(new EventEmitter(), { menuGroups: () => [], currentActor: () => "actor", refreshAutomatically: vi.fn(), refreshAccess: vi.fn(async () => {}) });
  const runItem = vi.fn(); const folderResultPath = vi.fn();
  registerPluginIpc({ host: { manager, ready: Promise.resolve(), runItem, folderResultPath } as never, getMainWindow: () => null });
  return { runItem, folderResultPath };
}

it("accepts only ids from renderer and obtains both paths from OS directory pickers", async () => {
  const { runItem } = setup();
  mocks.pick.mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/input"] }).mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen/output"] });
  runItem.mockImplementation(async (_id, _item, _file, folder, progress) => {
    expect(await folder()).toEqual({ inputDirectory: "/chosen/input", outputParent: "/chosen/output" });
    progress({ phase: "scanning", counts: { success: 0, skipped: 0, failed: 0 }, completed: 0, total: 0 });
    return { ok: false, error: "canceled" };
  });
  await mocks.handlers.get("extensions:run")!({}, "tool", "folder", { inputDirectory: "/forged", outputParent: "/forged" });
  expect(runItem.mock.calls[0].slice(0, 2)).toEqual(["tool", "folder"]);
  expect(runItem.mock.calls[0]).toHaveLength(5);
  expect(mocks.pick.mock.calls.map(call => call[0].properties)).toEqual([["openDirectory"], ["openDirectory"]]);
  expect(mocks.send).toHaveBeenCalledWith("extensions:folder-progress", expect.objectContaining({ phase: "scanning" }));
});

it.each([1, 2])("cancels directory selection at dialog %s without supplying any paths", async count => {
  const { runItem } = setup();
  if (count === 2) mocks.pick.mockResolvedValueOnce({ canceled: false, filePaths: ["/input"] });
  mocks.pick.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  runItem.mockImplementation(async (_id, _item, _file, folder) => { expect(await folder()).toBeNull(); });
  await mocks.handlers.get("extensions:run")!({}, "tool", "folder");
  expect(mocks.pick).toHaveBeenCalledTimes(count);
});

it("opens only host-resolved destinations and rejects forged jobs", async () => {
  const { folderResultPath } = setup();
  folderResultPath.mockResolvedValueOnce(null).mockResolvedValueOnce("/chosen/output/conversion-report.json");
  mocks.open.mockResolvedValue("");
  expect(await mocks.handlers.get("extensions:open-folder-result")!({}, "forged", "/arbitrary")).toBe(false);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(await mocks.handlers.get("extensions:open-folder-result")!({}, "job", "report")).toBe(true);
  expect(mocks.open).toHaveBeenCalledWith("/chosen/output/conversion-report.json");
});
