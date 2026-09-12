import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 表示言語はレンダラの localStorage ではなく `settings.json` が正本 (main / MCP も読む)。
 * その往復を IPC の面で固定する。
 */

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

const { registerSettingsIpc } = await import("./settings");

const dataDir = mkdtempSync(path.join(tmpdir(), "settings-ui-locale-test-"));

afterAll(() => {
  rmSync(dataDir, { force: true, recursive: true });
});

const setUiLocale = vi.fn();

function register(): void {
  setUiLocale.mockClear();
  mocks.handlers.clear();
  registerSettingsIpc({
    dataDir,
    codexAppServerClient: { setWebSearchEnabled: vi.fn(), setUiLocale } as never,
    scheduleAutoApplyCheck: vi.fn(),
  });
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({} as never, ...args);
}

function readRawSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("settings:set-ui-locale", () => {
  beforeEach(() => {
    rmSync(path.join(dataDir, "settings.json"), { force: true });
    register();
  });

  it("registers the channel", () => {
    expect(mocks.handlers.has("settings:set-ui-locale")).toBe(true);
  });

  it("persists a supported locale and reports it back through settings:get", async () => {
    await expect(invoke("settings:set-ui-locale", "en")).resolves.toEqual({ ok: true });
    expect(await invoke("settings:get")).toMatchObject({ uiLocale: "en" });
  });

  it("keeps an explicit Japanese choice distinguishable from never having chosen", async () => {
    await invoke("settings:set-ui-locale", "en");
    await invoke("settings:set-ui-locale", "ja");
    expect(readRawSettings().uiLocale).toBe("ja");
    expect(await invoke("settings:get")).toMatchObject({ uiLocale: "ja" });
  });

  it("rejects an unsupported locale instead of writing it", async () => {
    await invoke("settings:set-ui-locale", "en");
    const result = await invoke("settings:set-ui-locale", "fr");
    expect(result).toEqual({ ok: false, error: "This display language is not supported." });
    expect(readRawSettings().uiLocale).toBe("en");
  });

  it("rejects a non-string payload", async () => {
    expect(await invoke("settings:set-ui-locale", { locale: "en" })).toMatchObject({ ok: false });
  });

  it("reports no locale when nothing is stored, so OS detection still wins", async () => {
    // 既定値に解決して返すと、初回起動が常に日本語で固定されてしまう。
    expect(await invoke("settings:get")).toMatchObject({ uiLocale: null });
  });

  /**
   * Codex の常駐 app-server は spawn 前の config.toml しか読まないので、ここで
   * 伝えないと MCP サーバー (別プロセス) だけ元の言語のまま残る。
   */
  it("tells the resident Codex client about the new language", async () => {
    register();
    await invoke("settings:set-ui-locale", "en");
    expect(setUiLocale).toHaveBeenCalledWith("en");
  });

  it("does not tell it about a rejected locale", async () => {
    register();
    await invoke("settings:set-ui-locale", "fr");
    expect(setUiLocale).not.toHaveBeenCalled();
  });
});
