import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appSettingsPart, mergeAppSettings, parseAppSettings, type AppSettingsChange, type SyncedAppSettings } from "./app-settings-sync";
import { LocalAuthoringStyleStore } from "./authoring-style-store";
import type { PersonalDataPort } from "./authoring-style-sync";
import { readDesktopSettingsSync, writeDesktopSettings } from "./desktop-settings";

const settings = (change: Partial<SyncedAppSettings> = {}): SyncedAppSettings =>
  ({ version: 1, kind: "app-settings", uiLocale: null, commandShortcuts: {}, customCommands: [], aiWebSearchEnabled: true, ...change });
const UNDO = { primary: true, key: "y" };
const SEARCH = { primary: true, shift: true, key: "f" };
const command = (id: string, label: string) => ({ id: `custom.${id}`, label, categoryId: "custom", custom: true, actions: [{ type: "command", commandId: "edit.undo" }], defaultBinding: null });

describe("merging the app's settings of two devices", () => {
  it("keeps what either device has when they meet for the first time, and the account's copy where they differ", () => {
    const merged = mergeAppSettings(null,
      settings({ uiLocale: "en", commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH }, customCommands: [command("a", "A")] }),
      settings({ uiLocale: "ja", commandShortcuts: { "edit.undo": null }, customCommands: [command("b", "B")], aiWebSearchEnabled: false }));
    expect(merged).toMatchObject({ uiLocale: "ja", commandShortcuts: { "edit.undo": null, "edit.search": SEARCH }, aiWebSearchEnabled: false });
    expect(merged.customCommands.map(c => c.id)).toEqual(["custom.a", "custom.b"]);
    // A device that never chose a language takes the account's; an account without one takes the device's.
    expect(mergeAppSettings(null, settings(), settings({ uiLocale: "en" })).uiLocale).toBe("en");
    expect(mergeAppSettings(null, settings({ uiLocale: "en" }), settings()).uiLocale).toBe("en");
  });

  it("takes each device's change since they last agreed, and a removal as a removal", () => {
    const base = settings({ uiLocale: "ja", commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH }, customCommands: [command("a", "A"), command("b", "B")] });
    const local = settings({ ...base, uiLocale: "en", commandShortcuts: { "edit.search": SEARCH }, customCommands: [command("a", "A2"), command("b", "B")] });
    const remote = settings({ ...base, commandShortcuts: { ...base.commandShortcuts, "view.zoomIn": UNDO }, customCommands: [command("a", "A")], aiWebSearchEnabled: false });
    const merged = mergeAppSettings(base, local, remote);
    expect(merged).toMatchObject({ uiLocale: "en", commandShortcuts: { "edit.search": SEARCH, "view.zoomIn": UNDO }, aiWebSearchEnabled: false });
    expect(merged.commandShortcuts).not.toHaveProperty("edit.undo");
    expect(merged.customCommands).toEqual([command("a", "A2")]);
  });

  it("reads a copy by the same checks as the settings file, and nothing it does not know", () => {
    expect(parseAppSettings({ version: 2, kind: "app-settings" })).toBeNull();
    expect(parseAppSettings({ version: 1, kind: "workspace" })).toBeNull();
    const parsed = parseAppSettings({ version: 1, kind: "app-settings", uiLocale: "xx", commandShortcuts: { "edit.undo": UNDO, "not.a.command": UNDO, "edit.search": "rm -rf" },
      customCommands: [command("a", "A"), { id: "../../x", label: "x", actions: [] }], codexBin: "/tmp/evil", aiAutoApplyVerifiedProposals: true });
    expect(parsed).toEqual(settings({ commandShortcuts: { "edit.undo": UNDO }, customCommands: [command("a", "A")] as never }));
  });
});

