// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeOverlaySnapshot, type OverlayShape, type PageOverlay } from "@/features/document";
import { useConnectUnanchoredOnOpen } from "./use-connect-unanchored-on-open";

type Inputs = Parameters<typeof useConnectUnanchoredOnOpen>[0];
let root: Root;
let host: HTMLDivElement;
let inputs: Inputs;
const commit = vi.fn();
const shape = (id: string): OverlayShape => ({
  id, type: "geo", x: 400, y: 125, anchor: { type: "page" },
  props: { w: 80, h: 30, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" },
});
const overlay = (shapes: OverlayShape[]): PageOverlay => ({ overlaySnapshot: normalizeOverlaySnapshot({ version: 1, assets: {}, shapes }) });
function Probe() { useConnectUnanchoredOnOpen(inputs); return null; }
const render = () => act(async () => root.render(<Probe />));
const settle = () => act(async () => { vi.advanceTimersByTime(300); });

beforeEach(() => {
  vi.useFakeTimers(); commit.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  inputs = {
    docId: "first", enabled: true, paused: false,
    flowRef: { current: document.createElement("div") },
    blocks: [{ id: "body", top: 100, left: 40, width: 600, height: 100,
      lines: [{ index: 0, top: 100, left: 40, width: 600, height: 100 }] }],
    band: { pageStridePx: 1159, contentTopPx: 76, contentHeightPx: 971 },
    overlayRef: { current: overlay([shape("original")]) },
    onReanchorOverlayRef: { current: commit }, untouchableShapeIdsRef: { current: new Set() },
  };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
});

it("connects an original figure once after settling and keeps its coordinates", async () => {
  await render(); await settle();
  expect(commit).toHaveBeenCalledOnce();
  const result = inputs.overlayRef.current!.overlaySnapshot!.shapes[0];
  expect(result).toMatchObject({ x: 400, y: 125, anchor: { type: "block", blockId: "body" } });
  await render(); await settle(); expect(commit).toHaveBeenCalledOnce();
});

it("does not reanchor a figure inserted during the opening settle delay", async () => {
  await render();
  const inserted = shape("inserted");
  inputs.overlayRef.current = overlay([shape("original"), inserted]);
  await settle();
  const result = inputs.overlayRef.current!.overlaySnapshot!.shapes;
  expect(result[0].anchor).toMatchObject({ type: "block", blockId: "body" });
  expect(result[1]).toEqual(inserted);
});

it("does not treat a figure inserted while layout is filtered as an opening figure", async () => {
  inputs.paused = true; inputs.overlayRef.current = overlay([]);
  await render();
  const inserted = shape("inserted"); inputs.overlayRef.current = overlay([inserted]);
  inputs.paused = false; await render(); await settle();
  expect(inputs.overlayRef.current!.overlaySnapshot!.shapes).toEqual([inserted]);
  expect(commit).not.toHaveBeenCalled();
});

it("does not reanchor an opening figure moved by the user before settling", async () => {
  await render();
  const moved = { ...shape("original"), x: 460, y: 135 };
  inputs.overlayRef.current = overlay([moved]);
  await settle();
  expect(inputs.overlayRef.current!.overlaySnapshot!.shapes).toEqual([moved]);
  expect(commit).not.toHaveBeenCalled();
});

it("does not overwrite an anchor changed by the user while the pass is paused", async () => {
  inputs.paused = true;
  inputs.overlayRef.current = overlay([{ ...shape("original"), anchor: undefined }]);
  await render();
  const fixed = shape("original"); inputs.overlayRef.current = overlay([fixed]);
  inputs.paused = false; await render(); await settle();
  expect(inputs.overlayRef.current!.overlaySnapshot!.shapes).toEqual([fixed]);
  expect(commit).not.toHaveBeenCalled();
});

for (const edit of ["move", "insert", "delete", "reparent"] as const) {
  it(`preserves the whole group after a member ${edit} during the delay`, async () => {
    const group = (id: string, parentId?: string): OverlayShape => ({
      id, type: "group", x: 400, y: 125, parentId, anchor: { type: "page" }, props: { w: 80, h: 50 },
    });
    const outer = group("outer"); const inner = group("inner", "outer");
    const member = { ...shape("member"), parentId: "inner" };
    const sibling = { ...shape("sibling"), parentId: "inner" };
    inputs.overlayRef.current = overlay([outer, inner, member, sibling]);
    await render();
    const edited = edit === "move"
      ? [outer, inner, { ...member, y: 135 }, sibling]
      : edit === "insert"
        ? [outer, inner, member, sibling, { ...shape("inserted"), parentId: "inner" }]
        : edit === "delete"
          ? [outer, inner, sibling]
          : [outer, inner, { ...member, parentId: "outer" }, sibling];
    const editedOverlay = overlay(edited);
    inputs.overlayRef.current = editedOverlay;
    await settle();
    expect(inputs.overlayRef.current!.overlaySnapshot!.shapes).toEqual(editedOverlay.overlaySnapshot!.shapes);
    expect(commit).not.toHaveBeenCalled();
  });
}

it("still connects an unchanged group and its members as one figure", async () => {
  inputs.overlayRef.current = overlay([
    { id: "group", type: "group", x: 400, y: 125, anchor: { type: "page" }, props: { w: 80, h: 50 } },
    { ...shape("member"), parentId: "group" },
    { ...shape("sibling"), y: 145, parentId: "group" },
  ]);
  await render(); await settle();
  expect(commit).toHaveBeenCalledOnce();
  for (const item of inputs.overlayRef.current!.overlaySnapshot!.shapes) {
    expect(item.anchor).toMatchObject({ type: "block", blockId: "body" });
  }
});

it("cancels a pending document pass on unmount", async () => {
  await render(); await act(async () => root.unmount());
  root = createRoot(host); await settle(); expect(commit).not.toHaveBeenCalled();
});
