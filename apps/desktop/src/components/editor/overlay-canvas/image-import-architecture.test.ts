import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../../tests/helpers/source-dependencies";

describe("overlay image import boundaries", () => {
  it("keeps the import session independent of browser decoding and canvas state", () => {
    const source = readFileSync(new URL("image-import-session.ts", import.meta.url), "utf8");
    expect(getModuleSpecifiers(source).filter((name) => !["@/features/document", "@/features/drawing"].includes(name))).toEqual([]);
    expect(source).not.toMatch(/\b(?:window|document)\s*\.|\bnew\s+(?:Image|FileReader)\b/);
  });

  it("keeps file decoding independent of the canvas controller and persistence", () => {
    const source = readFileSync(new URL("image-file.ts", import.meta.url), "utf8");
    expect(getModuleSpecifiers(source).filter((name) => !["@/features/document", "@/features/drawing", "@/lib/svg-image-source", "./ids"].includes(name))).toEqual([]);
    const svgSource = readFileSync(new URL("../../../lib/svg-image-source.ts", import.meta.url), "utf8");
    expect(getModuleSpecifiers(svgSource).filter((name) => !["fast-xml-parser", "@/features/drawing"].includes(name))).toEqual([]);
    expect(svgSource).not.toMatch(/\b(?:window|document|localStorage)\s*\.|\b(?:OverlaySnapshot|normalizeOverlayGroups|pruneUnusedOverlayAssets)\b/);
  });
});
