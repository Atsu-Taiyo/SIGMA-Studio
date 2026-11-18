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
  } finally { await act(async () => root.unmount()); }
});
