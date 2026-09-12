import JSZip from "jszip";
import { PptxHandler } from "pptx-viewer-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  comparePptxImportFidelity,
  formatPptxFidelityReport,
  measurePptxImportFidelity,
  readPptxSourceOutline,
  runPptxFidelitySuite,
  type PptxFidelityDiscrepancy,
  type PptxSourceObject,
  type PptxSourceOutline,
} from "@/lib/powerpoint-fidelity";
import { importPowerPointPptxBuffer } from "@/lib/powerpoint-import";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { getPageMetrics, PAGE_GAP_PX } from "@/features/document";
import type { OverlayShape, PageLayout, SigmaDocument } from "@/features/document";

afterEach(() => {
  vi.restoreAllMocks();
});

// 12192000 x 6858000 EMU = 1280 x 720 px at 96dpi (16:9 widescreen).
const SLIDE_W_EMU = 12192000;
const SLIDE_H_EMU = 6858000;
const EMU_PER_PX = 9525;
const EMU_PER_MM = 36000;

function emuToPx(emu: number): number {
  return emu / EMU_PER_PX;
}

function sourceObject(overrides: Partial<PptxSourceObject> & { name: string }): PptxSourceObject {
  return {
    slideIndex: 0,
    zIndex: 0,
    tag: "p:sp",
    topLevel: true,
    hidden: false,
    isPlaceholder: false,
    flipH: false,
    flipV: false,
    text: "",
    explicitRunSizesPt: [],
    runCount: 0,
    ...overrides,
  };
}

function sourceOutline(objects: PptxSourceObject[], slideCount = 1): PptxSourceOutline {
  return {
    slideSizeEmu: { w: SLIDE_W_EMU, h: SLIDE_H_EMU },
    slides: Array.from({ length: slideCount }, (_unused, index) => ({
      index,
      partPath: `ppt/slides/slide${index + 1}.xml`,
      objects: objects.filter((object) => object.slideIndex === index),
      layoutObjectNames: [],
      masterObjectNames: [],
    })),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function powerPointPageLayout(shapes: OverlayShape[], shapeNames: Record<string, string>): PageLayout {
  return {
    preset: "custom",
    orientation: "landscape",
    pageSize: {
      widthMm: round3(SLIDE_W_EMU / EMU_PER_MM),
      heightMm: round3(SLIDE_H_EMU / EMU_PER_MM),
    },
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes,
        assets: {},
        ...(Object.keys(shapeNames).length > 0
          ? { extensions: { "sigma.powerpoint": { shapeNames } } }
          : {}),
      },
    },
  };
}

function importedDocument(options: {
  shapes: OverlayShape[];
  shapeNames?: Record<string, string>;
  slideCount?: number;
}): SigmaDocument {
  return {
    version: "2.0",
    docId: "fidelity_fixture",
    metadata: {
      title: "fixture",
      source: {
        format: "powerpoint",
        layoutMode: "fixedOverlay",
        originalFileName: "fixture.pptx",
        slideCount: options.slideCount ?? 1,
      },
      // Without this the schema treats every fontSize as px and scales it by 0.75.
      styleUnits: { fontSize: "pt" },
    },
    content: [],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
    pageLayout: powerPointPageLayout(options.shapes, options.shapeNames ?? {}),
  };
}

/** The importer's page stride, read back from the document exactly as the harness does. */
function pageStride(document: SigmaDocument): number {
  return getPageMetrics(document.pageLayout).page.heightPx + PAGE_GAP_PX;
}

/**
 * Ids exactly as the importer mints them (`ppt_shape_<slide+1>_<sourceId>`). Fixtures
 * use these so the join is exercised through real recorded provenance rather than the
 * defensive geometric fallback.
 */
function sid(slideIndex: number, localId: string): string {
  return `ppt_shape_${slideIndex + 1}_${localId}`;
}

function geoShape(id: string, box: { x: number; y: number; w: number; h: number }, label?: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: box.x,
    y: box.y,
    props: {
      w: box.w,
      h: box.h,
      geo: "rectangle",
      fill: "solid",
      color: "#111111",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
      ...(label === undefined ? {} : { label }),
    },
  };
}

function textShape(
  id: string,
  box: { x: number; y: number; w: number; h: number },
  text: string,
  fontSize?: number,
): OverlayShape {
  return {
    id,
    type: "text",
    x: box.x,
    y: box.y,
    props: {
      w: box.w,
      h: box.h,
      blocks: [{ type: "paragraph", id: "powerpoint_fidelity_test_36", children: [{ type: "text", text }] }],
      color: "#111111",
      size: "m",
      ...(fontSize === undefined ? {} : { fontSize }),
    },
  };
}

function groupShape(id: string, box: { x: number; y: number; w: number; h: number }): OverlayShape {
  return { id, type: "group", x: box.x, y: box.y, props: { w: box.w, h: box.h } };
}

/** deck02 slide 22 `Google Shape;7380;p58`: placeholder extent, 5x3 grid. */
function tableFrame(): PptxSourceObject {
  return sourceObject({
    name: "Grid",
    tag: "p:graphicFrame",
    boxEmu: { x: 479150, y: 2787400, w: 3000000, h: 3000000 },
    intrinsicTableSizeEmu: { w: 3449875, h: 1143000 },
  });
}

function findDiscrepancies(
  report: { discrepancies: PptxFidelityDiscrepancy[] },
  kind: PptxFidelityDiscrepancy["kind"],
): PptxFidelityDiscrepancy[] {
  return report.discrepancies.filter((item) => item.kind === kind);
}

