// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTranslator } from "@/lib/i18n";

import type { PaletteEntry } from "../command-palette-model";
import type { SettingsSurfaceId } from "../settings-catalog";
import { useCommandPalette, type EditorCommandPaletteOptions } from "./use-command-palette";

let root: Root;
let container: HTMLDivElement;
let palette: ReturnType<typeof useCommandPalette>;
let frames: FrameRequestCallback[];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  frames = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe({ options }: { options: EditorCommandPaletteOptions }) {
  const result = useCommandPalette(options);
  useLayoutEffect(() => { palette = result; });
  return <div>{result.renderMenuShortcut("edit.undo")}</div>;
}

function render(options: EditorCommandPaletteOptions) {
  act(() => root.render(<Probe options={options} />));
}

function fixture() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => vi.fn((...args: unknown[]) => { calls.push([name, ...args]); });
  const translators = {
    tCommand: createTranslator("ja", "command"),
    tSettings: createTranslator("ja", "settings"),
  };
  const tCommand = vi.spyOn(translators, "tCommand");
  const tSettings = vi.spyOn(translators, "tSettings");
  const options: EditorCommandPaletteOptions = {
    commandPaletteOpen: true,
    catalog: {
      customCommands: [],
      shortcutOverrides: {},
      shortcutPlatform: "mac",
      isEmbedded: false,
      tCommand: translators.tCommand,
      tSettings: translators.tSettings,
    },
    surfaces: {
      setCommandPaletteOpen: record("palette"),
      setSettingsFocusEntryId: record("focus"),
      setDesktopSettingsOpen: record("desktop"),
      setAiSettingsOpen: record("ai"),
      setPageSettingsOpen: record("page"),
      setTexEnvironmentSettingsOpen: record("tex"),
      openCommandSettings: vi.fn(() => { calls.push(["commands"]); return true; }),
    },
    runShortcutCommandRef: { current: record("run") },
  };
  return { options, calls, record, tCommand, tSettings };
}

const commandEntry: PaletteEntry = { kind: "command", id: "insert.heading", label: "見出し", groupId: "insert", group: "挿入", shortcut: null };
const settingEntry = (surface: SettingsSurfaceId): PaletteEntry => ({
  kind: "setting", id: `setting.${surface}`, surface, label: "設定", groupId: "settings", group: "設定",
});

