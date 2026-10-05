// @vitest-environment happy-dom
import type { PageOverlay } from "@/features/document";
import type { Editor } from "@tiptap/core";
import { act, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlayChangeOptions, OverlaySelectionStylePatch } from "../page-overlay-types";
import { FLUSH_OVERLAY_CHANGES_EVENT } from "../page-overlay-types";
import { createInitialOverlayInteractionMode, overlayInteractionModeReducer, type OverlayInteractionAction } from "./interaction-mode";
import type { OverlayShape } from "./types";
import { useDocumentSnapshotSync } from "./use-document-snapshot-sync";
import { useOverlayMutations } from "./use-overlay-mutations";
import { useOverlaySaveController } from "./use-overlay-save-controller";
import { useOverlaySaveEffects } from "./use-overlay-save-effects";
import { useOverlaySnapshotState } from "./use-snapshot-state";

const shape: OverlayShape = { id: "text", type: "text", x: 10, y: 20, props: { w: 220, h: 16, color: "black", size: "m", blocks: [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text: "A" }] }] } };
function overlay(shapes: OverlayShape[]): PageOverlay { return { overlaySnapshot: { version: 1, shapes, assets: {} } }; }
function harness() {
  let api!: ReturnType<typeof useOverlaySnapshotState> & ReturnType<typeof useOverlaySaveController> & ReturnType<typeof useOverlayMutations> & { transitionMode(action: OverlayInteractionAction): void };
  const host = document.createElement("div"); const root = createRoot(host); const changed = vi.fn<(overlay: PageOverlay, options?: OverlayChangeOptions) => void>();
  function Harness({ source, revision = 0 }: { source: PageOverlay; revision?: number }) {
    const state = useOverlaySnapshotState({ overlay: source, canvasWidth: 800, canvasHeight: 600, documentId: "doc", externalRevision: revision, onChange: changed });
    const canvasRef = useRef<HTMLDivElement | null>(null);
    const save = useOverlaySaveController({ ...state, canvasRef, syncBlockAnchors: false, getBlockAnchorScope: useCallback(() => null, []), getLastDrawnBlockRects: useCallback(() => null, []) });
    const [mode, setMode] = useState(createInitialOverlayInteractionMode); const modeRef = useRef(mode);
    const transitionMode = useCallback((action: OverlayInteractionAction) => { modeRef.current = overlayInteractionModeReducer(modeRef.current, action); setMode(modeRef.current); }, []);
    const [selectedIds, setSelectedIds] = useState<string[]>([]); const selectedIdsRef = useRef(selectedIds);
    const [, setPreview] = useState<{ style: OverlaySelectionStylePatch; targetIds: Set<string> } | null>(null);
    const [, setAppliedSnapshotRevision] = useState(0); const [, setRegionSelection] = useState<{ documentId: string | undefined; revision: number; bounds: { x: number; y: number; w: number; h: number } } | null>(null);
    const activeTextEditorRef = useRef<Editor | null>(null); const focusedGroupIdRef = useRef<string | null>(null); const anchorMeasurementsRef = useRef({ rects: new Map(), ordered: [] });
    useDocumentSnapshotSync({ ...state, ...save, setPreview, modeRef, selectedIdsRef, setSelectedIds, setAppliedSnapshotRevision, transitionMode, activeTextEditorRef, overlay: source, externalRevision: revision, mode });
    useOverlaySaveEffects({ ...state, ...save });
    const mutations = useOverlayMutations({ ...state, ...save, setRegionSelection, modeRef, selectedIdsRef, setSelectedIds, focusedGroupIdRef, transitionMode, activeTextEditorRef, anchorMeasurementsRef, onSelectedCountChange: undefined });
    api = { ...state, ...save, ...mutations, transitionMode };
    return <div data-shapes={JSON.stringify(state.shapes)} />;
  }
  return { root, host, changed, current: () => api, render: async (source: PageOverlay, revision = 0, key = "mounted") => { await act(async () => root.render(<Harness key={key} source={source} revision={revision} />)); } };
}
beforeEach(() => { vi.useFakeTimers(); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => vi.useRealTimers());

describe("overlay derived session and single save boundary", () => {
  it("commits each text edit once, preserves undo granularity and reloads the saved snapshot", async () => {
    const h = harness(); await h.render(overlay([shape]));
    for (const text of ["AB", "ABC"]) {
      await act(async () => h.current().updateShape({ id: shape.id, type: "text", props: { blocks: [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text }] }] } }, { commit: true }));
    }
    expect(h.changed).toHaveBeenCalledTimes(2);
    expect(h.changed.mock.calls.map(call => call[1])).toEqual([{ history: "record" }, { history: "record" }]);
    await act(async () => vi.advanceTimersByTime(500)); expect(h.changed).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(JSON.stringify(h.changed.mock.calls[1][0])) as PageOverlay;
    await h.render(saved, 0, "reloaded"); expect(h.current().shapes).toEqual(saved.overlaySnapshot!.shapes);
    await act(async () => h.root.unmount()); expect(h.changed).toHaveBeenCalledTimes(2);
  });
  it("closes mixed paste history at its commit and does not attach its key to the next edit", async () => {
    const h = harness(); await h.render(overlay([shape]));
    await act(async () => { h.current().queueOverlaySave({ history: "coalesce" }); h.current().pendingOverlaySaveHistoryGroupRef.current = "mixed-paste"; const next = [{ ...shape, x: 30 }]; h.current().shapesRef.current = next; h.current().setShapes(next); });
    expect(h.changed).toHaveBeenCalledTimes(1); expect(h.changed.mock.calls[0][1]).toEqual({ history: "record", historyGroup: "mixed-paste" });
    await act(async () => h.current().updateShape({ id: shape.id, type: "text", x: 40 }, { commit: true }));
    expect(h.changed.mock.calls[1][1]).toEqual({ history: "record" });
    await act(async () => h.root.unmount());
  });
  it("adopts external same-revision changes and defers them while an editing mode is active", async () => {
    const h = harness(); await h.render(overlay([shape]));
    await act(async () => h.current().transitionMode({ type: "editText", shapeId: shape.id }));
    const external = overlay([{ ...shape, x: 90 }]); await h.render(external);
    expect(h.current().shapes[0].x).toBe(10);
    await act(async () => h.current().transitionMode({ type: "select" })); expect(h.current().shapes[0].x).toBe(90);
    expect(h.changed).not.toHaveBeenCalled();
    await h.render(overlay([{ ...shape, x: 120 }]), 1); expect(h.current().shapes[0].x).toBe(120); expect(h.changed).not.toHaveBeenCalled();
    await act(async () => h.root.unmount());
  });
  it("flushes a queued edit once on unmount and removes its flush event listener", async () => {
    const h = harness(); await h.render(overlay([shape]));
    await act(async () => h.current().updateShape({ id: shape.id, type: "text", x: 50 }));
    expect(h.changed).not.toHaveBeenCalled(); await act(async () => h.root.unmount()); expect(h.changed).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event(FLUSH_OVERLAY_CHANGES_EVENT)); await act(async () => vi.advanceTimersByTime(500)); expect(h.changed).toHaveBeenCalledOnce();
    expect(h.changed.mock.calls[0][0].overlaySnapshot!.shapes[0].x).toBe(50);
  });
});