describe("pptx fidelity - coverage axis", () => {
  it("reports a drawable source object with no imported shape as an error", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Body", text: "Hello", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ]);
    const report = comparePptxImportFidelity(outline, importedDocument({ shapes: [] }));

    expect(findDiscrepancies(report, "missingObject")).toMatchObject([
      { severity: "error", axis: "coverage", slideIndex: 0, objectName: "Body" },
    ]);
  });

  it("does not report a group whose children are imported", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Group 1", tag: "p:grpSp", zIndex: 0, boxEmu: { x: 0, y: 0, w: 914400, h: 914400 } }),
      sourceObject({
        name: "Child 1",
        parentName: "Group 1",
        topLevel: false,
        zIndex: 0,
        text: "inside",
        boxEmu: { x: 0, y: 0, w: 457200, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "child"), { x: 0, y: 0, w: 48, h: 48 }, "inside")],
      shapeNames: { [sid(0, "child")]: "Child 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies.filter((item) => item.severity === "error")).toEqual([]);
    expect(findDiscrepancies(report, "groupDissolved")).toMatchObject([
      { severity: "info", axis: "coverage", objectName: "Group 1" },
    ]);
  });

  it("reports an empty placeholder drop as info, not an error", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Title 1", isPlaceholder: true, text: "   " }),
    ]);
    const report = comparePptxImportFidelity(outline, importedDocument({ shapes: [] }));

    expect(findDiscrepancies(report, "emptyPlaceholderDropped")).toMatchObject([
      { severity: "info", axis: "coverage", objectName: "Title 1" },
    ]);
    expect(findDiscrepancies(report, "missingObject")).toEqual([]);
  });

  it("accepts one source object mapped to several imported shapes", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Donut 1", text: "", boxEmu: { x: 0, y: 0, w: 914400, h: 914400 } }),
    ]);
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "donut"), { x: 0, y: 0, w: 96, h: 96 }),
        geoShape(sid(0, "donut_ring_1"), { x: 10, y: 10, w: 76, h: 76 }),
        geoShape(sid(0, "donut_ring_2"), { x: 20, y: 20, w: 56, h: 56 }),
      ],
      shapeNames: { [sid(0, "donut")]: "Donut 1", [sid(0, "donut_ring_1")]: "Donut 1", [sid(0, "donut_ring_2")]: "Donut 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies).toEqual([]);
  });

  it("joins a shape authored below the slide bottom to its own slide", () => {
    // Decks legitimately park content on the pasteboard under the slide. The shape
    // is placed faithfully inside slide 1's band, but at an offset past the page
    // height - so `floor(y / stride)` alone blames slide 2, the name matches nothing
    // there, and a present object gets reported as missing.
    const belowSlideEmu = SLIDE_H_EMU + 457200;
    const outline = sourceOutline([
      sourceObject({ name: "Pasteboard note", boxEmu: { x: 0, y: belowSlideEmu, w: 914400, h: 457200 } }),
      sourceObject({ name: "Slide 2 box", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "note"), { x: 0, y: emuToPx(belowSlideEmu), w: 96, h: 48 }),
        geoShape(sid(1, "box2"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "note")]: "Pasteboard note", [sid(1, "box2")]: "Slide 2 box" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "missingObject")).toEqual([]);
    expect(findDiscrepancies(report, "unknownImportedShape")).toEqual([]);
    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
  });

  it("joins a shape authored above the slide top to its own slide", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Slide 1 box", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Overhang", slideIndex: 1, boxEmu: { x: 0, y: -457200, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "box1"), { x: 0, y: 0, w: 96, h: 48 }),
        // Faithfully placed, but above its own band's top edge.
        geoShape(sid(1, "overhang"), { x: 0, y: stride + emuToPx(-457200), w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "box1")]: "Slide 1 box", [sid(1, "overhang")]: "Overhang" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "missingObject")).toEqual([]);
    expect(findDiscrepancies(report, "unknownImportedShape")).toEqual([]);
    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
  });

  it("joins a pasteboard shape to its own slide even when the name is reused", () => {
    // The hard case: a name several slides declare AND a shape sitting outside its
    // own band. Geometry cannot settle this - only the recorded slide can.
    const belowSlideEmu = SLIDE_H_EMU + 457200;
    const outline = sourceOutline([
      sourceObject({ name: "Title", boxEmu: { x: 0, y: belowSlideEmu, w: 914400, h: 457200 } }),
      sourceObject({ name: "Title", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "t1"), { x: 0, y: emuToPx(belowSlideEmu), w: 96, h: 48 }),
        geoShape(sid(1, "t2"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "t1")]: "Title", [sid(1, "t2")]: "Title" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies).toEqual([]);
  });

  it("still reports a dropped object when another slide has a shape of the same name", () => {
    // The false negative to guard against: joining by name alone would let slide 1's
    // shape satisfy slide 1's object, hiding the fact that it was never imported.
    const outline = sourceOutline([
      sourceObject({ name: "Repeated", text: "gone", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Repeated", slideIndex: 1, text: "kept", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [geoShape(sid(1, "kept"), { x: 0, y: stride, w: 96, h: 48 }, "kept")],
      shapeNames: { [sid(1, "kept")]: "Repeated" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "missingObject")).toMatchObject([
      { severity: "error", axis: "coverage", slideIndex: 0, objectName: "Repeated" },
    ]);
  });

  it("does not let one slide's object claim a same-named shape from another slide", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Solo", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "solo"), { x: 0, y: 0, w: 96, h: 48 }),
        // A layout-derived shape on slide 2 carrying the same authored name.
        geoShape(sid(1, "dup"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "solo")]: "Solo", [sid(1, "dup")]: "Solo" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    // Slide 1's object is satisfied by its own shape only: no page-sized delta, no offPage.
    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
    expect(findDiscrepancies(report, "offPage")).toEqual([]);
    // The slide-2 shape has a name slide 2 never declared, so it stays reportable.
    expect(findDiscrepancies(report, "unknownImportedShape")).toMatchObject([
      { severity: "info", slideIndex: 1, objectName: "Solo" },
    ]);
  });

  it("tells apart slides that reuse a name", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Title", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Title", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "t1"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape(sid(1, "t2"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "t1")]: "Title", [sid(1, "t2")]: "Title" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies).toEqual([]);
  });

  it("reports an imported shape whose name matches no slide, layout, or master object as info", () => {
    const outline = sourceOutline([sourceObject({ name: "Body", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } })]);
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "body"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape(sid(0, "ghost"), { x: 200, y: 200, w: 10, h: 10 }),
      ],
      shapeNames: { [sid(0, "body")]: "Body", [sid(0, "ghost")]: "Nowhere 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "unknownImportedShape")).toMatchObject([
      { severity: "info", axis: "coverage", objectName: "Nowhere 1", shapeId: sid(0, "ghost") },
    ]);
  });
});

