// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorCommandId, EditorCustomCommandAction, EditorCustomCommandDefinition } from "@/lib/editor-command-shortcuts";
import { createTranslator } from "@/lib/i18n";

import { SELECT_BODY_WITH_SHAPES_EVENT } from "../text-flow/body-shape-selection";
import { createEditorCommandRunner, type EditorCommandActionPorts } from "./editor-command-actions";
import { useEditorCommandRouting, type EditorCommandRoutingOptions } from "./use-editor-command-routing";

let container: HTMLDivElement;
let target: HTMLButtonElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  target = document.createElement("button");
  document.body.append(container, target);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  target.remove();
  vi.restoreAllMocks();
});

function custom(action: EditorCustomCommandAction): EditorCustomCommandDefinition {
  return { id: "custom.example", categoryId: "custom", custom: true, label: "Example", defaultBinding: null, action };
}

function fixture() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => vi.fn((...args: unknown[]) => { calls.push([name, ...args]); });
  const state = { zoom: 100, outlineOpen: false, textTarget: "document" as "document" | "overlay" | "comment", fillOpacity: 0.4 };
  const actions: EditorCommandActionPorts = {
    text: {
      runEditCommand: record("edit"),
      toggleBoxedText: record("boxed"),
      applyTextStyle: record("block-style"),
      applyTextAlign: record("align"),
      applyLineHeight: vi.fn((value) => { calls.push(["line-height", value]); return false; }),
      applyInlineFormat: record("format"),
      getActiveTextTarget: vi.fn(() => state.textTarget),
      insertInlineMath: record("math"),
      setFontFamily: record("font-family"),
      setTextFontSize: record("font-size"),
      setTextColor: record("text-color"),
      setTextBackgroundColor: record("text-background"),
    },
    overlay: {
      runOverlayCommand: record("overlay-tool"),
      requestOverlayAction: record("overlay-action"),
      applyOverlayStyle: record("overlay-style"),
      fillColorPatch: vi.fn((color) => ({ fill: "solid" as const, fillColor: color, fillOpacity: state.fillOpacity })),
      setStrokeColor: record("stroke-color"),
      imageInputRef: { current: { click: record("image-input") } },
    },
    menus: {
      closeTransientCommandSurfaces: record("close-transient"),
      setFontFamilyMenuOpen: record("font-menu"),
      setLineHeightMenuOpen: record("height-menu"),
      setLineHeightCustomOpen: record("custom-height-menu"),
      setTextAlignMenuOpen: record("align-menu"),
      setLineDashMenuOpen: record("dash-menu"),
      setLineWidthMenuOpen: record("width-menu"),
      setLineEndpointMenu: record("endpoint-menu"),
    },
    application: {
      undoDocumentChange: record("undo"),
      redoDocumentChange: record("redo"),
      createDocumentTab: record("new-document"),
      openDocumentListDialog: record("library"),
      duplicateActiveDocument: record("duplicate-document"),
      addBlock: record("add-block"),
      setSearchOpen: record("search"),
      setOutlineOpen: vi.fn((next) => { state.outlineOpen = typeof next === "function" ? next(state.outlineOpen) : next; }),
      applyZoom: vi.fn((next) => { state.zoom = typeof next === "function" ? next(state.zoom) : next; }),
      resetZoom: record("reset-zoom"),
      setSettingsFocusEntryId: record("settings-focus"),
      setCommandPaletteOpen: record("palette"),
      openPrintPreview: record("print"),
      toggleCommentsPanel: record("comments"),
      setOutlineDialogOpen: record("outline-dialog"),
      promoteAiToSidebar: record("chat"),
      setAiSettingsOpen: record("ai-settings"),
      setPageSettingsOpen: record("page-settings"),
      openCommandSettings: vi.fn(() => true),
      setMaterialLibraryOpen: record("materials"),
      setStatusMessage: record("status"),
      tEditor: createTranslator("ja", "editor"),
    },
  };
  const previousRunner = vi.fn();
  const options: EditorCommandRoutingOptions = {
    configuration: {
      customCommands: [],
      shortcutOverrides: { "edit.undo": { key: "z", ctrl: true } },
      commandSettingsLoaded: true,
      commandSettingsError: null,
    },
    keyboard: {
      isModalSurfaceOpen: false,
      uiLayoutMode: "docs",
      hasOverlaySelection: true,
      overlaySelectionLocked: false,
      blockedOverlaySelection: false,
      overlayModeStatus: null,
    },
    actions,
    runShortcutCommandRef: { current: previousRunner },
    toggleRibbonCollapseRef: { current: record("toggle-ribbon") },
  };
  return { actions, options, calls, state, previousRunner, record };
}

