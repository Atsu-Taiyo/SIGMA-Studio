// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BODY_FONT_FAMILY, DEFAULT_SERIF_BODY_FONT_FAMILY } from "@/features/document";
import { TEXT_FORMAT_STATE_EVENT } from "./constants";
import { useTextFormattingState } from "./use-text-formatting-state";

let root: Root;
let state: ReturnType<typeof useTextFormattingState>;
const getBridge = vi.fn();
vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: () => getBridge() }));
function Harness() { const next = useTextFormattingState(); useLayoutEffect(() => { state = next; }); return null; }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => { act(() => root.unmount()); vi.clearAllMocks(); });

describe("preferred font state", () => {
  it("loads the last choice separately from the font reported by the current selection", async () => {
    const saveEditorPreferences = vi.fn().mockResolvedValue({ ok: true });
    getBridge.mockReturnValue({ app: { getEditorPreferences: async () => ({ fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY }), saveEditorPreferences } });
    await act(async () => root.render(<Harness />));
    expect(state.preferredFontFamily).toBe(DEFAULT_SERIF_BODY_FONT_FAMILY);
    act(() => window.dispatchEvent(new CustomEvent(TEXT_FORMAT_STATE_EVENT, { detail: { fontFamily: "monospace" } })));
    expect(state.fontFamily).toBe("monospace");
    expect(state.preferredFontFamily).toBe(DEFAULT_SERIF_BODY_FONT_FAMILY);
    await act(async () => state.saveEditorFontFamilyPreference(""));
    expect(state.preferredFontFamily).toBe(DEFAULT_BODY_FONT_FAMILY);
    expect(saveEditorPreferences).toHaveBeenCalledWith({ fontFamily: DEFAULT_BODY_FONT_FAMILY });
  });

  it("does not overwrite a new choice with a slow settings response", async () => {
    let resolve!: (preferences: { fontFamily: string }) => void;
    getBridge.mockReturnValue({ app: { getEditorPreferences: () => new Promise((done) => { resolve = done; }), saveEditorPreferences: vi.fn().mockResolvedValue({ ok: true }) } });
    act(() => root.render(<Harness />));
    act(() => state.saveEditorFontFamilyPreference("monospace"));
    await act(async () => resolve({ fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY }));
    expect(state.preferredFontFamily).toBe("monospace");
  });
});

it("retains sizes for partial reports, but clears unavailable or disabled targets and document resets", () => {
  getBridge.mockReturnValue(null);
  act(() => root.render(<Harness />));
  const report = (detail: object) => act(() => { window.dispatchEvent(new CustomEvent(TEXT_FORMAT_STATE_EVENT, { detail })); });
  report({ fontSize: 9, enabled: true, fontSizeMixed: true });
  report({ bold: true });
  expect(state.textFontSize).toBe(9);
  expect(state.textFontSizeMixed).toBe(true);
  report({ fontSize: null, enabled: true });
  expect(state.textFontSize).toBeNull();
  report({ fontSize: 12 });
  report({ enabled: false });
  expect(state.textFontSize).toBeNull();
  report({ fontSize: 9 });
  act(() => state.setTextFontSize(null));
  expect(state.textFontSize).toBeNull();
});
