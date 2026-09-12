import { describe, expect, it } from "vitest";

import type { Graph3DPreset } from "@/features/document";
import { isGraph3DSpec } from "@/features/document";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";

import { buildGraph3DSceneGeometry } from "./graph3d-scene";
import { createGraph3DSpecPreset } from "./graph3d-presets";
import { getGraph3DIntersectionMesh } from "./graph3d-solid";

const PRESETS: Graph3DPreset[] = [
  "revolution",
  "surface",
  "tricylinder",
  "sphereTetrahedron",
  "blank",
];
const PRESET_NAMES = buildGraph3DPresetNames(createTranslator("ja", "shape"));

describe("createGraph3DSpecPreset", () => {
  it.each(PRESETS)("stores %s as a valid spec", (preset) => {
    expect(isGraph3DSpec(createGraph3DSpecPreset(preset, PRESET_NAMES))).toBe(true);
  });

  it.each(PRESETS)("builds %s without a single failing object, region or label", (preset) => {
    const scene = buildGraph3DSceneGeometry(createGraph3DSpecPreset(preset, PRESET_NAMES));
    expect(scene.issues).toEqual([]);
  });

  it.each(PRESETS.filter((preset) => preset !== "blank"))("draws something for %s", (preset) => {
    const spec = createGraph3DSpecPreset(preset, PRESET_NAMES);
    const scene = buildGraph3DSceneGeometry(spec);
    expect(scene.objects.length).toBe(spec.objects.length);
    for (const object of scene.objects) {
      expect(object.geometry.positions.length).toBeGreaterThan(0);
    }
  });

  it.each(PRESETS)("leaves no common part of %s empty", (preset) => {
    const scene = buildGraph3DSceneGeometry(createGraph3DSpecPreset(preset, PRESET_NAMES));
    const drawn = scene.intersections.map((intersection) => ({
      region: intersection.regionId,
      empty: (getGraph3DIntersectionMesh(intersection.geometry)?.positions.length ?? 0) === 0,
    }));
    expect(drawn.filter((intersection) => intersection.empty)).toEqual([]);
  });

  it.each(PRESETS)("keeps every declared common part of %s in the built scene", (preset) => {
    const spec = createGraph3DSpecPreset(preset, PRESET_NAMES);
    const scene = buildGraph3DSceneGeometry(spec);
    expect(scene.intersections.map((intersection) => intersection.regionId))
      .toEqual(spec.regions.map((region) => region.id));
  });

  it("keeps every region pointed at objects the template actually defines", () => {
    for (const preset of PRESETS) {
      const spec = createGraph3DSpecPreset(preset, PRESET_NAMES);
      const ids = new Set(spec.objects.map((object) => object.id));
      for (const region of spec.regions) {
        if (region.kind !== "objectIntersection") continue;
        expect(region.objectIds.filter((id) => !ids.has(id))).toEqual([]);
        expect(region.objectIds.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("only mentions parameters the template declares", () => {
    for (const preset of PRESETS) {
      const spec = createGraph3DSpecPreset(preset, PRESET_NAMES);
      const declared = spec.parameters.map((parameter) => parameter.name);
      const source = JSON.stringify({ objects: spec.objects, annotations: spec.annotations });
      for (const name of declared) {
        // A slider nothing reads is a template promising motion it cannot deliver.
        expect(new RegExp(`\\b${name}\\b`, "u").test(source)).toBe(true);
      }
    }
  });
});
