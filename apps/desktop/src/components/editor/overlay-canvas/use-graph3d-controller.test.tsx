// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SELECT_OVERLAY_GRAPH3D_EVENT,
  type SelectedOverlayGraph3D,
} from "@/components/editor/Graph3DSettingsPanel";
import { GRAPH3D_ANIMATION_PREVIEW_EVENT } from "@/components/editor/graph3d-animation-preview";
import type { Graph3DSpec, OverlayAsset, OverlayGraph3DShape, OverlayShape } from "@/features/document";
import { getGraph3DPreviewSourceHash } from "@/features/drawing";

import { useOverlayGraph3DController } from "./use-graph3d-controller";

const cleanups: Array<() => void | Promise<void>> = [];
const tShape = (key: "graph3d.animationFileName" | "graph3d.previewFileName") => `${key}.png`;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function graph(overrides: Partial<OverlayGraph3DShape> = {}): OverlayGraph3DShape {
  return {
    id: "graph",
    type: "graph3dShape",
    x: 40,
    y: 60,
    rotation: 0,
    props: {
      w: 240,
      h: 200,
      spec: {
        version: 1,
        parameters: [],
        objects: [
          { id: "cube", kind: "primitive", primitive: "box", center: { x: "0", y: "0", z: "0" }, size: { x: "2", y: "2", z: "2" } },
          { id: "sphere", kind: "primitive", primitive: "sphere", center: { x: "1", y: "1", z: "1" }, size: { x: "2", y: "2", z: "2" } },
        ],
        cuts: [],
        regions: [],
        annotations: [],
        camera: { projection: "perspective", position: { x: 4, y: 3, z: 5 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
        view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#ffffff" },
      },
    },
    ...overrides,
  };
}

function listen<T>(name: string): T[] {
  const details: T[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  cleanups.push(() => window.removeEventListener(name, listener));
  return details;
}

async function mount(source: OverlayGraph3DShape, options: { width?: number; height?: number; assets?: Record<string, OverlayAsset> } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  const initialShapes = [source];
  const initialAssets = options.assets ?? {};
  const shapesRef = { current: initialShapes as OverlayShape[] };
  const assetsRef = { current: initialAssets };
  const explicitlySavedShapeStatesRef = { current: new WeakSet<OverlayShape[]>() };
  const canvasWidthRef = { current: options.width ?? 800 };
  const canvasHeightRef = { current: options.height ?? 1000 };
  const queueOverlaySave = vi.fn();
  const transitionMode = vi.fn();
  let rendered: {
    controller: ReturnType<typeof useOverlayGraph3DController>;
    shapes: OverlayShape[];
    assets: Record<string, OverlayAsset>;
    selectedIds: string[];
    select: (ids: string[]) => void;
    replaceShapes: (shapes: OverlayShape[]) => void;
  };
  function Harness() {
    const [shapes, setShapes] = useState<OverlayShape[]>(initialShapes);
    const [assets, setAssets] = useState(initialAssets);
    const [selectedIds, setSelectedShapeIds] = useState([source.id]);
    const controller = useOverlayGraph3DController({
      shapes, selectedIds, shapesRef, assetsRef, setShapes, setAssets,
      explicitlySavedShapeStatesRef, canvasWidthRef, canvasHeightRef, imageInsertGap: 16,
      queueOverlaySave, setSelectedShapeIds, transitionMode, tShape,
    });
    rendered = {
      controller, shapes, assets, selectedIds, select: setSelectedShapeIds,
      replaceShapes: (next) => { shapesRef.current = next; setShapes(next); },
    };
    return null;
  }
  await act(async () => root.render(<Harness />));
  return {
    read: () => rendered,
    currentGraph: () => shapesRef.current.find((shape): shape is OverlayGraph3DShape => shape.id === source.id && shape.type === "graph3dShape")!,
    shapesRef, assetsRef, explicitlySavedShapeStatesRef, queueOverlaySave, transitionMode, unmount,
  };
}

function selected(details: Array<SelectedOverlayGraph3D | null>): SelectedOverlayGraph3D {
  const detail = details.at(-1);
  expect(detail).not.toBeNull();
  return detail!;
}

describe("Graph3D canvas controller", () => {
  it("updates the current spec through stable renderer callbacks and preserves other objects and geometry", async () => {
    const details = listen<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT);
    const source = graph({ anchor: { type: "block", blockId: "paragraph", dx: 12, dy: 20 } });
    const harness = await mount(source);
    const originalCallbacks = harness.read().controller;
    const nextSpec: Graph3DSpec = { ...source.props.spec, view: { ...source.props.spec.view, showGrid: false } };
    await act(async () => selected(details).onSpecChange(nextSpec, { save: false }));
    expect(harness.queueOverlaySave).not.toHaveBeenCalled();
    expect(harness.currentGraph()).toEqual({ ...source, props: { ...source.props, spec: nextSpec } });

    const camera = { ...nextSpec.camera, zoom: 2 };
    await act(async () => originalCallbacks.handleGraph3DCameraChange(source.id, camera));
    const rotation = { x: "10", y: "20", z: "30" };
    await act(async () => originalCallbacks.handleGraph3DObjectRotationChange(source.id, "cube", rotation));
    const translation = { x: "1", y: "2", z: "3" };
    await act(async () => originalCallbacks.handleGraph3DObjectTransformChange(source.id, "cube", { translation }));

    const current = harness.currentGraph();
    expect(current.props.spec.camera).toEqual(camera);
    expect(current.props.spec.view.showGrid).toBe(false);
    expect(current.props.spec.objects[0]).toMatchObject({ rotation, translation });
    expect(current.props.spec.objects[1]).toBe(source.props.spec.objects[1]);
    expect({ ...current, props: source.props }).toEqual(source);
    expect(harness.queueOverlaySave.mock.calls).toEqual([[], [], []]);
    for (const key of Object.keys(originalCallbacks) as Array<keyof typeof originalCallbacks>) {
      expect(harness.read().controller[key]).toBe(originalCallbacks[key]);
    }
  });

  it("rejects a late bitmap after the spec changes, then saves the matching preview as a coalesced edit", async () => {
    const details = listen<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT);
    const source = graph();
    const harness = await mount(source);
    const oldHash = getGraph3DPreviewSourceHash(source.props.spec);
    const nextSpec = { ...source.props.spec, camera: { ...source.props.spec.camera, zoom: 3 } };
    await act(async () => selected(details).onSpecChange(nextSpec, { save: false }));
    const before = harness.read();
    const previewReady = before.controller.handleGraph3DPreviewReady;
    await act(async () => previewReady(source.id, "data:image/png;base64,AAAA", { width: 719.7, height: 600.2 }, oldHash, { animated: true }));
    expect(harness.read().shapes).toBe(before.shapes);
    expect(harness.read().assets).toBe(before.assets);
    expect(harness.queueOverlaySave).not.toHaveBeenCalled();

    const hash = getGraph3DPreviewSourceHash(nextSpec);
    await act(async () => previewReady(source.id, "data:image/png;base64,AAAA", { width: 719.7, height: 600.2 }, hash, { animated: true }));
    const current = harness.currentGraph();
    const asset = harness.assetsRef.current[current.props.previewAssetId!];
    expect(current.props).toMatchObject({ w: 240, h: 200, spec: nextSpec, previewAssetId: "asset_graph3d_preview_graph", previewSourceHash: hash });
    expect(asset).toEqual({
      id: "asset_graph3d_preview_graph", type: "image",
      props: { w: 720, h: 600, name: "graph3d.animationFileName.png", isAnimated: true, mimeType: "image/png", src: "data:image/png;base64,AAAA", fileSize: 3 },
    });
    expect(harness.explicitlySavedShapeStatesRef.current.has(harness.read().shapes)).toBe(true);
    expect(harness.queueOverlaySave.mock.calls).toEqual([[{ history: "coalesce" }]]);
    const saved = JSON.parse(JSON.stringify({ shapes: harness.read().shapes, assets: harness.read().assets }));
    expect(saved.assets[saved.shapes[0].props.previewAssetId]).toEqual(asset);
    await act(async () => previewReady(source.id, asset.props.src, { width: 720, height: 600 }, hash, { animated: true }));
    expect(harness.queueOverlaySave).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing preview asset without changing its shape's document dimensions", async () => {
    const source = graph();
    source.props.previewAssetId = "existing-preview";
    const harness = await mount(source);
    await act(async () => harness.read().controller.handleGraph3DPreviewReady(
      source.id, "data:image/png;base64,AA", { width: 0.4, height: 0 }, getGraph3DPreviewSourceHash(source.props.spec), { animated: false },
    ));
    expect(Object.keys(harness.read().assets)).toEqual(["existing-preview"]);
    expect(harness.read().assets["existing-preview"].props).toMatchObject({ w: 1, h: 1, name: "graph3d.previewFileName.png", isAnimated: false });
    expect(harness.currentGraph().props).toMatchObject({ w: 240, h: 200 });
  });

  it.each([
    { name: "beside", width: 800, x: 296, y: 60, dx: 268, dy: 20, lineDy: 7 },
    { name: "below with horizontal clamp", width: 300, x: 0, y: 276, dx: -28, dy: 236, lineDy: 223 },
  ])("inserts a derived image $name with matching block and line offsets", async ({ width, x, y, dx, dy, lineDy }) => {
    const details = listen<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT);
    const source = graph({ anchor: { type: "block", blockId: "paragraph", dx: 12, dy: 20, line: { index: 2, dy: 7 } } });
    const harness = await mount(source, { width, height: 100 });
    await act(async () => selected(details).onInsertImage({ dataUrl: "data:image/svg+xml,svg", width: 300, height: 80, name: "section.svg" }));
    const inserted = harness.read().shapes.find((shape) => shape.id !== source.id)!;
    expect(inserted).toMatchObject({ type: "image", x, y, rotation: 0, props: { w: 300, h: 80 }, anchor: { type: "block", blockId: "paragraph", dx, dy, line: { index: 2, dy: lineDy } } });
    if (inserted.type !== "image") throw new Error("Expected inserted image");
    expect(harness.read().assets[inserted.props.assetId].props).toEqual({ w: 300, h: 80, name: "section.svg", isAnimated: false, mimeType: "image/svg+xml", src: "data:image/svg+xml,svg", fileSize: 22 });
    expect(harness.read().selectedIds).toEqual([inserted.id]);
    expect(harness.transitionMode.mock.calls).toEqual([[{ type: "select" }]]);
    expect(harness.queueOverlaySave.mock.calls).toEqual([[]]);
    expect(details.at(-1)).toBeNull();
  });

  it("preserves an omitted horizontal block offset and clamps unanchored derived specs to the page", async () => {
    const details = listen<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT);
    const source = graph({ anchor: { type: "block", blockId: "paragraph", dy: 20 } });
    const harness = await mount(source, { width: 300, height: 300 });
    const spec = { ...source.props.spec, objects: [] };
    await act(async () => selected(details).onInsertSpec(spec));
    const inserted = harness.read().shapes.find((shape) => shape.id !== source.id)!;
    expect(inserted).toMatchObject({ type: "graph3dShape", x: 40, y: 276, props: { w: 240, h: 200, spec }, anchor: { type: "block", blockId: "paragraph", dy: 236 } });
    expect(inserted.anchor).not.toHaveProperty("dx");
    expect(selected(details).shapeId).toBe(inserted.id);

    await act(async () => harness.read().replaceShapes([graph()]));
    await act(async () => harness.read().select([source.id]));
    await act(async () => selected(details).onInsertSpec(spec));
    const unanchored = harness.read().shapes.find((shape) => shape.id !== source.id)!;
    expect(unanchored).toMatchObject({ x: 40, y: 100, props: { w: 240, h: 200, spec } });
    expect(unanchored).not.toHaveProperty("anchor");
  });

  it("publishes settings and animation events, clears selection and unmount state, and ignores deleted sources", async () => {
    const details = listen<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT);
    const previews = listen(GRAPH3D_ANIMATION_PREVIEW_EVENT);
    const source = graph();
    const harness = await mount(source);
    const detail = selected(details);
    expect(detail).toMatchObject({ shapeId: source.id, spec: source.props.spec, size: { width: 240, height: 200 } });
    detail.onAnimationPreview({ t: 0.5 }, true);
    expect(previews).toEqual([{ shapeId: source.id, overrides: { t: 0.5 }, playing: true }]);
    await act(async () => detail.onClose());
    expect(harness.read().selectedIds).toEqual([]);
    expect(details.at(-1)).toBeNull();
    await act(async () => harness.read().select([source.id, "another-shape"]));
    expect(details.at(-1)).toBeNull();
    await act(async () => harness.read().select([source.id]));
    expect(selected(details).shapeId).toBe(source.id);
    await act(async () => harness.read().replaceShapes([]));
    const callbacks = harness.read().controller;
    await act(async () => {
      callbacks.handleGraph3DCameraChange(source.id, source.props.spec.camera);
      callbacks.handleGraph3DObjectRotationChange(source.id, "cube", { x: "0", y: "0", z: "0" });
      callbacks.handleGraph3DObjectTransformChange(source.id, "cube", { scale: { x: "2", y: "2", z: "2" } });
      callbacks.handleGraph3DPreviewReady(source.id, "data:image/png;base64,AAAA", { width: 100, height: 100 }, getGraph3DPreviewSourceHash(source.props.spec), { animated: false });
      detail.onInsertSpec(source.props.spec);
      detail.onInsertImage({ dataUrl: "svg", width: 100, height: 100, name: "part.svg" });
    });
    expect(harness.read().shapes).toEqual([]);
    expect(harness.read().assets).toEqual({});
    expect(harness.queueOverlaySave).not.toHaveBeenCalled();
    const count = details.length;
    await harness.unmount();
    expect(details.slice(count)).toEqual([null]);
  });
});
