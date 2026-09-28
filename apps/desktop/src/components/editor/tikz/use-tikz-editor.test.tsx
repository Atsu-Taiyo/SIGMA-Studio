// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@/features/document";
import type { TikzRenderResponse } from "@/lib/tikz-contract";
import { useTikzEditor } from "./use-tikz-editor";

const render = vi.hoisted(() => vi.fn());
vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: () => ({ tikz: { render } }) }));
vi.mock("../GraphSettingsPanel", () => ({ GraphSettingsPanelFrame: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
const source = String.raw`本文。\begin{tikzpicture}\draw (0,0)--(1,0);\end{tikzpicture}途中。\begin{tikzpicture}\draw (0,0)--(0,1);\end{tikzpicture}最後。`;
const doc: SigmaDocument = { version: "2.0", docId: "first", metadata: { title: "Test" }, content: [], outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
const insertDocument = vi.fn<(document: SigmaDocument, anchor: string | null) => boolean>(() => true);
beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }); });
let editor: ReturnType<typeof useTikzEditor>;
const container = document.createElement("div");
let root = createRoot(container);
function Host({ fileId = "a", writable = true }: { fileId?: string; writable?: boolean }) {
  const value = useTikzEditor({ document: doc, fileId, writable, commit: () => true, insert: vi.fn(),
    getPasteAnchor: () => "original-anchor", insertDocument });
  useLayoutEffect(() => { editor = value; });
  return value.dialog;
}
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.clearAllMocks();
});
function pending() {
  let resolve!: (response: TikzRenderResponse) => void;
  const promise = new Promise<TikzRenderResponse>(done => { resolve = done; });
  return { promise, resolve };
}
const image: TikzRenderResponse = { ok: true, image: { src: "data:image/svg+xml;base64,PHN2Zy8+", width: 40, height: 40 } };

describe("mixed TikZ paste lifecycle", () => {
  it("commits all text and figures once at the captured insertion anchor", async () => {
    const first = pending();
    render.mockReturnValueOnce(first.promise).mockResolvedValueOnce(image);
    await act(async () => root.render(<Host />));
    await act(async () => { expect(editor.pasteTikz(source)).toBe(true); });
    expect(insertDocument).not.toHaveBeenCalled();
    await act(async () => first.resolve(image));
    expect(render).toHaveBeenCalledTimes(2);
    expect(insertDocument).toHaveBeenCalledTimes(1);
    expect(insertDocument.mock.calls[0][1]).toBe("original-anchor");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["switch", "readonly", "cancel", "unmount"])("discards a pending paste on %s", async reason => {
    const first = pending();
    render.mockReturnValue(first.promise);
    await act(async () => root.render(<Host />));
    await act(async () => { expect(editor.pasteTikz(source)).toBe(true); });
    expect(render).toHaveBeenCalledOnce();
    await act(async () => {
      if (reason === "switch") root.render(<Host fileId="other" />);
      if (reason === "readonly") root.render(<Host writable={false} />);
      if (reason === "unmount") root.render(null);
      if (reason === "cancel") [...container.querySelectorAll("button")].find(b => b.textContent === "キャンセル")!.click();
    });
    await act(async () => first.resolve(image));
    expect(insertDocument).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
  });

  it("discards a pending batch when a later paste starts single-image editing", async () => {
    const first = pending();
    render.mockReturnValue(first.promise);
    await act(async () => root.render(<Host />));
    await act(async () => { editor.pasteTikz(source); });
    await act(async () => { editor.pasteTikz(String.raw`\begin{tikzpicture}\draw (0,0)--(1,0);\end{tikzpicture}`); });
    await act(async () => first.resolve(image));
    expect(insertDocument).not.toHaveBeenCalled();
  });
});