describe("pptx fidelity - geometry axis", () => {
  it("flags an x/y/w/h delta beyond the error tolerance", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Box", boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 } }),
    ]);
    // 914400 EMU = 96px, 457200 EMU = 48px. The import lands 12px to the right.
    const document = importedDocument({
      shapes: [geoShape(sid(0, "box"), { x: 108, y: 48, w: 96, h: 48 })],
      shapeNames: { [sid(0, "box")]: "Box" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toMatchObject([
      {
        severity: "error",
        axis: "geometry",
        objectName: "Box",
        deltaPx: 12,
        expected: { x: 96, y: 48, w: 96, h: 48 },
        actual: { x: 108, y: 48, w: 96, h: 48 },
      },
    ]);
  });

  it("treats a sub-pixel rounding difference as no discrepancy", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Box", boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "box"), { x: 96.5, y: 48.5, w: 95.5, h: 47.5 })],
      shapeNames: { [sid(0, "box")]: "Box" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies).toEqual([]);
  });

  it("excludes group children from strict geometry and records the reason", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Group 1", tag: "p:grpSp", boxEmu: { x: 0, y: 0, w: 1828800, h: 1828800 } }),
      sourceObject({
        name: "Child 1",
        parentName: "Group 1",
        topLevel: false,
        boxEmu: { x: 914400, y: 914400, w: 457200, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [
        groupShape(sid(0, "g"), { x: 0, y: 0, w: 192, h: 192 }),
        geoShape(sid(0, "child"), { x: 500, y: 500, w: 48, h: 48 }),
      ],
      shapeNames: { [sid(0, "g")]: "Group 1", [sid(0, "child")]: "Child 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
    expect(report.notStrictlyCompared).toEqual(
      expect.arrayContaining([
        { slideIndex: 0, objectName: "Child 1", reason: "groupChild" },
        { slideIndex: 0, objectName: "Group 1", reason: "group" },
      ]),
    );
  });

  it("excludes rotated shapes from strict geometry", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Tilted",
        rotation1_60000: 2700000,
        boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "tilted"), { x: 500, y: 500, w: 10, h: 10 })],
      shapeNames: { [sid(0, "tilted")]: "Tilted" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
    expect(report.notStrictlyCompared).toContainEqual({
      slideIndex: 0,
      objectName: "Tilted",
      reason: "rotated",
    });
  });

  it("excludes placeholders without their own a:xfrm from strict geometry", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Title 1", isPlaceholder: true, text: "Heading" }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "title"), { x: 40, y: 40, w: 400, h: 60 }, "Heading")],
      shapeNames: { [sid(0, "title")]: "Title 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
    expect(report.notStrictlyCompared).toContainEqual({
      slideIndex: 0,
      objectName: "Title 1",
      reason: "inheritedGeometry",
    });
  });

  it("still reports coverage and text for objects excluded from strict geometry", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Tilted",
        rotation1_60000: 2700000,
        text: "Lost content",
        boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 },
      }),
    ]);
    const report = comparePptxImportFidelity(outline, importedDocument({ shapes: [] }));

    expect(findDiscrepancies(report, "missingObject")).toMatchObject([
      { severity: "error", axis: "coverage", objectName: "Tilted" },
    ]);
  });

  it("reports a shape pushed outside its own page", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Box", boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({ shapes: [], shapeNames: {} });
    const stride = pageStride(document);
    const pushed = importedDocument({
      shapes: [geoShape(sid(0, "box"), { x: 96, y: stride - 10, w: 96, h: 48 })],
      shapeNames: { [sid(0, "box")]: "Box" },
    });
    const report = comparePptxImportFidelity(outline, pushed);

    expect(findDiscrepancies(report, "offPage")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Box", shapeId: sid(0, "box") },
    ]);
  });

  it("reports a rotated shape stranded off its own page", () => {
    // False-negative guard: rotated shapes are excluded from the strict geometry
    // comparison, but "landed on a different page entirely" needs no prediction and
    // must stay an error - otherwise nothing at all reports a blank page.
    const outline = sourceOutline([
      sourceObject({
        name: "Tilted",
        rotation1_60000: 2700000,
        boxEmu: { x: 914400, y: 457200, w: 914400, h: 457200 },
      }),
      sourceObject({ name: "Slide 2 box", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "tilted"), { x: 96, y: stride * 2 + 48, w: 96, h: 48 }),
        geoShape(sid(1, "b"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "tilted")]: "Tilted", [sid(1, "b")]: "Slide 2 box" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "offPage")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Tilted" },
    ]);
    // Still excluded from the strict box comparison - only the page escape is reported.
    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
  });

  it("does not report a source object that already bleeds off the slide", () => {
    // The source box itself hangs off the right edge, so the import landing there too is faithful.
    const outline = sourceOutline([
      sourceObject({ name: "Bleed", boxEmu: { x: SLIDE_W_EMU - 457200, y: 0, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "bleed"), { x: emuToPx(SLIDE_W_EMU - 457200), y: 0, w: 96, h: 48 })],
      shapeNames: { [sid(0, "bleed")]: "Bleed" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "offPage")).toEqual([]);
  });

  it("compares a table frame against its grid, not its placeholder extent", () => {
    // Google Slides authors table frames with a placeholder extent - both instances on
    // the verification decks are exactly 3000000x3000000 EMU - while the table renders
    // at the size its own grid implies. (Only geometry is under test, so the imported
    // shape kind is irrelevant.)
    const outline = sourceOutline([tableFrame()]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 50.3, y: 292.64, w: 362.19, h: 120 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toEqual([]);
    expect(findDiscrepancies(report, "offPage")).toEqual([]);
    expect(report.notStrictlyCompared).toContainEqual({
      slideIndex: 0,
      objectName: "Grid",
      reason: "intrinsicTableSize",
    });
  });

  it("reports a table frame imported at its placeholder extent instead of its grid", () => {
    // The regression this rule exists to catch: if the importer stopped applying the
    // table's intrinsic size and fell back to the frame extent, merely declining to
    // compare the size would leave the harness green. Comparing against the grid
    // verifies the importer actually applied it.
    const outline = sourceOutline([tableFrame()]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 50.3, y: 292.64, w: 314.96, h: 314.96 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Grid", expected: { w: 362.19 } },
    ]);
  });

  it("still reports a table frame moved to the wrong position", () => {
    // Guard: judging the height loosely must not quieten the position, which `a:off`
    // states authoritatively and which matched exactly on both real decks.
    const outline = sourceOutline([tableFrame()]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 90.3, y: 292.64, w: 362.19, h: 120 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Grid", deltaPx: 40 },
    ]);
  });

  it("accepts a table taller than its declared rows but not shorter", () => {
    // `a:tr/@h` is a minimum: rows grow to fit their text, so taller is legitimate.
    // Shorter means content is being cut off.
    const taller = comparePptxImportFidelity(sourceOutline([tableFrame()]), importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 50.3, y: 292.64, w: 362.19, h: 180 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    }));
    const shorter = comparePptxImportFidelity(sourceOutline([tableFrame()]), importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 50.3, y: 292.64, w: 362.19, h: 60 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    }));

    expect(findDiscrepancies(taller, "geometryDelta")).toEqual([]);
    expect(findDiscrepancies(shorter, "geometryDelta")).toMatchObject([
      { severity: "error", objectName: "Grid", expected: { minH: 120 }, actual: { h: 60 } },
    ]);
  });

  it("judges whether a table fits its slide by the grid, not the placeholder extent", () => {
    // The placeholder extent is over half a slide tall, so using it to decide "did the
    // source already hang off the slide?" would silently skip the page check for every
    // table in the lower half of a slide - deck04 slide 5 among them.
    const outline = sourceOutline([
      sourceObject({
        name: "Grid",
        tag: "p:graphicFrame",
        // 500px down a 720px page: the 120px grid fits, the 314.96px placeholder does not.
        boxEmu: { x: 0, y: 4762500, w: 3000000, h: 3000000 },
        intrinsicTableSizeEmu: { w: 3449875, h: 1143000 },
      }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 0, y: 650, w: 362.19, h: 120 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "offPage")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Grid" },
    ]);
  });

  it("still compares the width of a table whose extent already matches its grid", () => {
    // Guard: an ordinary PowerPoint table, where `a:ext` agrees with the grid, keeps a
    // strict width comparison - a genuinely wrong table width is still an error.
    const outline = sourceOutline([
      sourceObject({
        name: "Grid",
        tag: "p:graphicFrame",
        boxEmu: { x: 0, y: 0, w: 1828800, h: 457200 },
        intrinsicTableSizeEmu: { w: 1828800, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "grid"), { x: 0, y: 0, w: 300, h: 48 })],
      shapeNames: { [sid(0, "grid")]: "Grid" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "geometryDelta")).toMatchObject([
      { severity: "error", axis: "geometry", objectName: "Grid", expected: { w: 192 } },
    ]);
  });

  it("counts strictlyCompared and notStrictlyCompared so they cover every drawable object", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Plain", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({
        name: "Tilted",
        zIndex: 1,
        rotation1_60000: 900000,
        boxEmu: { x: 0, y: 914400, w: 914400, h: 457200 },
      }),
      sourceObject({ name: "Group 1", tag: "p:grpSp", zIndex: 2, boxEmu: { x: 0, y: 0, w: 914400, h: 914400 } }),
      sourceObject({ name: "Child 1", parentName: "Group 1", topLevel: false, zIndex: 0 }),
    ]);
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "plain"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape(sid(0, "tilted"), { x: 0, y: 96, w: 96, h: 48 }),
        groupShape(sid(0, "g"), { x: 0, y: 0, w: 96, h: 96 }),
        geoShape(sid(0, "child"), { x: 0, y: 0, w: 48, h: 48 }),
      ],
      shapeNames: { [sid(0, "plain")]: "Plain", [sid(0, "tilted")]: "Tilted", [sid(0, "g")]: "Group 1", [sid(0, "child")]: "Child 1" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.counts).toEqual({ strictlyCompared: 1, notStrictlyCompared: 3, sourceObjects: 4 });
  });
});