describe("mounted command palette", () => {
  it("does not resolve the catalog while closed and memoizes an open catalog across unrelated renders", () => {
    const f = fixture();
    render({ ...f.options, commandPaletteOpen: false });
    expect(palette.paletteEntries).toEqual([]);
    expect(f.tCommand).not.toHaveBeenCalled();
    expect(f.tSettings).not.toHaveBeenCalled();

    render(f.options);
    const entries = palette.paletteEntries;
    const commandCalls = f.tCommand.mock.calls.length;
    const settingsCalls = f.tSettings.mock.calls.length;
    expect(commandCalls).toBeGreaterThan(0);
    expect(settingsCalls).toBeGreaterThan(0);
    render({ ...f.options, surfaces: { ...f.options.surfaces } });
    expect(palette.paletteEntries).toBe(entries);
    expect(f.tCommand).toHaveBeenCalledTimes(commandCalls);
    expect(f.tSettings).toHaveBeenCalledTimes(settingsCalls);
  });

  it("re-resolves command and settings labels when the active translators change", () => {
    const f = fixture();
    render(f.options);
    const japanese = palette.paletteEntries.find((entry) => entry.id === "edit.undo")!;
    expect(japanese.label).toBe("元に戻す");
    render({
      ...f.options,
      catalog: { ...f.options.catalog, tCommand: createTranslator("en", "command"), tSettings: createTranslator("en", "settings") },
    });
    expect(palette.paletteEntries.find((entry) => entry.id === "edit.undo")?.label).toBe("Undo");
    expect(palette.paletteEntries.find((entry) => entry.id === "settings.app.language")?.label).toBe("Display language");
  });

  it("hides the palette's own command and only the unavailable embedded settings surfaces", () => {
    const f = fixture();
    render(f.options);
    const desktopEntries = palette.paletteEntries;
    expect(desktopEntries.some((entry) => entry.id === "view.commandPalette")).toBe(false);
    expect(desktopEntries.some((entry) => entry.kind === "setting" && entry.surface === "desktopApp")).toBe(true);
    render({ ...f.options, catalog: { ...f.options.catalog, isEmbedded: true } });
    const expected = desktopEntries.filter((entry) => entry.kind !== "setting"
      || !["desktopApp", "desktopAi", "aiResources"].includes(entry.surface));
    expect(palette.paletteEntries).toEqual(expected);
  });

  it("keeps a custom command's own label and current shortcut in the open catalog", () => {
    const f = fixture();
    f.options.catalog.customCommands = [{
      id: "custom.my-format", categoryId: "custom", label: "授業用の強調", custom: true,
      defaultBinding: null, action: { type: "textColor", value: "#123456" },
    }];
    f.options.catalog.shortcutOverrides = { "custom.my-format": { key: "j", primary: true, alt: true } };
    render(f.options);
    expect(palette.paletteEntries.find((entry) => entry.id === "custom.my-format"))
      .toMatchObject({ label: "授業用の強調", shortcut: "⌘⌥J" });
  });

  it("closes immediately and waits one frame before reading the current command runner", () => {
    const f = fixture();
    render(f.options);
    act(() => palette.runPaletteEntry(commandEntry));
    expect(f.calls).toEqual([["palette", false]]);
    expect(frames).toHaveLength(1);
    f.options.runShortcutCommandRef.current = f.record("latest-run");
    act(() => frames.shift()!(16));
    expect(f.calls).toEqual([["palette", false], ["latest-run", "insert.heading"]]);
    expect(frames).toEqual([]);
  });

  it.each([
    ["desktopApp", "desktop"], ["desktopAi", "ai"], ["aiResources", "ai"], ["page", "page"],
  ] as const)("closes, sets the focus target, then opens %s", (surface, destination) => {
    const f = fixture();
    render(f.options);
    act(() => palette.runPaletteEntry(settingEntry(surface)));
    expect(f.calls).toEqual([["palette", false], ["focus", `setting.${surface}`], [destination, true]]);
    expect(frames).toEqual([]);
  });

  it("opens the TeX surface without leaving a focus request for another settings dialog", () => {
    const f = fixture();
    render(f.options);
    act(() => palette.runPaletteEntry(settingEntry("texEnvironment")));
    expect(f.calls).toEqual([["palette", false], ["tex", true]]);
    expect(frames).toEqual([]);
  });

  it.each([true, false])("sets a command-settings focus target only after the open operation succeeds: %s", (opened) => {
    const f = fixture();
    f.options.surfaces.openCommandSettings = () => { f.calls.push(["commands"]); return opened; };
    render(f.options);
    act(() => palette.runPaletteEntry(settingEntry("commands")));
    expect(f.calls).toEqual([
      ["palette", false], ["commands"], ...(opened ? [["focus", "setting.commands"]] : []),
    ]);
    expect(frames).toEqual([]);
  });

  it("updates menu, tooltip and arrangement labels together when shortcut settings change", () => {
    const f = fixture();
    render(f.options);
    expect(container.querySelector("kbd")?.textContent).toBe("⌘Z");
    render({
      ...f.options,
      catalog: {
        ...f.options.catalog,
        shortcutPlatform: "windows",
        shortcutOverrides: {
          "edit.undo": { key: "y", ctrl: true, shift: true },
          "overlay.arrange.front": null,
        },
      },
    });
    expect(container.querySelector("kbd")?.textContent).toBe("Ctrl+Shift+Y");
    expect(palette.commandTooltip("Undo label", "edit.undo")).toEqual({ label: "Undo label", shortcut: "Ctrl+Shift+Y" });
    expect(palette.renderMenuShortcut("overlay.arrange.front")).toBeNull();
    expect(palette.commandTooltip("Front label", "overlay.arrange.front")).toEqual({ label: "Front label", shortcut: null });
    expect(palette.overlayArrangeShortcutLabels.front).toBeUndefined();
  });
});