function Probe({ options, onLayout }: { options: EditorCommandRoutingOptions; onLayout?: () => void }) {
  useEditorCommandRouting(options);
  useLayoutEffect(() => { onLayout?.(); });
  return null;
}

function render(options: EditorCommandRoutingOptions, onLayout?: () => void) {
  act(() => root!.render(<Probe options={options} onLayout={onLayout} />));
}

function press(init: KeyboardEventInit = {}, element: HTMLElement = target): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true, ...init });
  act(() => { element.dispatchEvent(event); });
  return event;
}

describe("command execution ports", () => {
  it("does no work until execution and uses the live image input and text target", () => {
    const f = fixture();
    const runner = createEditorCommandRunner([], f.actions);
    expect(f.calls).toEqual([]);
    const imageInput = { current: { click: f.record("replacement-image-input") } };
    Object.assign(f.actions.overlay.imageInputRef, imageInput);
    f.state.textTarget = "comment";

    runner("overlay.image");
    runner("insert.inlineMath");

    expect(f.calls).toEqual([
      ["close-transient"], ["replacement-image-input"],
      ["close-transient"], ["math", "", "comment"],
      ["status", f.actions.application.tEditor("status.mathAdded")],
    ]);
  });

  it("closes the shared transient surfaces before both custom and ordinary commands", () => {
    const f = fixture();
    const runner = createEditorCommandRunner([custom({ type: "textFormat", command: "boxed" })], f.actions);
    runner("custom.example");
    runner("edit.undo");
    expect(f.calls).toEqual([["close-transient"], ["boxed"], ["close-transient"], ["undo"]]);
    expect(f.actions.text.runEditCommand).not.toHaveBeenCalled();
  });

  it("keeps the stored font reset value distinct from the normalized toolbar display", () => {
    const f = fixture();
    createEditorCommandRunner([custom({ type: "fontFamily", value: "" })], f.actions)("custom.example");
    expect(f.actions.text.setFontFamily).toHaveBeenCalledWith(expect.any(String));
    expect(f.actions.text.applyInlineFormat).toHaveBeenCalledWith("fontFamily", "");
    expect(f.calls.at(-1)).toEqual(["font-menu", false]);
  });

  it("preserves the host's current fill policy and keeps a no-fill action independent from it", () => {
    const f = fixture();
    const command = custom({ type: "overlayFillColor", value: "#2468ac" });
    const runner = createEditorCommandRunner([command], f.actions);
    f.state.fillOpacity = 0.7;
    runner(command.id);
    expect(f.actions.overlay.applyOverlayStyle).toHaveBeenLastCalledWith({ fill: "solid", fillColor: "#2468ac", fillOpacity: 0.7 });

    createEditorCommandRunner([custom({ type: "overlayFillColor", value: null })], f.actions)("custom.example");
    expect(f.actions.overlay.applyOverlayStyle).toHaveBeenLastCalledWith({ fill: "none" });
    expect(f.actions.overlay.fillColorPatch).toHaveBeenCalledTimes(1);
  });

  it("dismisses both line-height menus after an attempted custom command, including rejection", () => {
    const f = fixture();
    createEditorCommandRunner([custom({ type: "lineHeight", value: "2" })], f.actions)("custom.example");
    expect(f.calls).toEqual([
      ["close-transient"], ["line-height", "2"], ["height-menu", false], ["custom-height-menu", false],
    ]);
  });

  it("applies successive relative view commands to the host's current value", () => {
    const f = fixture();
    const runner = createEditorCommandRunner([], f.actions);
    runner("view.zoomIn");
    f.state.zoom = 150;
    runner("view.zoomIn");
    runner("view.toggleOutline");
    runner("view.toggleOutline");
    expect(f.state).toMatchObject({ zoom: 160, outlineOpen: false });
  });

  it("delivers body-with-shapes selection as the existing shared event", () => {
    const f = fixture();
    const received = vi.fn();
    window.addEventListener(SELECT_BODY_WITH_SHAPES_EVENT, received);
    try {
      createEditorCommandRunner([], f.actions)("edit.selectAllWithShapes");
      expect(received).toHaveBeenCalledTimes(1);
      expect(f.calls).toEqual([["close-transient"]]);
    } finally {
      window.removeEventListener(SELECT_BODY_WITH_SHAPES_EVENT, received);
    }
  });

  it("hands document creation off synchronously without turning its completion into the command result", async () => {
    const f = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    f.actions.application.createDocumentTab = () => { f.calls.push(["start-create"]); return pending; };
    const result = createEditorCommandRunner([], f.actions)("document.new");
    expect(result).toBeUndefined();
    expect(f.calls).toEqual([["close-transient"], ["start-create"]]);
    finish();
    await pending;
  });
});

