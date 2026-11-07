import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

import { registerWorkspacePreviewIpc, removeRetiredWorkspacePreviewCaches } from "./workspace-preview";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("workspace-preview ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
  });

  it("registers only the read-only shared document reader", () => {
    registerWorkspacePreviewIpc({});
    expect([...mocks.handlers.keys()]).toEqual(["workspace-preview:shared-document"]);
  });

  it("passes only the text-only option to the shared document loader", async () => {
    const loadSharedDocument = vi.fn().mockResolvedValue(null);
    registerWorkspacePreviewIpc({ loadSharedDocument });
    const frame = {}; const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const load = mocks.handlers.get("workspace-preview:shared-document")!;
    await load(event, "file");
    expect(loadSharedDocument).toHaveBeenLastCalledWith("file");
    await load(event, "file", { assets: false });
    expect(loadSharedDocument).toHaveBeenLastCalledWith("file", { assets: false });
    await load(event, "file", { assets: "no", extra: true });
    expect(loadSharedDocument).toHaveBeenLastCalledWith("file");
    await load(event, "file", "assets");
    expect(loadSharedDocument).toHaveBeenLastCalledWith("file");
  });

  it("rejects subframes and malformed ids, and passes loader failures through", async () => {
    const loadSharedDocument = vi.fn().mockRejectedValue(new Error("HTTP_403"));
    registerWorkspacePreviewIpc({ loadSharedDocument });
    const frame = {}; const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const load = mocks.handlers.get("workspace-preview:shared-document")!;
    await expect(load({ senderFrame: {}, sender: { mainFrame: frame } }, "file")).resolves.toBeNull();
    await expect(load(event, "../file")).resolves.toBeNull();
    expect(loadSharedDocument).not.toHaveBeenCalled();
    await expect(load(event, "file")).rejects.toThrow("HTTP_403");
  });

  it("removes the thumbnail images left by earlier versions and leaves other data alone", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-preview-cleanup-"));
    try {
      await fs.mkdir(path.join(userDataPath, "workspace-previews"), { recursive: true });
      await fs.writeFile(path.join(userDataPath, "workspace-previews", "file_a.3.png"), "png");
      await fs.mkdir(path.join(userDataPath, "shared-workspace-previews"), { recursive: true });
      await fs.writeFile(path.join(userDataPath, "shared-workspace-previews", "scope.json"), "{}");
      await fs.mkdir(path.join(userDataPath, "workspace-search-index"), { recursive: true });

      await removeRetiredWorkspacePreviewCaches(userDataPath);
      // A second run (nothing left to remove) must not throw either.
      await removeRetiredWorkspacePreviewCaches(userDataPath);

      expect((await fs.readdir(userDataPath)).sort()).toEqual(["workspace-search-index"]);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});

// These tests isolate handler behavior; sender authorization is tested in trusted-ipc.test.ts.
vi.mock("../trusted-ipc", async () => ({ ipcMain: (await import("electron")).ipcMain }));
