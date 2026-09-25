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

import { registerWorkspacePreviewIpc } from "./workspace-preview";
import { writeWorkspacePreviewPng } from "../workspace-preview-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("workspace-preview ipc", () => {
  let userDataPath = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-preview-ipc-"));
    registerWorkspacePreviewIpc({ userDataPath });
  });

  it("persists shared previews across registration, invalidates versions and isolates accounts and revocation", async () => {
    let context: { scope: string; token: string; opened: boolean } | null = { scope: "account-a-document", token: "a:v1", opened: false };
    const deps = { userDataPath, sharedContext: async () => context, loadSharedDocument: vi.fn().mockRejectedValue(new Error("HTTP_403")) };
    registerWorkspacePreviewIpc(deps);
    const frame = {}; const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const put = () => mocks.handlers.get("workspace-preview:shared-put")!;
    const get = () => mocks.handlers.get("workspace-preview:shared-get")!;
    expect(await put()(event, { fileId: "file", token: "a:v1", dataUrl: PNG_DATA_URL })).toEqual({ ok: true });
    registerWorkspacePreviewIpc(deps);
    expect(await get()(event, "file")).toMatchObject({ dataUrl: PNG_DATA_URL, token: "a:v1", opened: false });
    await expect(mocks.handlers.get("workspace-preview:shared-document")!(event, "file")).rejects.toThrow("HTTP_403");
    expect(await get()(event, "file")).toMatchObject({ dataUrl: null });
    await put()(event, { fileId: "file", token: "a:v1", dataUrl: PNG_DATA_URL });
    context = { ...context!, token: "a:v2", opened: true };
    expect(await get()(event, "file")).toMatchObject({ dataUrl: null, updatedAt: 0, opened: true });
    expect(await put()(event, { fileId: "file", token: "a:v1", dataUrl: PNG_DATA_URL })).toEqual({ ok: false });
    context = { scope: "account-b-document", token: "b:v1", opened: false };
    expect(await get()(event, "file")).toMatchObject({ dataUrl: null });
    context = null;
    expect(await get()(event, "file")).toBeNull();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  it("returns a cached PNG and rejects malformed puts", async () => {
    await writeWorkspacePreviewPng(userDataPath, "file_a", 4, PNG_DATA_URL);
    const get = mocks.handlers.get("workspace-preview:get");
    const put = mocks.handlers.get("workspace-preview:put");
    expect(get).toBeDefined();
    expect(put).toBeDefined();

    await expect(get?.(null, { fileId: "file_a", revision: 4 })).resolves.toBe(PNG_DATA_URL);
    await expect(get?.(null, { fileId: "file_a", revision: 5 })).resolves.toBeNull();
    await expect(put?.(null, { fileId: "file_a", revision: 5, dataUrl: "not-a-png" }))
      .resolves.toEqual({ ok: false });
    await expect(put?.(null, { fileId: "file_a", revision: 5, dataUrl: PNG_DATA_URL }))
      .resolves.toEqual({ ok: true });
    await expect(get?.(null, { fileId: "file_a", revision: 5 })).resolves.toBe(PNG_DATA_URL);

    await fs.rm(userDataPath, { recursive: true, force: true });
  });
});
