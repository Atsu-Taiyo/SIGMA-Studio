import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `codex:*` だけは共通の `registerCliBinIpc` を使っていない (`cli-bin-ipc.ts` の冒頭コメント参照)。
 * 共通側だけ検証を入れると **codex 経路にだけ穴が残る** ので、ここを独立に固定する。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  writeDesktopSettings: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/home/test" },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../desktop-settings", () => ({ writeDesktopSettings: mocks.writeDesktopSettings }));

const { registerCodexIpc } = await import("./codex");

const workDir = mkdtempSync(path.join(tmpdir(), "codex-set-bin-test-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function writeBin(name: string, mode: number): string {
  const filePath = path.join(workDir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  chmodSync(filePath, mode);
  return filePath;
}

const setCodexBin = vi.fn();

function register() {
  mocks.handlers.clear();
  const codexClient = {
    getStatus: async () => ({ available: true }),
    listModels: async () => [],
    setCodexBin,
    getConfiguredCodexBin: () => null,
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
  };
  const stubCliClient = {
    getStatus: async () => ({ available: true }),
    setBin: vi.fn(),
    getConfiguredBin: () => null,
    setClaudeBin: vi.fn(),
    getConfiguredClaudeBin: () => null,
    setGeminiBin: vi.fn(),
    getConfiguredGeminiBin: () => null,
  };
  registerCodexIpc({
    dataDir: workDir,
    codexAppServerClient: codexClient as never,
    claudeStreamClient: stubCliClient as never,
    geminiHeadlessClient: stubCliClient as never,
    getMainWindow: () => null,
    openExternalUrl: vi.fn(),
  });
}

async function invokeSetBin(value: unknown): Promise<Record<string, unknown>> {
  return await mocks.handlers.get("codex:set-bin")!({}, value) as Record<string, unknown>;
}

beforeEach(() => {
  setCodexBin.mockClear();
  mocks.writeDesktopSettings.mockClear();
  mocks.showOpenDialog.mockReset();
  register();
});

describe("codex:set-bin input validation", () => {
  it("refuses a command string without touching the client or the settings file", async () => {
    await expect(invokeSetBin("cmd /c calc &")).rejects.toThrow();

    expect(setCodexBin).not.toHaveBeenCalled();
    expect(mocks.writeDesktopSettings).not.toHaveBeenCalled();
  });

  it("refuses relative paths and non-executable files", async () => {
    for (const value of ["codex", writeBin("codex-not-executable", 0o644)]) {
      setCodexBin.mockClear();
      mocks.writeDesktopSettings.mockClear();
      await expect(invokeSetBin(value), value).rejects.toThrow();

      expect(setCodexBin, value).not.toHaveBeenCalled();
      expect(mocks.writeDesktopSettings, value).not.toHaveBeenCalled();
    }
  });

  it("accepts an absolute path to an executable file", async () => {
    const usable = writeBin("codex-usable", 0o755);
    const status = await invokeSetBin(usable);

    expect(setCodexBin).toHaveBeenCalledWith(usable);
    expect(mocks.writeDesktopSettings).toHaveBeenCalledWith(workDir, { codexBin: usable });
    expect(status.error).toBeUndefined();
  });

  it("clears the setting for null, which is what the settings UI actually sends", async () => {
    const status = await invokeSetBin(null);

    expect(setCodexBin).toHaveBeenCalledWith(null);
    expect(mocks.writeDesktopSettings).toHaveBeenCalledWith(workDir, { codexBin: "" });
    expect(status.error).toBeUndefined();
  });

  it("still clears the setting for an empty string", async () => {
    const status = await invokeSetBin("");

    expect(setCodexBin).toHaveBeenCalledWith(null);
    expect(mocks.writeDesktopSettings).toHaveBeenCalledWith(workDir, { codexBin: "" });
    expect(status.error).toBeUndefined();
  });

  it("reports the reason instead of accepting a picked file that cannot run", async () => {
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [writeBin("codex-picked-not-executable", 0o644)],
    });

    await expect(mocks.handlers.get("codex:select-bin")!({})).rejects.toThrow();

    expect(setCodexBin).not.toHaveBeenCalled();
  });
});
