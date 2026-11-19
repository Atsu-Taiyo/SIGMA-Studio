// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EDITOR_CUSTOM_COMMANDS_STORAGE_KEY } from "@/lib/editor-command-shortcuts";
import type { DesktopAPI } from "@/types/desktop";
import { useCommandSettingsController } from "./use-command-settings-controller";

const command = (id: string) => ({ id: `custom.${id}`, label: id, categoryId: "custom", custom: true, actions: [{ type: "command", commandId: "edit.undo" }], defaultBinding: null });

afterEach(() => { delete (window as { desktopAPI?: unknown }).desktopAPI; localStorage.clear(); });

it("takes up settings another device changed, and does not bring removed commands back from the old storage", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Left over from before the settings moved to the settings file.
  localStorage.setItem(EDITOR_CUSTOM_COMMANDS_STORAGE_KEY, JSON.stringify([command("legacy")]));
  let stored = { commandShortcuts: {}, customCommands: [command("mine")], hasCommandShortcuts: false, hasCustomCommands: true, uiLocale: "ja" };
  let synced = () => {};
  const setCommandConfig = vi.fn().mockResolvedValue({ ok: true });
  (window as { desktopAPI?: unknown }).desktopAPI = { settings: {
    get: async () => stored, setCommandConfig, setUiLocale: vi.fn(),
    onSynced: (handler: () => void) => { synced = handler; return () => { synced = () => {}; }; },
  } } as unknown as DesktopAPI;
  let current!: ReturnType<typeof useCommandSettingsController>;
  function Probe() { current = useCommandSettingsController(() => {}, () => {}); return null; }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe />));
    expect(current.customCommands.map(c => c.id)).toEqual(["custom.mine"]);

    // Another device removed the last custom command and set a shortcut.
    stored = { ...stored, customCommands: [], hasCustomCommands: false, commandShortcuts: { "edit.undo": { primary: true, key: "y" } }, hasCommandShortcuts: true };
    await act(async () => synced());
    expect(current.customCommands).toEqual([]);
    expect(current.shortcutOverrides).toEqual({ "edit.undo": { primary: true, key: "y" } });
    expect(setCommandConfig).toHaveBeenLastCalledWith({ commandShortcuts: { "edit.undo": { primary: true, key: "y" } }, customCommands: [] });
    // A change made on this screen while another device's settings are being read is the newer one.
    let release!: () => void;
    const settings = (window as unknown as { desktopAPI: { settings: { get: () => Promise<unknown> } } }).desktopAPI.settings;
    const immediate = settings.get;
    settings.get = () => new Promise(resolve => { release = () => resolve({ ...stored, customCommands: [command("remote")], hasCustomCommands: true }); });
    await act(async () => synced());
    await act(async () => current.setCustomCommands([command("typed-meanwhile") as never]));
    await act(async () => release());
    expect(current.customCommands.map(c => c.id)).toEqual(["custom.typed-meanwhile"]);
    // A sync that changed nothing here (the language only, say) does not save the commands again.
    settings.get = async () => ({ ...stored, customCommands: [command("typed-meanwhile")], hasCustomCommands: true });
    const saves = setCommandConfig.mock.calls.length;
    await act(async () => synced());
    expect(setCommandConfig.mock.calls.length).toBe(saves);
    settings.get = immediate;
    stored = { ...stored, customCommands: [], hasCustomCommands: false };
    await act(async () => current.setCustomCommands([]));

    // The old storage has done its job once the settings file holds the settings: a restart must not bring it back.
    expect(localStorage.getItem(EDITOR_CUSTOM_COMMANDS_STORAGE_KEY)).toBeNull();
    await act(async () => root.unmount());
    const again = createRoot(host);
    await act(async () => again.render(<Probe />));
    expect(current.customCommands).toEqual([]);
    await act(async () => again.unmount());
  } finally { await act(async () => root.unmount()); }
});

