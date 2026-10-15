import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../trusted-ipc", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }, on: vi.fn() },
}));

import { writeDesktopSettings } from "../desktop-settings";
import { registerAppIpc } from "./app";

let dataDir: string;
const sender = { id: "main-window" };

function register(listSystemFonts?: Parameters<typeof registerAppIpc>[0]["listSystemFonts"]) {
  handlers.clear();
  registerAppIpc({
    getMainWindow: () => null, releaseUrl: "https://example.test/releases", dataDir,
    appUpdateController: {} as never, listSystemFonts,
  });
  return handlers.get("local-fonts:list") as (event: { sender: unknown }) => Promise<{ ok: boolean; systemFonts: unknown; fonts: Array<{ id: string; url: string }> }>;
}

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-local-fonts-ipc-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe("local-fonts:list", () => {
  it("returns the PC's face names together with the user's added fonts, each with a file URL", async () => {
    await writeDesktopSettings(dataDir, { customFonts: [{ id: "font_1", displayName: "My Font", fileName: "font_1-My.ttf", cssFamily: '"Sigma Custom Font font_1"', importedAt: "2026-10-01T00:00:00.000Z" }] });
    const faces = [{ family: "Example", fullName: "Example Regular", postscriptName: "Example-Regular", style: "Regular" }];
    const listSystemFonts = vi.fn(async () => faces);
    const result = await register(listSystemFonts)({ sender });
    expect(listSystemFonts).toHaveBeenCalledWith(sender);
    expect(result.ok).toBe(true);
    expect(result.systemFonts).toEqual(faces);
    expect(result.fonts).toHaveLength(1);
    expect(result.fonts[0].url).toMatch(/^file:\/\/.*font_1-My\.ttf$/);
  });

  it("says the PC's fonts are unknown (null) when they cannot be read, and still returns the added fonts", async () => {
    await writeDesktopSettings(dataDir, { customFonts: [{ id: "font_1", displayName: "My Font", fileName: "font_1-My.ttf", cssFamily: '"x"', importedAt: "2026-10-01T00:00:00.000Z" }] });
    for (const listSystemFonts of [undefined, async () => null]) {
      const result = await register(listSystemFonts)({ sender });
      expect(result.ok).toBe(true);
      expect(result.systemFonts).toBeNull();
      expect(result.fonts).toHaveLength(1);
    }
  });

  it("returns an empty list of added fonts for a fresh profile", async () => {
    expect((await register(async () => null)({ sender })).fonts).toEqual([]);
  });
});