describe("account sync of the app's settings", () => {
  let roots: string[] = [];
  let stores: LocalAuthoringStyleStore[] = [];
  let server: Map<string, { revision: string; content: unknown }>;
  let counter = 0;
  const port: PersonalDataPort = {
    read: async (_user, key) => structuredClone(server.get(key) ?? { revision: null, content: null }),
    write: async (_user, key, content, expected) => {
      if ((server.get(key)?.revision ?? null) !== expected) return "conflict";
      server.set(key, { revision: `r${++counter}`, content: structuredClone(content) });
      return { revision: `r${counter}` };
    },
    removeAll: async () => { server.clear(); },
  };

  async function device(pro = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-app-settings-sync-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const applied: AppSettingsChange[] = [];
    const store = new LocalAuthoringStyleStore(root, {
      reviewIdleMs: null, sync: { client: port, userId: () => "user-1", entitled: async () => pro },
      syncParts: [appSettingsPart(() => dataDir, change => applied.push(change))],
    });
    stores.push(store);
    return { dataDir, applied, sync: () => store.syncNow(null), read: () => readDesktopSettingsSync(dataDir) };
  }

  beforeEach(() => { roots = []; stores = []; server = new Map(); });
  afterEach(async () => {
    for (const store of stores) { store.dispose(); await store.flush(); }
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  });

  it("brings the language and the shortcuts to another device and tells the running app what changed", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { uiLocale: "en", commandShortcuts: { "edit.undo": UNDO }, customCommands: [command("a", "A")], aiWebSearchEnabled: false });
    await a.sync();
    expect(a.applied).toEqual([]);

    const b = await device();
    await b.sync();
    expect(b.read()).toMatchObject({ uiLocale: "en", commandShortcuts: { "edit.undo": UNDO }, aiWebSearchEnabled: false });
    expect(b.read().customCommands).toEqual([command("a", "A")]);
    expect(b.applied).toHaveLength(1);
    expect(Object.keys(b.applied[0]).sort()).toEqual(["aiWebSearchEnabled", "commandShortcuts", "customCommands", "uiLocale"]);

    // A change on the second device comes back; one made on both to different shortcuts keeps both.
    await writeDesktopSettings(b.dataDir, { uiLocale: "ja", commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH } });
    await writeDesktopSettings(a.dataDir, { commandShortcuts: { "edit.undo": UNDO, "view.zoomIn": SEARCH } });
    await b.sync();
    await a.sync();
    await b.sync();
    for (const each of [a, b]) expect(each.read()).toMatchObject({ uiLocale: "ja", commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH, "view.zoomIn": SEARCH } });
    // Settled: nothing more is written.
    const revision = server.get("app-settings")!.revision;
    await a.sync(); await b.sync();
    expect(server.get("app-settings")!.revision).toBe(revision);
  });

  it("never sends what belongs to one machine, and never changes it there", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { uiLocale: "en", codexBin: "/Users/someone/bin/codex", claudeBin: "/opt/claude", editorFontFamily: "Local Font",
      customFonts: [{ id: "font1", displayName: "Local", fileName: "local.ttf", cssFamily: "Local", importedAt: "2026-11-01T00:00:00Z" }], aiAutoApplyVerifiedProposals: true });
    await a.sync();
    const sent = JSON.stringify([...server.values()]);
    for (const kept of ["/Users/someone", "/opt/claude", "Local Font", "local.ttf", "aiAutoApply", "newDocumentPageSetup"]) expect(sent).not.toContain(kept);
    expect(Object.keys((server.get("app-settings")!.content as object)).sort()).toEqual(["aiWebSearchEnabled", "commandShortcuts", "customCommands", "kind", "uiLocale", "version"]);

    const b = await device();
    await writeDesktopSettings(b.dataDir, { codexBin: "/b/codex", editorFontFamily: "B Font" });
    await b.sync();
    expect(b.read()).toEqual({ uiLocale: "en", codexBin: "/b/codex", editorFontFamily: "B Font" });
  });

  it("sends no settings from an account without Pro", async () => {
    const a = await device(false);
    await writeDesktopSettings(a.dataDir, { uiLocale: "en" });
    expect((await a.sync()).sync.state).toBe("pro-required");
    expect(server.size).toBe(0);
  });

  it("leaves a device without a chosen language to follow its system until some device chooses one", async () => {
    const a = await device();
    await a.sync();
    expect(server.size).toBe(0);
    expect(a.read().uiLocale).toBeUndefined();
  });
});
