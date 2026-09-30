// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleDocument } from "@/lib/sample-document";
import { EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT } from "@/features/text-editing";
import { locationElements, useRequestedDocumentLocation } from "./use-requested-document-location";

type Props = Parameters<typeof useRequestedDocumentLocation>[0];
let root: Root, container: HTMLDivElement, canvas: HTMLDivElement;
const anchor = { type: "textRange", start: { blockId: "p", offset: 2 }, end: { blockId: "p", offset: 5 } };
const selectBlock = vi.fn(), unavailable = vi.fn(), revealRegion = vi.fn();
function Probe(props: Props) { useRequestedDocumentLocation(props); return null; }
function render(overrides: Partial<Props> = {}) {
  act(() => root.render(<Probe ready fileId="file-1" document={{ ...sampleDocument, content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "123456" }] }] }} root={canvas} selectBlock={selectBlock} unavailable={unavailable} revealRegion={revealRegion} {...overrides} />));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks();
  window.history.replaceState({}, "", `/?fileId=file-1&location=${encodeURIComponent(JSON.stringify(anchor))}`);
  container = document.createElement("div"); canvas = document.createElement("div");
  canvas.innerHTML = '<p data-sigma-doc-id="p">123456</p>';
  canvas.firstElementChild!.scrollIntoView = vi.fn();
  document.body.append(container, canvas); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); canvas.remove(); vi.useRealTimers(); window.history.replaceState({}, "", "/"); });

describe("requested document location", () => {
  it("waits for the requested document, highlights its exact range, consumes the URL and cleans up", () => {
    const listener = vi.fn(); window.addEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
    render({ ready: false }); act(() => vi.advanceTimersByTime(200));
    render({ fileId: "other" }); act(() => vi.advanceTimersByTime(200));
    expect(selectBlock).not.toHaveBeenCalled();
    render(); act(() => vi.advanceTimersByTime(200));
    expect(selectBlock).toHaveBeenCalledExactlyOnceWith("p");
    expect(listener.mock.calls[0][0].detail.anchors).toEqual([{ ...anchor, quote: "" }]);
    expect(canvas.firstElementChild?.classList.contains("source-reference-focus-pulse")).toBe(true);
    expect(window.location.search).toBe("?fileId=file-1");
    render(); act(() => vi.advanceTimersByTime(4000));
    expect(selectBlock).toHaveBeenCalledTimes(1);
    expect(canvas.firstElementChild?.classList.contains("source-reference-focus-pulse")).toBe(false);
    expect(listener.mock.lastCall![0].detail.anchors).toEqual([]);
    window.removeEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
  });
  it("reports a deleted target and never selects a different block", () => {
    render({ document: { ...sampleDocument, content: [] } });
    act(() => vi.advanceTimersByTime(9000));
    expect(unavailable).toHaveBeenCalledOnce(); expect(selectBlock).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain("location=");
  });
  it("waits until the startup screen no longer covers the highlight", () => {
    const splash = document.createElement("div"); splash.setAttribute("data-startup-splash", ""); document.body.append(splash);
    render(); act(() => vi.advanceTimersByTime(1000));
    expect(selectBlock).not.toHaveBeenCalled();
    splash.remove(); act(() => vi.advanceTimersByTime(200));
    expect(selectBlock).toHaveBeenCalledExactlyOnceWith("p");
  });
  it("pans to the containing shape when a whiteboard text range is linked", () => {
    canvas.innerHTML = '<div class="whiteboard-page-canvas"><div data-overlay-shape-id="s"><p data-sigma-doc-id="p">123456</p></div></div>';
    render({ document: { ...sampleDocument, content: [], pageLayout: { ...sampleDocument.pageLayout!, overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [{ id: "s", type: "text", x: -100, y: 200, rotation: 0, props: { w: 300, h: 80, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "123456" }] }] } }] } } } } });
    act(() => vi.advanceTimersByTime(200));
    expect(revealRegion).toHaveBeenCalledExactlyOnceWith({ x: -100, y: 200, w: 300, h: 80 });
  });
  it("finds inline math by its persistent model id", () => {
    canvas.innerHTML = '<p data-sigma-doc-id="p"><span data-sigma-doc-math-inline data-id="m" data-inline-math-field-id="react-id"></span></p>';
    expect(locationElements(canvas, { type: "inlineMath", blockId: "p", mathInlineId: "m" })).toEqual([canvas.querySelector("span")]);
  });
  it("does not clear a newer highlight from another action", () => {
    render(); act(() => vi.advanceTimersByTime(200));
    const listener = vi.fn(); window.addEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
    window.dispatchEvent(new CustomEvent(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, { detail: { anchors: [] } }));
    act(() => vi.advanceTimersByTime(4000));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, listener);
  });
});
