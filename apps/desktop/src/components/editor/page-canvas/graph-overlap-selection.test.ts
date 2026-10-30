import { expect, it } from "vitest";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import type { OverlayShape } from "@/features/document";
import { getTopmostBodyModeOverlayHit } from "./overlay-anchor-materialization";

const graph: OverlayShape = { id: "graph", type: "graph2dShape", x: 0, y: 0, props: { boundsMode: "plot", w: 200, h: 200, spec: createGraph2DSpecPreset("blank") } };
const fill: OverlayShape = { id: "fill", type: "line", x: 10, y: 10, props: { color: "#000000", fill: "solid", fillColor: "#000000", labelColor: "#000000", dash: "solid", size: "s", kind: "polyline", closed: true, points: [{x:0,y:0},{x:40,y:0},{x:20,y:40}] } };
it("selects an underlying filled polygon through a graph's unpainted plot area", () => {
  expect(getTopmostBodyModeOverlayHit([fill, graph], { x:30,y:20 }, () => false)?.id).toBe("fill");
});
it("keeps the graph above the polygon where its curve is painted", () => {
  expect(getTopmostBodyModeOverlayHit([fill, graph], { x:30,y:20 }, () => true)?.id).toBe("graph");
});
it("still permits selecting a standalone graph by its empty plot area", () => {
  expect(getTopmostBodyModeOverlayHit([graph], { x:30,y:20 }, () => false)?.id).toBe("graph");
});
it("does not select either object beyond its plot or polygon", () => {
  expect(getTopmostBodyModeOverlayHit([fill, graph], { x:300,y:300 }, () => false)).toBeNull();
});
