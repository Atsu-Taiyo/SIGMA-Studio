import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openExternal: vi.fn() },
}));

const { registerCliBinIpc } = await import("./cli-bin-ipc");

const workDir = mkdtempSync(path.join(tmpdir(), "cli-bin-ipc-test-"));

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function writeBin(name: string, mode: number): string {
  const filePath = path.join(workDir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  chmodSync(filePath, mode);
  return filePath;
}

const setBin = vi.fn();
const persistBin = vi.fn(async () => {});

function register() {
  mocks.handlers.clear();
  registerCliBinIpc({
    prefix: "gemini",
    client: {
      getStatus: async () => ({ available: true }),
      setBin,
      getConfiguredBin: () => null,
    },
    persistBin,
    dialogTitle: "CLIを選択",
    filterName: "CLI",
    getSuggestedBinPath: () => "/usr/local/bin/agy",
    installPageUrl: "https://example.com",
    installPageErrorFallback: "失敗",
    getMainWindow: () => null,
  });
}

async function invokeSetBin(value: unknown): Promise<Record<string, unknown>> {
  const handler = mocks.handlers.get("gemini:set-bin");
  if (!handler) {
    throw new Error("gemini:set-bin was not registered");
  }
  return await handler({}, value) as Record<string, unknown>;
}

beforeEach(() => {
  setBin.mockClear();
  persistBin.mockClear();
  mocks.showOpenDialog.mockReset();
  register();
});

describe("set-bin input validation", () => {
  it("refuses a command string without touching the client or the settings file", async () => {
    // これが XSS→RCE の橋渡しそのもの。レンダラで任意 JS が動けば `desktopAPI` からこの
    // チャンネルを呼べ、渡した文字列がそのまま spawn のコマンド名になる。
    await expect(invokeSetBin("cmd /c calc &")).rejects.toThrow();

    expect(setBin).not.toHaveBeenCalled();
    expect(persistBin).not.toHaveBeenCalled();
  });

  it("refuses relative paths, directories, missing paths, and non-executable files", async () => {
    for (const value of [
      "agy",
      "../../../usr/bin/env",
      workDir,
      path.join(workDir, "missing"),
      writeBin("not-executable", 0o644),
    ]) {
      setBin.mockClear();
      persistBin.mockClear();
      await expect(invokeSetBin(value), String(value)).rejects.toThrow();

      expect(setBin, String(value)).not.toHaveBeenCalled();
      expect(persistBin, String(value)).not.toHaveBeenCalled();
    }
  });

  it("refuses a non-string payload", async () => {
    await expect(invokeSetBin({ toString: () => "/bin/sh" })).rejects.toThrow();

    expect(setBin).not.toHaveBeenCalled();
  });

  it("accepts an absolute path to an executable file", async () => {
    const usable = writeBin("usable", 0o755);
    const status = await invokeSetBin(usable);

    expect(setBin).toHaveBeenCalledWith(usable);
    expect(persistBin).toHaveBeenCalledWith(usable);
    expect(status.error).toBeUndefined();
  });

  it("still clears the setting for an empty string", async () => {
    // 空文字は「未設定へ戻す」意図。ここを拒否すると設定解除ができなくなる。
    const status = await invokeSetBin("   ");

    expect(setBin).toHaveBeenCalledWith(null);
    expect(persistBin).toHaveBeenCalledWith("");
    expect(status.error).toBeUndefined();
  });

  it("clears the setting for null, which is what the settings UI actually sends", async () => {
    // `DesktopSettingsModal` は `draft.trim() || null` を渡す。ここを拒否すると
    // 「自動検出に戻す」が 3 プロバイダとも動かなくなる。
    const status = await invokeSetBin(null);

    expect(setBin).toHaveBeenCalledWith(null);
    expect(persistBin).toHaveBeenCalledWith("");
    expect(status.error).toBeUndefined();
  });
});

describe("select-bin input validation", () => {
  it("reports the reason instead of accepting a file the picker returned", async () => {
    // ピッカーの返り値は常に絶対パスだが、実行権限までは保証されない。
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [writeBin("picked-not-executable", 0o644)],
    });

    // status 無しの `{ canceled: false }` を返すとレンダラが `result.status.available` で落ちる。
    await expect(mocks.handlers.get("gemini:select-bin")!({})).rejects.toThrow();

    expect(setBin).not.toHaveBeenCalled();
    expect(persistBin).not.toHaveBeenCalled();
  });

  it("accepts an executable the picker returned", async () => {
    const usable = writeBin("picked-usable", 0o755);
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [usable] });

    const result = await mocks.handlers.get("gemini:select-bin")!({}) as Record<string, unknown>;

    expect(setBin).toHaveBeenCalledWith(usable);
    expect(result).toMatchObject({ canceled: false });
    expect(result.error).toBeUndefined();
  });
});