describe("pptx fidelity - document axis", () => {
  it("flags a slide count mismatch measured from the pages the import actually reaches", () => {
    const stride = pageStride(importedDocument({ shapes: [] }));
    const outline = sourceOutline([], 3);
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "a"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape(sid(1, "b"), { x: 0, y: stride, w: 96, h: 48 }),
      ],
      // The importer always writes `slidePaths.length` into metadata, i.e. the very
      // number this harness derives the source slide count from. Believing it would
      // make this axis compare a value against itself and never fire.
      slideCount: 3,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "slideCountMismatch")).toMatchObject([
      { severity: "error", axis: "document", expected: { slides: 3 }, actual: { slides: 2, declared: 3 } },
    ]);
    expect(report.slideCount).toEqual({ source: 3, imported: 2 });
  });

  it("does not call an extra page an error when off-slide content explains it", () => {
    // Off-slide ("pasteboard") content is imported as authored - a product decision.
    // A page count that runs past the slide count because a shape hangs below its own
    // slide is therefore accepted behaviour, reported at info rather than error.
    const outline = sourceOutline([
      sourceObject({ name: "Slide 1 box", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Slide 2 box", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "a"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape(sid(1, "b"), { x: 0, y: stride, w: 96, h: 48 }),
        // Belongs to slide 2, parked below it - so the sheet count grows to 3.
        geoShape(sid(1, "pasteboard"), { x: 0, y: stride + 700, w: 96, h: 100 }),
      ],
      shapeNames: {
        [sid(0, "a")]: "Slide 1 box",
        [sid(1, "b")]: "Slide 2 box",
        [sid(1, "pasteboard")]: "Slide 2 box",
      },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "slideCountMismatch")).toMatchObject([
      { severity: "info", axis: "document", actual: { slides: 3, explainedBy: "offSlideContent" } },
    ]);
    expect(report.discrepancies.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("will not let a shape with no recorded slide explain an extra page", () => {
    // False-negative guard: treating an unparseable id as "makes no claim" would let a
    // stray shape explain itself away, and a document of entirely foreign ids could
    // never raise this axis at all.
    const outline = sourceOutline([
      sourceObject({ name: "Slide 1 box", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Slide 2 box", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "a"), { x: 0, y: 0, w: 96, h: 48 }),
        geoShape("foreign-id-shape", { x: 0, y: stride * 4, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "a")]: "Slide 1 box", "foreign-id-shape": "Slide 2 box" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "slideCountMismatch")).toMatchObject([
      { severity: "error", axis: "document" },
    ]);
  });

  it("still errors on an extra page that off-slide content does not explain", () => {
    // False-negative guard: a shape claiming a slide that does not exist is a genuine
    // pagination defect, however many pages the sheet count happens to reach.
    const outline = sourceOutline([
      sourceObject({ name: "Slide 1 box", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Slide 2 box", slideIndex: 1, boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ], 2);
    const stride = pageStride(importedDocument({ shapes: [], slideCount: 2 }));
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "a"), { x: 0, y: 0, w: 96, h: 48 }),
        // Minted for a sixth slide in a two-slide deck.
        geoShape(sid(5, "stray"), { x: 0, y: stride * 5, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "a")]: "Slide 1 box", [sid(5, "stray")]: "Slide 2 box" },
      slideCount: 2,
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "slideCountMismatch")).toMatchObject([
      { severity: "error", axis: "document", expected: { slides: 2 } },
    ]);
    expect(findDiscrepancies(report, "slideCountMismatch")[0]?.actual).not.toHaveProperty("explainedBy");
  });

  it("flags a page size mismatch against the imported page metrics", () => {
    const outline: PptxSourceOutline = {
      ...sourceOutline([]),
      // 4:3 source (960 x 720 px) against a 16:9 imported page.
      slideSizeEmu: { w: 9144000, h: SLIDE_H_EMU },
    };
    const report = comparePptxImportFidelity(outline, importedDocument({ shapes: [] }));

    expect(findDiscrepancies(report, "pageSizeMismatch")).toMatchObject([
      { severity: "error", axis: "document", expected: { widthPx: 960 } },
    ]);
  });
});

describe("pptx fidelity - text axis", () => {
  it("flags text present in the source but absent from the import", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Body", text: "Important", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({
      shapes: [geoShape(sid(0, "body"), { x: 0, y: 0, w: 96, h: 48 })],
      shapeNames: { [sid(0, "body")]: "Body" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "textMissing")).toMatchObject([
      { severity: "error", axis: "text", objectName: "Body", expected: { text: "Important" } },
    ]);
  });

  it("ignores whitespace and line-break differences", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Body",
        text: "  one\ntwo　three ",
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "body"), { x: 0, y: 0, w: 96, h: 48 }, "one two three")],
      shapeNames: { [sid(0, "body")]: "Body" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "textMismatch")).toEqual([]);
  });

  it("reads a geo shape's label and a text shape's richText as its text", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Preset", text: "labelled", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Box", zIndex: 1, text: "rich", boxEmu: { x: 0, y: 914400, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({
      shapes: [
        geoShape(sid(0, "preset"), { x: 0, y: 0, w: 96, h: 48 }, "labelled"),
        textShape(sid(0, "box"), { x: 0, y: 96, w: 96, h: 48 }, "rich"),
      ],
      shapeNames: { [sid(0, "preset")]: "Preset", [sid(0, "box")]: "Box" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "textMissing")).toEqual([]);
    expect(findDiscrepancies(report, "textMismatch")).toEqual([]);
  });

  it("flags a font size delta beyond half a point", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Body",
        text: "sized",
        explicitRunSizesPt: [18],
        runCount: 1,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "body"), { x: 0, y: 0, w: 96, h: 48 }, "sized", 13.5)],
      shapeNames: { [sid(0, "body")]: "Body" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toMatchObject([
      { severity: "warning", axis: "text", expected: { fontSizePt: 18 }, actual: { fontSizePt: 13.5 } },
    ]);
  });

  it("applies normAutofit fontScale to the expected font size", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Shrunk body",
        text: "Too much text for this box",
        explicitRunSizesPt: [40],
        runCount: 1,
        autoFitFontScale: 0.625,
        boxEmu: { x: 0, y: 0, w: 1828800, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "body"), { x: 0, y: 0, w: 192, h: 48 }, "Too much text for this box", 25)],
      shapeNames: { [sid(0, "body")]: "Shrunk body" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toEqual([]);
  });

  it("excludes a group child from the font size axis and records the reason", () => {
    // A group scales its children's font size by the `a:chExt` ratio, the same chain
    // the geometry axis already declines to re-implement.
    const outline = sourceOutline([
      sourceObject({ name: "Group 1", tag: "p:grpSp", boxEmu: { x: 0, y: 0, w: 1828800, h: 914400 } }),
      sourceObject({
        name: "Scaled label",
        parentName: "Group 1",
        topLevel: false,
        text: "scaled",
        explicitRunSizesPt: [18],
        runCount: 1,
        // The enclosing group stretches its children 2x, so the rendered size is not
        // the authored size and the harness declines to predict it.
        ancestorFontScale: 2,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [
        groupShape(sid(0, "g"), { x: 0, y: 0, w: 192, h: 96 }),
        // Rendered at twice the authored size because the group scales it.
        textShape(sid(0, "label"), { x: 0, y: 0, w: 96, h: 48 }, "scaled", 36),
      ],
      shapeNames: { [sid(0, "g")]: "Group 1", [sid(0, "label")]: "Scaled label" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toEqual([]);
    expect(report.notStrictlyCompared.filter((entry) => entry.objectName === "Scaled label")).toEqual([
      { slideIndex: 0, objectName: "Scaled label", reason: "groupChild" },
    ]);
  });

  it("still compares a group child when its group does not rescale it", () => {
    // False-negative guard: `chExt === ext` is what PowerPoint writes for a plain
    // group, so most group children ARE predictable. Excluding them wholesale would
    // hide a repeat of the px-vs-pt defect inside every group on every deck.
    const outline = sourceOutline([
      sourceObject({ name: "Group 1", tag: "p:grpSp", boxEmu: { x: 0, y: 0, w: 1828800, h: 914400 } }),
      sourceObject({
        name: "Plain label",
        parentName: "Group 1",
        topLevel: false,
        text: "plain",
        explicitRunSizesPt: [18],
        runCount: 1,
        ancestorFontScale: 1,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [
        groupShape(sid(0, "g"), { x: 0, y: 0, w: 192, h: 96 }),
        textShape(sid(0, "label"), { x: 0, y: 0, w: 96, h: 48 }, "plain", 24),
      ],
      shapeNames: { [sid(0, "g")]: "Group 1", [sid(0, "label")]: "Plain label" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toMatchObject([
      { severity: "warning", objectName: "Plain label", expected: { fontSizePt: 18 }, actual: { fontSizePt: 24 } },
    ]);
  });

  it("still flags a top-level font size delta beside an excluded group child", () => {
    // False-negative guard: excluding group children must not quieten the axis for
    // the objects it still owns.
    const outline = sourceOutline([
      sourceObject({
        name: "Heading",
        text: "heading",
        explicitRunSizesPt: [18],
        runCount: 1,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
      sourceObject({ name: "Group 1", tag: "p:grpSp", zIndex: 1, boxEmu: { x: 0, y: 914400, w: 914400, h: 457200 } }),
      sourceObject({
        name: "Scaled label",
        parentName: "Group 1",
        topLevel: false,
        text: "scaled",
        explicitRunSizesPt: [18],
        runCount: 1,
        ancestorFontScale: 2,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [
        textShape(sid(0, "heading"), { x: 0, y: 0, w: 96, h: 48 }, "heading", 36),
        groupShape(sid(0, "g"), { x: 0, y: 96, w: 96, h: 48 }),
        textShape(sid(0, "label"), { x: 0, y: 96, w: 96, h: 48 }, "scaled", 36),
      ],
      shapeNames: {
        [sid(0, "heading")]: "Heading",
        [sid(0, "g")]: "Group 1",
        [sid(0, "label")]: "Scaled label",
      },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toMatchObject([
      { severity: "warning", objectName: "Heading", expected: { fontSizePt: 18 }, actual: { fontSizePt: 36 } },
    ]);
  });

  it("skips font size when any run has no explicit sz", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Body",
        text: "mixed",
        explicitRunSizesPt: [18],
        runCount: 2,
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "body"), { x: 0, y: 0, w: 96, h: 48 }, "mixed", 9)],
      shapeNames: { [sid(0, "body")]: "Body" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(findDiscrepancies(report, "fontSizeDelta")).toEqual([]);
    expect(report.notStrictlyCompared).toContainEqual({
      slideIndex: 0,
      objectName: "Body",
      reason: "inheritedFontSize",
    });
  });
});

describe("pptx fidelity - ranking and formatting", () => {
  it("ranks errors before warnings and coverage before geometry", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Nudged", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
      sourceObject({ name: "Gone", zIndex: 1, text: "lost", boxEmu: { x: 0, y: 914400, w: 914400, h: 457200 } }),
      sourceObject({ name: "Moved", zIndex: 2, boxEmu: { x: 0, y: 1828800, w: 914400, h: 457200 } }),
    ]);
    const document = importedDocument({
      shapes: [
        // 2px off: a warning on the geometry axis.
        geoShape(sid(0, "nudged"), { x: 2, y: 0, w: 96, h: 48 }),
        // 40px off: an error on the geometry axis.
        geoShape(sid(0, "moved"), { x: 40, y: 192, w: 96, h: 48 }),
      ],
      shapeNames: { [sid(0, "nudged")]: "Nudged", [sid(0, "moved")]: "Moved" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.discrepancies.map((item) => [item.severity, item.axis, item.kind])).toEqual([
      ["error", "coverage", "missingObject"],
      ["error", "geometry", "geometryDelta"],
      ["warning", "geometry", "geometryDelta"],
    ]);
  });

  it("formats a summary that names the file, the counts, and the top discrepancies", () => {
    const outline = sourceOutline([
      sourceObject({ name: "Gone", text: "lost", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } }),
    ]);
    const report = comparePptxImportFidelity(outline, importedDocument({ shapes: [] }), { file: "deck01.pptx" });
    const summary = formatPptxFidelityReport([report]);

    expect(summary).toContain("deck01.pptx");
    expect(summary).toContain("原本オブジェクト 1 件");
    expect(summary).toContain("Gone");
  });

  it("keeps a deck-controlled name or text from breaking the table row", () => {
    const outline = sourceOutline([
      sourceObject({
        name: "Pipe | name",
        text: "one | two\nthree",
        boxEmu: { x: 0, y: 0, w: 914400, h: 457200 },
      }),
    ]);
    const document = importedDocument({
      shapes: [textShape(sid(0, "box"), { x: 0, y: 0, w: 96, h: 48 }, "something else")],
      shapeNames: { [sid(0, "box")]: "Pipe | name" },
    });
    const summary = formatPptxFidelityReport([comparePptxImportFidelity(outline, document)]);
    const rows = summary.split("\n").filter((line) => line.includes("テキストの相違"));

    expect(rows).toHaveLength(1);
    // 8 columns => 10 pieces once the leading and trailing delimiters are counted.
    expect(rows[0]!.split(/(?<!\\)\|/u)).toHaveLength(10);
    expect(rows[0]).toContain("Pipe \\| name");
  });

  it("formats an empty report without claiming a success it did not measure", () => {
    const summary = formatPptxFidelityReport([]);

    expect(summary).toContain("計測対象がありません");
    expect(summary).not.toContain("全て一致");
    expect(summary).not.toContain("乖離は検出されませんでした");
  });

  it("formats the Markdown report in English when requested", () => {
    const report = comparePptxImportFidelity(
      sourceOutline([sourceObject({ name: "Gone", boxEmu: { x: 0, y: 0, w: 914400, h: 457200 } })]),
      importedDocument({ shapes: [] }),
      { file: "english.pptx" },
    );
    const summary = formatPptxFidelityReport([report], "en");

    expect(summary).toContain("# PPTX import fidelity");
    expect(summary).toContain("Source objects 1 = strictly compared 1 + excluded 0");
    expect(summary).toContain("Missing object");
    expect(summary).not.toContain("原本オブジェクト");
  });
});

describe("readPptxSourceOutline", () => {
  it("reads top-level spTree children in document order", async () => {
    const outline = await readPptxSourceOutline(await createOrderFixturePptx());

    expect(outline.slideSizeEmu).toEqual({ w: SLIDE_W_EMU, h: SLIDE_H_EMU });
    expect(outline.slides[0]?.objects.filter((object) => object.topLevel).map((object) => object.name)).toEqual([
      "First rect",
      "Group 1",
      "Trailing pic",
    ]);
  });

  it("keeps a group sibling that follows a nested group", async () => {
    const outline = await readPptxSourceOutline(await createOrderFixturePptx());
    const names = outline.slides[0]?.objects.map((object) => object.name) ?? [];

    // The importer's regex slicer ends the outer group at the *inner* </p:grpSp>,
    // silently dropping everything after it. An ordered parse keeps the sibling.
    expect(names).toContain("Nested group");
    expect(names).toContain("Nested child");
    expect(names).toContain("Sibling after nested group");
  });

  it("unwraps mc:AlternateContent into exactly one object", async () => {
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const names = outline.slides[0]?.objects.map((object) => object.name) ?? [];

    expect(names.filter((name) => name === "Choice shape")).toHaveLength(1);
    expect(names).not.toContain("Fallback shape");
  });

  it("reads text runs in document order across a:r and m:oMath", async () => {
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const mixed = outline.slides[0]?.objects.find((object) => object.name === "Mixed runs");

    expect(mixed?.text).toBe("Hix Bye\n");
  });

  it("separates paragraphs so a multi-paragraph body is not one run-on word", async () => {
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const body = outline.slides[0]?.objects.find((object) => object.name === "Two paragraphs");

    expect(body?.text).toBe("first\nsecond\n");
  });

  it("reads how much a group rescales its children from a:ext over a:chExt", async () => {
    const plain = await readPptxSourceOutline(await createGroupTextPptx());
    const stretched = await readPptxSourceOutline(await createGroupTextPptx({ scaleChildrenBy: 2 }));
    const labelOf = (outline: PptxSourceOutline): number | undefined => (
      outline.slides[0]?.objects.find((object) => object.name === "Group label")?.ancestorFontScale
    );

    // `chExt === ext` is the ordinary case and leaves the child's size predictable.
    expect(labelOf(plain)).toBe(1);
    expect(labelOf(stretched)).toBe(2);
  });

  it("does not credit a group with its children's text or runs", async () => {
    // `p:grpSp` cannot carry a `p:txBody` at all, so a group has no text of its own.
    // Walking the whole subtree gave every container the text of everything inside it,
    // and since the imported group shape holds no text the text axis then accused the
    // container of losing text that was never its own.
    const outline = await readPptxSourceOutline(await createGroupTextPptx());
    const objects = outline.slides[0]?.objects ?? [];
    const group = objects.find((object) => object.name === "Labelled group");
    const label = objects.find((object) => object.name === "Group label");

    expect(group?.tag).toBe("p:grpSp");
    expect(group?.text).toBe("");
    expect(group?.runCount).toBe(0);
    expect(group?.explicitRunSizesPt).toEqual([]);
    // The text is still read - it belongs to the child that actually declares it.
    expect(label?.text).toBe("Boost\n");
    expect(label?.runCount).toBe(1);
  });

  it("reads a table's intrinsic size from its own grid", async () => {
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const grid = outline.slides[0]?.objects.find((object) => object.name === "Grid");

    // One 1828800 EMU column and one 457200 EMU row - derived from the source XML, so
    // it stays independent of whatever the importer decided.
    expect(grid?.intrinsicTableSizeEmu).toEqual({ w: 1828800, h: 457200 });
  });

  it("reads an inline equation once, not once per mc:AlternateContent branch", async () => {
    // `mc:Choice` (OMML) and `mc:Fallback` (plain runs) carry the SAME characters.
    // Reading both concatenates the text with itself and would mask a real text loss.
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const equation = outline.slides[0]?.objects.find((object) => object.name === "Inline equation");

    expect(equation?.text).toBe("x+1\n");
  });

  it("keeps a graphicFrame table's own text through the nested-object skip", async () => {
    // `a:graphic` / `a:graphicData` / `a:tbl` are not drawable tags, so a table's text
    // is its frame's own text and must survive the skip that groups need.
    const outline = await readPptxSourceOutline(await createAlternateContentPptx());
    const grid = outline.slides[0]?.objects.find((object) => object.name === "Grid");

    expect(grid?.tag).toBe("p:graphicFrame");
    expect(grid?.text).toBe("cell\n");
    expect(grid?.runCount).toBe(1);
    expect(grid?.explicitRunSizesPt).toEqual([14]);
  });

  it("resolves slide order from p:sldIdLst rather than zip order", async () => {
    const outline = await readPptxSourceOutline(await createReversedSlideOrderPptx());

    expect(outline.slides.map((slide) => slide.partPath)).toEqual([
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
    ]);
    expect(outline.slides.map((slide) => slide.objects[0]?.name)).toEqual(["Second first", "First second"]);
  });
});

describe("pptx fidelity - end to end", () => {
  it("reports no discrepancies for a faithful synthetic deck", async () => {
    const pptx = await createFaithfulDeckPptx();
    const document = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "faithful.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const report = await measurePptxImportFidelity(pptx, document, { file: "faithful.pptx" });

    // Guard against a vacuous pass: three rectangles across two slides must be measured.
    expect(report.counts.sourceObjects).toBe(4);
    expect(report.counts.strictlyCompared).toBe(4);
    expect(report.slideCount).toEqual({ source: 2, imported: 2 });
    expect(report.discrepancies).toEqual([]);
  });

  it("reports no text loss for a group whose children carry the text", async () => {
    const pptx = await createGroupTextPptx();
    const document = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "group.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const report = await measurePptxImportFidelity(pptx, document, { file: "group.pptx" });

    // Guard against a vacuous pass: the group and both of its children are measured.
    expect(report.counts.sourceObjects).toBe(3);
    expect(report.discrepancies.filter((item) => item.severity === "error")).toEqual([]);
    expect(report.notStrictlyCompared.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["group", "groupChild"]),
    );
  });

  it("keeps measuring a group that is itself a placeholder", () => {
    // A group has no text of its own, so the "empty placeholder" test must not be
    // applied to it - otherwise it drops out of the measured set entirely and is
    // reported as a vanished placeholder even when it was imported.
    const outline = sourceOutline([
      sourceObject({ name: "Placeholder group", tag: "p:grpSp", isPlaceholder: true, boxEmu: { x: 0, y: 0, w: 914400, h: 914400 } }),
      sourceObject({ name: "Inner label", parentName: "Placeholder group", topLevel: false, text: "Boost" }),
    ]);
    const document = importedDocument({
      shapes: [
        groupShape(sid(0, "g"), { x: 0, y: 0, w: 96, h: 96 }),
        textShape(sid(0, "label"), { x: 0, y: 0, w: 96, h: 48 }, "Boost"),
      ],
      shapeNames: { [sid(0, "g")]: "Placeholder group", [sid(0, "label")]: "Inner label" },
    });
    const report = comparePptxImportFidelity(outline, document);

    expect(report.counts.sourceObjects).toBe(2);
    expect(findDiscrepancies(report, "emptyPlaceholderDropped")).toEqual([]);
    expect(findDiscrepancies(report, "textMissing")).toEqual([]);
  });

  it("keeps measuring a placeholder group end to end", async () => {
    const pptx = await createGroupTextPptx({ placeholderGroup: true });
    const document = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "phgroup.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const report = await measurePptxImportFidelity(pptx, document, { file: "phgroup.pptx" });

    expect(report.counts.sourceObjects).toBe(3);
    expect(report.discrepancies.filter((item) => item.kind === "emptyPlaceholderDropped")).toEqual([]);
    expect(report.discrepancies.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("measures a placeholder-extent table frame end to end without a geometry error", async () => {
    // Exercises the whole path: the reader recognising a `p:graphicFrame` table and
    // summing its grid, the importer applying that intrinsic size, and the comparison
    // agreeing. The hand-built cases above cannot catch a reader that never populates
    // `intrinsicTableSizeEmu` in the first place.
    const pptx = await createPlaceholderTableFramePptx();
    const document = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "table.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const report = await measurePptxImportFidelity(pptx, document, { file: "table.pptx" });

    expect(report.counts.sourceObjects).toBe(1);
    expect(report.discrepancies.filter((item) => item.severity === "error")).toEqual([]);
    expect(report.notStrictlyCompared).toContainEqual({
      slideIndex: 0,
      objectName: "Placeholder table",
      reason: "intrinsicTableSize",
    });
  });

  it("reports the same objects on both parse paths", async () => {
    const pptx = await createFaithfulDeckPptx();
    const primary = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "faithful.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const primaryReport = await measurePptxImportFidelity(pptx, primary, { file: "faithful.pptx" });

    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const fallback = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "faithful.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const fallbackReport = await measurePptxImportFidelity(pptx, fallback, { file: "faithful.pptx" });

    const coverage = (report: { discrepancies: PptxFidelityDiscrepancy[] }): string[] => (
      report.discrepancies.filter((item) => item.axis === "coverage").map((item) => `${item.kind}:${item.objectName}`)
    );
    expect(primaryReport.counts.sourceObjects).toBe(4);
    expect(coverage(fallbackReport)).toEqual(coverage(primaryReport));
  });
});

describe("runPptxFidelitySuite", () => {
  it("keeps going when one deck fails to import", async () => {
    const pptx = await createFaithfulDeckPptx();
    const document = parseSigmaDocument(await importPowerPointPptxBuffer(pptx, "faithful.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    }));
    const reports = await runPptxFidelitySuite(["a.pptx", "b.pptx", "c.pptx"], async (file) => {
      if (file === "b.pptx") {
        throw new Error("broken package");
      }
      return { bytes: pptx, document };
    });

    expect(reports.map((report) => report.file)).toEqual(["a.pptx", "b.pptx", "c.pptx"]);
    expect(reports.map((report) => report.failure)).toEqual([undefined, "broken package", undefined]);
  });
});

// ---------------------------------------------------------------------------
// OOXML fixtures - hand-written packages, no real deck is ever committed.
// ---------------------------------------------------------------------------

const CONTENT_TYPES_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const SLIDE_NAMESPACES = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
  + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
  + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
  + 'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"';

const SP_TREE_HEADER = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

function slidePart(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${SLIDE_NAMESPACES}>
  <p:cSld>
    <p:spTree>
      ${SP_TREE_HEADER}
      ${body}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

function buildPptx(slides: Array<{ path: string; xml: string }>, slideIdOrder: number[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", [
    CONTENT_TYPES_HEADER,
    ...slides.map((slide) => (
      `  <Override PartName="/${slide.path}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )),
    "</Types>",
  ].join("\n"));
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${SLIDE_NAMESPACES}>
  <p:sldIdLst>${slideIdOrder.map((index, position) => `<p:sldId id="${256 + position}" r:id="rId${index}"/>`).join("")}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_W_EMU}" cy="${SLIDE_H_EMU}"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides.map((slide, index) => (
    `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${slide.path.replace("ppt/", "")}"/>`
  )).join("\n")}
</Relationships>`);
  for (const slide of slides) {
    zip.file(slide.path, slide.xml);
    zip.file(`${slide.path.replace(/\/([^/]+)$/u, "/_rels/$1.rels")}`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  }
  return zip.generateAsync({ type: "uint8array" });
}

/**
 * `<p:grpSp>…<p:grpSp>…</p:grpSp><p:pic/></p:grpSp>`: the trailing sibling only
 * survives a parser that respects nesting.
 */
function createOrderFixturePptx(): Promise<Uint8Array> {
  return buildPptx([{
    path: "ppt/slides/slide1.xml",
    xml: slidePart(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="First rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:sp>
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="3" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="914400"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></p:grpSpPr>
        <p:grpSp>
          <p:nvGrpSpPr><p:cNvPr id="4" name="Nested group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
          <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/><a:chOff x="0" y="0"/><a:chExt cx="457200" cy="457200"/></a:xfrm></p:grpSpPr>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="5" name="Nested child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          </p:sp>
        </p:grpSp>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="6" name="Sibling after nested group"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="914400" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        </p:sp>
      </p:grpSp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="7" name="Trailing pic"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="2743200"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:sp>`),
  }], [1]);
}

function createAlternateContentPptx(): Promise<Uint8Array> {
  return buildPptx([{
    path: "ppt/slides/slide1.xml",
    xml: slidePart(`<mc:AlternateContent>
        <mc:Choice Requires="a14">
          <p:sp>
            <p:nvSpPr><p:cNvPr id="2" name="Choice shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          </p:sp>
        </mc:Choice>
        <mc:Fallback>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="2" name="Fallback shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          </p:sp>
        </mc:Fallback>
      </mc:AlternateContent>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Mixed runs"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="914400"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p>
            <a:r><a:rPr sz="1800"/><a:t>Hi</a:t></a:r>
            <m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>
            <a:r><a:rPr sz="1800"/><a:t> Bye</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Inline equation"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="2743200"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p>
            <mc:AlternateContent>
              <mc:Choice Requires="a14"><a14:m><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></a14:m></mc:Choice>
              <mc:Fallback><a:r><a:rPr sz="1800"/><a:t>x+1</a:t></a:r></mc:Fallback>
            </mc:AlternateContent>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="6" name="Grid"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="3657600"/><a:ext cx="1828800" cy="457200"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1828800"/></a:tblGrid>
            <a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
          </a:tbl></a:graphicData></a:graphic>
      </p:graphicFrame>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Two paragraphs"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="1828800"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr sz="1800"/><a:t>first</a:t></a:r></a:p>
          <a:p><a:r><a:rPr sz="1800"/><a:t>second</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`),
  }], [1]);
}

function createReversedSlideOrderPptx(): Promise<Uint8Array> {
  const named = (id: number, name: string): string => `<p:sp>
        <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:sp>`;
  return buildPptx(
    [
      { path: "ppt/slides/slide1.xml", xml: slidePart(named(2, "First second")) },
      { path: "ppt/slides/slide2.xml", xml: slidePart(named(3, "Second first")) },
    ],
    // p:sldIdLst points at rId2 first, so slide2.xml is slide 1.
    [2, 1],
  );
}

/**
 * A group whose visible text lives in a child `p:sp` - the shape of every real
 * `textMissing` report on the verification decks.
 */
function createGroupTextPptx(options: { placeholderGroup?: boolean; scaleChildrenBy?: number } = {}): Promise<Uint8Array> {
  const groupNvPr = options.placeholderGroup ? `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr>` : `<p:nvPr/>`;
  // `a:chExt` smaller than `a:ext` is how a group stretches everything inside it.
  const childExtCy = Math.round(914400 / (options.scaleChildrenBy ?? 1));
  return buildPptx([{
    path: "ppt/slides/slide1.xml",
    xml: slidePart(`<p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="2" name="Labelled group"/><p:cNvGrpSpPr/>${groupNvPr}</p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="${childExtCy}"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="3" name="Group plate"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>
          </p:spPr>
        </p:sp>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="4" name="Group label"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p><a:r><a:rPr sz="1800"/><a:t>Boost</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      </p:grpSp>`),
  }], [1]);
}

/**
 * A table frame carrying Google Slides' placeholder extent (3000000x3000000 EMU) with
 * a grid that implies a quite different size - the shape of both real instances.
 */
function createPlaceholderTableFramePptx(): Promise<Uint8Array> {
  const cell = (text: string): string => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  return buildPptx([{
    path: "ppt/slides/slide1.xml",
    xml: slidePart(`<p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="Placeholder table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="479150" y="457200"/><a:ext cx="3000000" cy="3000000"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
          <a:tbl><a:tblPr/>
            <a:tblGrid><a:gridCol w="689975"/><a:gridCol w="689975"/><a:gridCol w="689975"/></a:tblGrid>
            <a:tr h="381000">${cell("a")}${cell("b")}${cell("c")}</a:tr>
            <a:tr h="381000">${cell("d")}${cell("e")}${cell("f")}</a:tr>
          </a:tbl></a:graphicData></a:graphic>
      </p:graphicFrame>`),
  }], [1]);
}

/** Plain top-level rectangles on two slides: nothing here is allowed to move. */
function createFaithfulDeckPptx(): Promise<Uint8Array> {
  const rect = (id: number, name: string, x: number, y: number): string => `<p:sp>
        <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>
        </p:spPr>
      </p:sp>`;
  // One explicitly sized run, so the font-size axis is actually exercised end to end
  // on whichever parse path runs - the unit bug this deck now guards against was
  // invisible while the deck held nothing but rectangles.
  const sizedText = `<p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Sized caption"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="2743200"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr sz="1800"/><a:t>Sized caption</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`;
  return buildPptx(
    [
      { path: "ppt/slides/slide1.xml", xml: slidePart(`${rect(2, "Slide 1 box", 914400, 457200)}${rect(3, "Slide 1 corner", 9144000, 4572000)}${sizedText}`) },
      { path: "ppt/slides/slide2.xml", xml: slidePart(rect(4, "Slide 2 box", 914400, 457200)) },
    ],
    [1, 2],
  );
}