describe("mounted command routing", () => {
  it("publishes after layout on every render while keeping one capture listener and its subscription order", () => {
    const f = fixture();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const atLayout: Array<(commandId: EditorCommandId) => void> = [];
    render(f.options, () => { atLayout.push(f.options.runShortcutCommandRef.current); });
    expect(atLayout[0]).toBe(f.previousRunner);
    const firstRunner = f.options.runShortcutCommandRef.current;
    expect(firstRunner).not.toBe(f.previousRunner);
    const laterCapture = vi.fn();
    window.addEventListener("keydown", laterCapture, true);
    try {
      const nextActions: EditorCommandActionPorts = {
        ...f.actions,
        application: { ...f.actions.application, undoDocumentChange: f.record("next-undo") },
      };
      render({ ...f.options, actions: nextActions }, () => { atLayout.push(f.options.runShortcutCommandRef.current); });
      expect(atLayout[1]).toBe(firstRunner);
      expect(f.options.runShortcutCommandRef.current).not.toBe(firstRunner);
      expect(added.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(2);
      expect(removed.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(0);

      const bubble = vi.fn();
      target.addEventListener("keydown", bubble);
      const event = press();
      expect(event.defaultPrevented).toBe(true);
      expect(f.calls).toEqual([["close-transient"], ["next-undo"]]);
      expect(laterCapture).toHaveBeenCalledTimes(1);
      expect(bubble).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", laterCapture, true);
    }
  });

  it.each(["modal", "composing", "loading", "load-error"] as const)("leaves %s key input untouched", (reason) => {
    const f = fixture();
    if (reason === "modal") f.options.keyboard.isModalSurfaceOpen = true;
    if (reason === "loading") f.options.configuration.commandSettingsLoaded = false;
    if (reason === "load-error") f.options.configuration.commandSettingsError = "failed";
    render(f.options);
    const native = vi.fn();
    target.addEventListener("keydown", native);
    expect(press({ isComposing: reason === "composing" }).defaultPrevented).toBe(false);
    expect(native).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([]);
  });

  it("yields field history to the input and resumes document history on a non-input surface", () => {
    const f = fixture();
    render(f.options);
    const input = document.createElement("input");
    container.appendChild(input);
    const native = vi.fn();
    input.addEventListener("keydown", native);
    expect(press({}, input).defaultPrevented).toBe(false);
    expect(native).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([]);
    expect(press().defaultPrevented).toBe(true);
    expect(f.calls).toEqual([["close-transient"], ["undo"]]);
  });

  it("honours a DOM modal even when the host flag is false", () => {
    const f = fixture();
    render(f.options);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    container.appendChild(dialog);
    dialog.appendChild(target);
    expect(press().defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("uses Ctrl+F1 before settings load, then yields to the user's binding once loaded", () => {
    const f = fixture();
    f.options.keyboard.uiLayoutMode = "word";
    f.options.configuration.commandSettingsLoaded = false;
    f.options.configuration.shortcutOverrides = { "edit.undo": { key: "F1", ctrl: true } };
    render(f.options);
    expect(press({ key: "F1" }).defaultPrevented).toBe(true);
    expect(f.calls).toEqual([["toggle-ribbon"]]);

    f.calls.length = 0;
    render({ ...f.options, configuration: { ...f.options.configuration, commandSettingsLoaded: true } });
    expect(press({ key: "F1" }).defaultPrevented).toBe(true);
    expect(f.calls).toEqual([["close-transient"], ["undo"]]);
  });

  it("still toggles the Word ribbon when settings failed, but never bypasses a modal or IME", () => {
    const f = fixture();
    f.options.keyboard.uiLayoutMode = "word";
    f.options.configuration.commandSettingsError = "failed";
    render(f.options);
    expect(press({ key: "F1" }).defaultPrevented).toBe(true);
    expect(f.calls).toEqual([["toggle-ribbon"]]);
    f.calls.length = 0;
    expect(press({ key: "F1", isComposing: true }).defaultPrevented).toBe(false);
    render({ ...f.options, keyboard: { ...f.options.keyboard, isModalSurfaceOpen: true } });
    expect(press({ key: "F1" }).defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it.each([
    { metaKey: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: false },
  ])("does not take a modified ribbon key: %j", (modifiers) => {
    const f = fixture();
    f.options.keyboard.uiLayoutMode = "word";
    render(f.options);
    expect(press({ key: "F1", ...modifiers }).defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("does not install the Word ribbon binding in the docs layout", () => {
    const f = fixture();
    render(f.options);
    expect(press({ key: "F1" }).defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it.each([
    ["view.zoomIn", true], ["view.zoomOut", true],
    ["overlay.arrange.forward", true], ["overlay.arrange.backward", true],
    ["edit.undo", false], ["overlay.arrange.front", false],
  ] as const)("keeps the repeat policy for %s", (commandId, accepted) => {
    const f = fixture();
    f.options.configuration.shortcutOverrides = { [commandId]: { key: "j", ctrl: true } };
    render(f.options);
    expect(press({ key: "j", repeat: true }).defaultPrevented).toBe(accepted);
    expect(f.actions.menus.closeTransientCommandSurfaces).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });

  it.each(["none", "locked", "extension-blocked", "text", "table"] as const)("does not claim arrangement when the selection is %s", (reason) => {
    const f = fixture();
    f.options.configuration.shortcutOverrides = { "overlay.arrange.forward": { key: "j", ctrl: true } };
    if (reason === "none") f.options.keyboard.hasOverlaySelection = false;
    if (reason === "locked") f.options.keyboard.overlaySelectionLocked = true;
    if (reason === "extension-blocked") f.options.keyboard.blockedOverlaySelection = true;
    if (reason === "text" || reason === "table") {
      f.options.keyboard.overlayModeStatus = { id: reason === "text" ? "overlay.textEditing" : "overlay.tableEditing", labelId: "selection" };
    }
    render(f.options);
    expect(press({ key: "j" }).defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("releases the exact capture listener on unmount", () => {
    const f = fixture();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    render(f.options);
    const subscription = added.mock.calls.find(([type]) => type === "keydown")!;
    act(() => root!.unmount());
    root = null;
    expect(removed).toHaveBeenCalledWith(...subscription);
    expect(press().defaultPrevented).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
