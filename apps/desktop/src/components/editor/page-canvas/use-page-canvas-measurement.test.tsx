// @vitest-environment happy-dom
import { ensurePageLayout,getPageMetrics } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import { act,StrictMode,useLayoutEffect } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { acknowledgeTextFlowContent,expectTextFlowContent } from "../text-flow/measurement-revision";
import { SpaceAfterDragSession } from "./space-after-drag-session";
import { usePageCanvasMeasurement } from "./use-page-canvas-measurement";

type Inputs = Parameters<typeof usePageCanvasMeasurement>[0];
let root: Root;
let owner: ReturnType<typeof usePageCanvasMeasurement>;
let inputs: Inputs;
let flow: HTMLDivElement;
let editor: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let resolveFonts: () => void;
let fonts: EventTarget & { ready: Promise<void> };
let nextFrame = 0;
const observers: Observer[] = [];
class Observer {
  disconnected = false;
  observe = vi.fn(); unobserve = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
  disconnect() { this.disconnected = true; }
}
function Probe({ value }: { value: Inputs }) {
  const current = usePageCanvasMeasurement(value);
  useLayoutEffect(() => { owner = current; });
  return null;
}
function render() { root.render(<StrictMode><Probe value={inputs} /></StrictMode>); }
async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  });
}
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map(); observers.length = 0;
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(resolve => { resolveFonts = resolve; }) });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const pageDocument = ensurePageLayout(createBlankDocument()); pageDocument.docId = "first";
  flow = document.createElement("div"); editor = document.createElement("div"); editor.className = "ProseMirror"; flow.append(editor); document.body.append(flow);
  flow.getBoundingClientRect = () => new DOMRect(0, 0, 500, 100);
  inputs = {
    content: { pageDocument, units: [], historyRevision: 0, overlay: {}, overlaySource: undefined, pendingDeletion: null, onReanchorOverlay: vi.fn() },
    geometry: { metrics: getPageMetrics(pageDocument.pageLayout!), zoom: 100, fontSize: 16, isWhiteboard: false, isPagedRender: false },
    surface: { flowRef: { current: flow }, canvasRef: { current: flow }, flowElement: flow },
    spaceAfter: { spaceAfterSessionRef: { current: new SpaceAfterDragSession() }, setSpaceAfterDrag: vi.fn(), setBlockAffordance: vi.fn() },
  };
  root = createRoot(document.createElement("div")); await act(async () => render()); await flushFrames();
});
afterEach(async () => { await act(async () => root.unmount()); flow.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not adopt a different document until the live text surface acknowledges its revision", async () => {
  expect(owner.layoutViewState.input?.documentId).toBe("first");
  expectTextFlowContent(editor, "first"); acknowledgeTextFlowContent(editor, "first");
  expectTextFlowContent(editor, "second");
  inputs = { ...inputs, content: { ...inputs.content, pageDocument: { ...inputs.content.pageDocument, docId: "second", content: [] } } };
  await act(async () => render()); await flushFrames();
  expect(owner.layoutViewState.input?.documentId).toBe("first");
  await act(async () => acknowledgeTextFlowContent(editor, "second")); await flushFrames();
  expect(owner.layoutViewState.input?.documentId).toBe("second");
  expect(observers.filter(observer => !observer.disconnected)).toHaveLength(1);
});

it("cancels its scheduled frame, disconnects observers, and invalidates pending font completion on unmount", async () => {
  const live = observers.find(observer => !observer.disconnected)!;
  await act(async () => live.callback([], live as unknown as ResizeObserver));
  expect(frames.size).toBe(1);
  const revision = owner.layoutViewState.revision;
  await act(async () => root.unmount());
  expect(frames.size).toBe(0); expect(observers.every(observer => observer.disconnected)).toBe(true);
  await act(async () => { resolveFonts(); await fonts.ready; fonts.dispatchEvent(new Event("loadingdone")); });
  expect(frames.size).toBe(0); expect(owner.layoutViewState.revision).toBe(revision);
});

it("keeps a frozen baseline refresh pending until thaw and measures the latest document", async () => {
  const session = inputs.spaceAfter.spaceAfterSessionRef.current;
  session.beginCommit({ blockId: "block", px: 20, deltaPx: 10, bottomBefore: 50 });
  inputs = { ...inputs, content: { ...inputs.content, pageDocument: { ...inputs.content.pageDocument, docId: "after-drag", content: [] } } };
  await act(async () => render());
  expect(frames.size).toBe(0);
  session.cancel(); await act(async () => owner.thawSpaceAfterRecompute()); await flushFrames();
  expect(owner.layoutViewState.input?.documentId).toBe("after-drag");
});
