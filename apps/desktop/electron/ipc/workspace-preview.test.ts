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
