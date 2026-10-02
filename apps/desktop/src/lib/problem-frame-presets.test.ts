import { describe, expect, it } from "vitest";

import { isCanonicalFrameSvg, readSvgViewBox } from "@/features/document";
import { createTranslator } from "@/lib/i18n/translator";

import { PROBLEM_FRAME_PRESETS } from "./problem-frame-presets";

describe("problem frame presets", () => {
  it("are canonical drawings on the 160 x 100 canvas with corners that leave a stretchable middle", () => {
    const ids = PROBLEM_FRAME_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROBLEM_FRAME_PRESETS) {
      expect(isCanonicalFrameSvg(preset.drawing.svg)).toBe(true);
      expect(readSvgViewBox(preset.drawing.svg)).toMatchObject({ width: 160, height: 100 });
      expect(preset.slice).toBe(24);
    }
  });

  it("has a name in both languages", () => {
    for (const locale of ["ja", "en"] as const) {
      const t = createTranslator(locale, "settings");
      for (const preset of PROBLEM_FRAME_PRESETS) {
        expect(t(preset.labelKey), `${locale}: ${preset.id}`).not.toBe(preset.labelKey);
      }
    }
  });

  it("scoops the dotted frame's corners and keeps the outline's stroke inside the corner pieces", () => {
    const preset = PROBLEM_FRAME_PRESETS.find((candidate) => candidate.id === "scooped-dotted");
    expect(preset).toBeDefined();
    // A scoop ends 1.5 units short of the slice line at 24 (a little over half the 2.4 stroke), so the
    // stroke stays in the corner piece; past it, the stroke would be stretched along with the edge.
    const arcEnds = [...preset!.drawing.svg.matchAll(/A21 21 0 0 0 ([\d.]+) ([\d.]+)/g)]
      .map((match) => `${match[1]} ${match[2]}`);
    expect(arcEnds).toEqual(["158.5 22.5", "137.5 98.5", "1.5 77.5", "22.5 1.5"]);
  });
});
