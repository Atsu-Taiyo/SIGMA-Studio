import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appSettingsPart, mergeAppSettings, parseAppSettings, type AppSettingsChange, type SyncedAppSettings } from "./app-settings-sync";
import { LocalAuthoringStyleStore } from "./authoring-style-store";
import type { PersonalDataPort } from "./authoring-style-sync";
import { readDesktopSettingsSync, writeDesktopSettings } from "./desktop-settings";

const settings = (change: Partial<SyncedAppSettings> = {}): SyncedAppSettings =>
  ({ version: 1, kind: "app-settings", commandShortcuts: {}, customCommands: [], aiWebSearchEnabled: true, ...change });
const UNDO = { primary: true, key: "y" };
const SEARCH = { primary: true, shift: true, key: "f" };
const command = (id: string, label: string) => ({ id: `custom.${id}`, label, categoryId: "custom", custom: true, actions: [{ type: "command", commandId: "edit.undo" }], defaultBinding: null });

describe("merging the app's settings of two devices", () => {
  it("keeps what either device has when they meet for the first time, and the account's copy where they differ", () => {
    const merged = mergeAppSettings(null,
      settings({ commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH }, customCommands: [command("a", "A")] }),
      settings({ commandShortcuts: { "edit.undo": null }, customCommands: [command("b", "B")], aiWebSearchEnabled: false }));
    expect(merged).toMatchObject({ commandShortcuts: { "edit.undo": null, "edit.search": SEARCH }, aiWebSearchEnabled: false });
    expect(merged.customCommands.map(c => c.id)).toEqual(["custom.a", "custom.b"]);
    // The display language is not one of the synced settings.
    expect(merged).not.toHaveProperty("uiLocale");
  });

  it("takes each device's change since they last agreed, and a removal as a removal", () => {
    const base = settings({ commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH }, customCommands: [command("a", "A"), command("b", "B")] });
    const local = settings({ ...base, commandShortcuts: { "edit.search": SEARCH }, customCommands: [command("a", "A2"), command("b", "B")] });
    const remote = settings({ ...base, commandShortcuts: { ...base.commandShortcuts, "view.zoomIn": UNDO }, customCommands: [command("a", "A")], aiWebSearchEnabled: false });
    const merged = mergeAppSettings(base, local, remote);
    expect(merged).toMatchObject({ commandShortcuts: { "edit.search": SEARCH, "view.zoomIn": UNDO }, aiWebSearchEnabled: false });
    expect(merged.commandShortcuts).not.toHaveProperty("edit.undo");
    expect(merged.customCommands).toEqual([command("a", "A2")]);
  });

  it("tells a shortcut that was switched off from one that was never changed", () => {
    // Switched off on the account, untouched here: it is off here too, and stays off on the account.
    expect(mergeAppSettings(null, settings(), settings({ commandShortcuts: { "edit.undo": null } })).commandShortcuts).toEqual({ "edit.undo": null });
    expect(mergeAppSettings(null, settings({ commandShortcuts: { "edit.undo": null } }), settings()).commandShortcuts).toEqual({ "edit.undo": null });
    const base = settings({ commandShortcuts: { "edit.undo": null } });
    // Put back to the default on another device since: the default it is.
    expect(mergeAppSettings(base, base, settings()).commandShortcuts).toEqual({});
    expect(mergeAppSettings(settings(), settings(), base).commandShortcuts).toEqual({ "edit.undo": null });
  });

  it("reads a copy by the same checks as the settings file, and nothing it does not know", () => {
    expect(parseAppSettings({ version: 2, kind: "app-settings" })).toBeNull();
    expect(parseAppSettings({ version: 1, kind: "workspace" })).toBeNull();
    const parsed = parseAppSettings({ version: 1, kind: "app-settings", uiLocale: "xx", commandShortcuts: { "edit.undo": UNDO, "not.a.command": UNDO, "edit.search": "rm -rf" },
      customCommands: [command("a", "A"), { id: "../../x", label: "x", actions: [] }], codexBin: "/tmp/evil", aiAutoApplyVerifiedProposals: true });
    expect(parsed).toEqual(settings({ commandShortcuts: { "edit.undo": UNDO }, customCommands: [command("a", "A")] as never }));
    // A language written to the account by an earlier version is dropped, valid or not.
    expect(parseAppSettings({ version: 1, kind: "app-settings", uiLocale: "en" })).not.toHaveProperty("uiLocale");
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

  it("brings the shortcuts to another device and tells the running app what changed, but leaves each device's language alone", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { uiLocale: "en", commandShortcuts: { "edit.undo": UNDO }, customCommands: [command("a", "A")], aiWebSearchEnabled: false });
    await a.sync();
    expect(a.applied).toEqual([]);

    const b = await device();
    await b.sync();
    expect(b.read()).toMatchObject({ commandShortcuts: { "edit.undo": UNDO }, aiWebSearchEnabled: false });
    expect(b.read().uiLocale).toBeUndefined();
    expect(b.read().customCommands).toEqual([command("a", "A")]);
    expect(b.applied).toHaveLength(1);
    expect(Object.keys(b.applied[0]).sort()).toEqual(["aiWebSearchEnabled", "commandShortcuts", "customCommands"]);

    // A change on the second device comes back; one made on both to different shortcuts keeps both.
    await writeDesktopSettings(b.dataDir, { uiLocale: "ja", commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH } });
    await writeDesktopSettings(a.dataDir, { commandShortcuts: { "edit.undo": UNDO, "view.zoomIn": SEARCH } });
    await b.sync();
    await a.sync();
    await b.sync();
    for (const each of [a, b]) expect(each.read()).toMatchObject({ commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH, "view.zoomIn": SEARCH } });
    expect(a.read().uiLocale).toBe("en");
    expect(b.read().uiLocale).toBe("ja");
    // Settled: nothing more is written.
    const revision = server.get("app-settings")!.revision;
    await a.sync(); await b.sync();
    expect(server.get("app-settings")!.revision).toBe(revision);
  });

  it("never sends what belongs to one machine, and never changes it there", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { uiLocale: "en", aiWebSearchEnabled: false, codexBin: "/Users/someone/bin/codex", claudeBin: "/opt/claude", editorFontFamily: "Local Font",
      customFonts: [{ id: "font1", displayName: "Local", fileName: "local.ttf", cssFamily: "Local", importedAt: "2026-11-01T00:00:00Z" }], aiAutoApplyVerifiedProposals: true });
    await a.sync();
    const sent = JSON.stringify([...server.values()]);
    for (const kept of ["/Users/someone", "/opt/claude", "Local Font", "local.ttf", "aiAutoApply", "newDocumentPageSetup"]) expect(sent).not.toContain(kept);
    expect(Object.keys((server.get("app-settings")!.content as object)).sort()).toEqual(["aiWebSearchEnabled", "commandShortcuts", "customCommands", "kind", "version"]);

    const b = await device();
    await writeDesktopSettings(b.dataDir, { codexBin: "/b/codex", editorFontFamily: "B Font" });
    await b.sync();
    expect(b.read()).toEqual({ aiWebSearchEnabled: false, codexBin: "/b/codex", editorFontFamily: "B Font" });
  });

  it("keeps a shortcut switched off on one device switched off, instead of taking a new device's default for a change", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { commandShortcuts: { "edit.undo": null } });
    await a.sync();
    const b = await device();
    await b.sync();
    await a.sync();
    for (const each of [a, b]) expect(each.read().commandShortcuts).toEqual({ "edit.undo": null });
  });

  it("does not lose a setting the user changes while another device's change is coming in", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { customCommands: [command("a", "A")] });
    await a.sync();
    const b = await device();
    await b.sync();
    await writeDesktopSettings(a.dataDir, { customCommands: [command("a", "A2")] });
    await a.sync();
    // The user's write is queued just before the sync reads the file, and lands while the sync is under way.
    const edit = writeDesktopSettings(b.dataDir, { commandShortcuts: { "edit.search": SEARCH }, codexBin: "/b/codex" });
    await Promise.all([edit, b.sync()]);
    expect(b.read()).toEqual({ customCommands: [command("a", "A2")], commandShortcuts: { "edit.search": SEARCH }, codexBin: "/b/codex" });
    await b.sync(); await a.sync();
    expect(a.read()).toEqual({ customCommands: [command("a", "A2")], commandShortcuts: { "edit.search": SEARCH } });
  });

  it("sends no settings from an account without Pro", async () => {
    const a = await device(false);
    await writeDesktopSettings(a.dataDir, { commandShortcuts: { "edit.undo": UNDO } });
    expect((await a.sync()).sync.state).toBe("pro-required");
    expect(server.size).toBe(0);
  });

  it("sends nothing for a language chosen on a device, and a language left on the account by an earlier version changes nothing", async () => {
    const a = await device();
    await writeDesktopSettings(a.dataDir, { uiLocale: "en" });
    await a.sync();
    expect(server.size).toBe(0);

    // An earlier version put a language on the account next to a shortcut.
    server.set("app-settings", { revision: "old", content: { version: 1, kind: "app-settings", uiLocale: "en", commandShortcuts: { "edit.undo": UNDO }, customCommands: [], aiWebSearchEnabled: true } });
    const b = await device();
    await writeDesktopSettings(b.dataDir, { uiLocale: "ja" });
    await b.sync();
    expect(b.read()).toEqual({ uiLocale: "ja", commandShortcuts: { "edit.undo": UNDO } });
    expect(b.applied.every(change => !("uiLocale" in change))).toBe(true);
    // Whatever goes back to the account no longer carries a language.
    await writeDesktopSettings(b.dataDir, { commandShortcuts: { "edit.undo": UNDO, "edit.search": SEARCH } });
    await b.sync();
    expect(server.get("app-settings")!.revision).not.toBe("old");
    expect(server.get("app-settings")!.content).not.toHaveProperty("uiLocale");
    await a.sync();
    expect(a.read().uiLocale).toBe("en");
    expect(a.applied.every(change => !("uiLocale" in change))).toBe(true);
  });
});