it("keeps a language chosen while the first settings read is under way, and a synced reload never changes the language", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { UI_LOCALE_STORAGE_KEY, getAppLocale, setAppLocale } = await import("@/lib/i18n");
  // The screen starts out in the detected English, cached.
  setAppLocale("en");
  localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
  expect(getAppLocale()).toBe("en");
  // A first launch: nothing in the settings file, the system language is detected.
  let stored: Record<string, unknown> = { commandShortcuts: {}, customCommands: [], hasCommandShortcuts: true, hasCustomCommands: true, uiLocale: null };
  let release!: () => void;
  let synced = () => {};
  const setUiLocale = vi.fn().mockResolvedValue({ ok: true });
  (window as { desktopAPI?: unknown }).desktopAPI = { settings: {
    get: () => new Promise(resolve => { release = () => resolve(stored); }),
    setCommandConfig: vi.fn().mockResolvedValue({ ok: true }), setUiLocale,
    onSynced: (handler: () => void) => { synced = handler; return () => { synced = () => {}; }; },
  } } as unknown as DesktopAPI;
  function Probe() { useCommandSettingsController(() => {}, () => {}); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    // Japanese is chosen (and saved to the settings file) before the first read comes back.
    localStorage.setItem(UI_LOCALE_STORAGE_KEY, "ja");
    await act(async () => release());
    expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("ja");
    // The running screen takes up the newer choice too, not only the next start.
    expect(getAppLocale()).toBe("ja");
    expect(setUiLocale).not.toHaveBeenCalled();

    // Settings another device changed are read again: the language on this device stays as it is.
    stored = { ...stored, uiLocale: "en" };
    const settings = (window as unknown as { desktopAPI: { settings: { get: () => Promise<unknown> } } }).desktopAPI.settings;
    settings.get = async () => stored;
    await act(async () => synced());
    expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("ja");
    expect(setUiLocale).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

async function startWithHeldRead(stored: Record<string, unknown>, initUiLocale: (value: string) => Promise<unknown>) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: () => void;
  const setUiLocale = vi.fn().mockResolvedValue({ ok: true });
  const init = vi.fn(initUiLocale);
  (window as { desktopAPI?: unknown }).desktopAPI = { settings: {
    get: () => new Promise(resolve => { release = () => resolve({ commandShortcuts: {}, customCommands: [], hasCommandShortcuts: true, hasCustomCommands: true, ...stored }); }),
    setCommandConfig: vi.fn().mockResolvedValue({ ok: true }), setUiLocale, initUiLocale: init,
  } } as unknown as DesktopAPI;
  function Probe() { useCommandSettingsController(() => {}, () => {}); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return { root, setUiLocale, init, release: () => release() };
}

it("does not overwrite a language saved to the settings file alone while the first read was under way", async () => {
  const { UI_LOCALE_STORAGE_KEY, getAppLocale, setAppLocale } = await import("@/lib/i18n");
  setAppLocale("en");
  localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
  // The read answers "no language yet", but Japanese reached the settings file meanwhile: only the main process knows.
  const { root, setUiLocale, init, release } = await startWithHeldRead({ uiLocale: null }, async () => ({ ok: true, uiLocale: "ja" }));
  try {
    await act(async () => release());
    expect(init).toHaveBeenCalledWith("en");
    expect(setUiLocale).not.toHaveBeenCalled();
    expect(getAppLocale()).toBe("ja");
  } finally { await act(async () => root.unmount()); }
});

it("follows the settings file when this window's copy of the language is cleared during the first read", async () => {
  const { UI_LOCALE_STORAGE_KEY, getAppLocale, setAppLocale } = await import("@/lib/i18n");
  setAppLocale("en");
  const { root, init, release } = await startWithHeldRead({ uiLocale: "ja" }, async () => ({ ok: true }));
  try {
    localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
    await act(async () => release());
    expect(getAppLocale()).toBe("ja");
    expect(init).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("does not let a late first-launch reply undo a language chosen while it was on its way", async () => {
  const { UI_LOCALE_STORAGE_KEY, getAppLocale, setAppLocale } = await import("@/lib/i18n");
  setAppLocale("en");
  localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
  let answerInit!: () => void;
  const { root, init, release } = await startWithHeldRead({ uiLocale: null }, () => new Promise(resolve => { answerInit = () => resolve({ ok: true, uiLocale: "en" }); }));
  try {
    await act(async () => release());
    expect(init).toHaveBeenCalledWith("en");
    // Japanese is chosen in the settings dialog before the reply about the first launch arrives.
    await act(async () => setAppLocale("ja"));
    await act(async () => answerInit());
    expect(getAppLocale()).toBe("ja");
    expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("ja");
  } finally { await act(async () => root.unmount()); }
});
