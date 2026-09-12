import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Graph3DContentToolInputSchema,
  Graph3DSpecInputSchema,
  Graph3DToolInputSchema,
} from "./sigma-doc-mcp-server-core";
import { createGraph3DSpecPreset, type Graph3DPresetNames } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";
import type { Graph3DPreset } from "@/features/document";

const PRESET_NAMES: Graph3DPresetNames = buildGraph3DPresetNames(createTranslator("ja", "shape"));
const PRESETS: Graph3DPreset[] = ["revolution", "surface", "tricylinder", "sphereTetrahedron", "blank"];

const ContentSchema = z.object(Graph3DContentToolInputSchema).strict();
const ToolSchema = z.object(Graph3DToolInputSchema).strict();

describe("Graph3D MCP input schema", () => {
  it.each(PRESETS)("accepts the drawn parts of the %s preset", (preset) => {
    const { version, cuts, ...drawn } = createGraph3DSpecPreset(preset, PRESET_NAMES);
    expect(version).toBe(1);
    expect(cuts).toEqual([]);

    const parsed = Graph3DSpecInputSchema.safeParse(drawn);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("does not expose cuts", () => {
    const spec = createGraph3DSpecPreset("revolution", PRESET_NAMES);
    const withCuts: Record<string, unknown> = { ...spec };
    delete withCuts.version;

    expect(Graph3DSpecInputSchema.safeParse(withCuts).success).toBe(false);
    expect(ContentSchema.safeParse({ cuts: [] }).success).toBe(false);
  });

  it("does not expose section or inequality regions", () => {
    expect(ContentSchema.safeParse({
      regions: [{ id: "region_section", kind: "section", cutId: "cut_1", fill: { mode: "none" } }],
    }).success).toBe(false);
    expect(ContentSchema.safeParse({
      regions: [{
        id: "region_inequality",
        kind: "inequality",
        inequalities: ["x >= 0"],
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        fill: { mode: "none" },
      }],
    }).success).toBe(false);
    expect(ContentSchema.safeParse({
      regions: [{
        id: "region_common",
        kind: "objectIntersection",
        objectIds: ["a", "b"],
        fill: { mode: "solid", color: "#1d4ed8", opacity: 0.4 },
      }],
    }).success).toBe(true);
  });

  it("rejects an unknown object kind", () => {
    expect(ContentSchema.safeParse({ objects: [{ id: "broken", kind: "notAKind" }] }).success).toBe(false);
  });

  it("takes rotation as radian expressions, never as degrees", () => {
    const parsed = ContentSchema.safeParse({
      objects: [{
        id: "turned",
        kind: "primitive",
        primitive: "box",
        center: { x: "0", y: "0", z: "0" },
        size: { x: "1", y: "1", z: "1" },
        rotation: { x: "0", y: "pi/2", z: "t" },
      }],
    });

    expect(parsed.success).toBe(true);
    expect(ContentSchema.safeParse({
      objects: [{
        id: "turned",
        kind: "primitive",
        primitive: "box",
        center: { x: "0", y: "0", z: "0" },
        size: { x: "1", y: "1", z: "1" },
        rotation: { x: 0, y: 90, z: 0 },
      }],
    }).success).toBe(false);
  });

  it("takes camera and view as partial patches", () => {
    expect(ContentSchema.safeParse({ camera: { position: { x: 1, y: 1, z: 1 } } }).success).toBe(true);
    expect(ContentSchema.safeParse({ view: { showGrid: false } }).success).toBe(true);
    expect(ContentSchema.safeParse({ camera: { position: { x: 1, y: 1 } } }).success).toBe(false);
    expect(ContentSchema.safeParse({ view: { showGrid: "no" } }).success).toBe(false);
  });

  it("keeps the five presets and the shared overlay placement fields on the tool schema", () => {
    const parsed = ToolSchema.safeParse({
      area: "solution",
      id: "graph3d_1",
      x: 120,
      y: 240,
      w: 360,
      h: 280,
      preset: "tricylinder",
    });

    expect(parsed.success).toBe(true);
    for (const preset of PRESETS) {
      expect(ToolSchema.safeParse({ preset }).success).toBe(true);
    }
    expect(ToolSchema.safeParse({ preset: "notAPreset" }).success).toBe(false);
  });

  it("bounds sampling density so a single call cannot ask for an unbounded march", () => {
    const boundedSolid = (resolution: number) => ({
      objects: [{
        id: "solid",
        kind: "boundedSolid",
        inequalities: ["x >= 0"],
        bounds: {
          x: { min: "0", max: "1" },
          y: { min: "0", max: "1" },
          z: { min: "0", max: "1" },
        },
        resolution,
      }],
    });

    expect(ContentSchema.safeParse(boundedSolid(48)).success).toBe(true);
    expect(ContentSchema.safeParse(boundedSolid(257)).success).toBe(false);
    expect(ContentSchema.safeParse(boundedSolid(3)).success).toBe(false);
  });
});
