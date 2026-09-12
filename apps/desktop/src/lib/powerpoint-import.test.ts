import { overlayTextBlockInlineRuns, overlayTextBlocksToInlineNodes } from "@/features/document";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import JSZip from "jszip";
import { PptxHandler } from "pptx-viewer-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importPowerPointPptxBuffer, isPowerPointPptxFilename, readPowerPointShapeSlideIndex } from "@/lib/powerpoint-import";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { getPageMetrics, isValidOverlaySnapshot, PAGE_GAP_PX } from "@/features/document";
import type { OverlayTextBlock, OverlayShape, SigmaDocument } from "@/features/document";
import type { PptxData } from "pptx-viewer-core";

const require = createRequire(import.meta.url);

describe("PowerPoint import", () => {
  beforeEach(() => {
    powerPointShapeNames.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects pptx filenames only", () => {
    expect(isPowerPointPptxFilename("lesson.pptx")).toBe(true);
    expect(isPowerPointPptxFilename("lesson.PPTX")).toBe(true);
    expect(isPowerPointPptxFilename("lesson.ppt")).toBe(false);
  });

  it("localizes importer-generated errors and fallback titles without changing PPTX text", async () => {
    const emptyZip = await new JSZip().generateAsync({ type: "uint8array" });
    await expect(importPowerPointPptxBuffer(emptyZip, "broken.pptx", { locale: "en" }))
      .rejects.toThrow("ppt/presentation.xml was not found in the PPTX.");

    const document = await importPptx(await createFixturePptx(), ".pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      locale: "en",
    });
    expect(document.metadata.title).toBe("PowerPoint import");
    expect(JSON.stringify(document)).toContain("重要");
  });

  it("imports pptx slide objects as editable Sigma overlay objects by default", async () => {
    const pptx = await createFixturePptx();
    const document = await importPptx(pptx, "lesson.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
    });
    const parsed = parseSigmaDocument(document);
    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;
    const shapes = snapshot?.shapes ?? [];

    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(parsed.metadata.source).toMatchObject({
      format: "powerpoint",
      layoutMode: "fixedOverlay",
      originalFileName: "lesson.pptx",
      slideCount: 1,
    });
    expect(shapes).toHaveLength(7);
    expect(shapes.map((shape) => shape.type)).toEqual(["geo", "arrow", "arc", "text", "geo", "image", "tableShape"]);
    expect(shapes.map(getPowerPointShapeName)).toEqual([
      "Blue rectangle",
      "Arrow 1",
      "Arc 1",
      "TextBox 1",
      "Green ellipse",
      "Picture 1",
      "Table 1",
    ]);

    const blue = findShapeByPowerPointName(shapes, "Blue rectangle");
    expect(blue.locked).toBeUndefined();
    expect(blue).toMatchObject({
      type: "geo",
      anchor: { type: "page" },
      props: expect.objectContaining({
        geo: "rectangle",
        fillColor: "#4472C4",
        color: "#FF0000",
        dash: "dashed",
      }),
    });

    const arrow = findShapeByPowerPointName(shapes, "Arrow 1");
    expect(arrow).toMatchObject({
      type: "arrow",
      props: expect.objectContaining({
        arrowheadEnd: "arrow",
        color: "#00AA00",
      }),
    });

    const picture = findShapeByPowerPointName(shapes, "Picture 1") as Extract<OverlayShape, { type: "image" }>;
    const pictureAsset = snapshot?.assets[picture.props.assetId];
    expect(pictureAsset?.props.mimeType).toBe("image/png");
    expect(pictureAsset?.props.src).toMatch(/^data:image\/png;base64,/u);
    expect(picture.props.crop).toEqual({
      topLeft: { x: 0.1, y: 0.2 },
      bottomRight: { x: 0.7, y: 0.6 },
    });

    const table = findShapeByPowerPointName(shapes, "Table 1") as Extract<OverlayShape, { type: "tableShape" }>;
    expect(table).toMatchObject({
      type: "tableShape",
      props: {
        table: expect.objectContaining({
          kind: "plain",
          columns: expect.arrayContaining([
            expect.objectContaining({ id: `${table.id}_col_1` }),
            expect.objectContaining({ id: `${table.id}_col_2` }),
            expect.objectContaining({ id: `${table.id}_col_3` }),
          ]),
          rows: expect.arrayContaining([
            expect.objectContaining({ role: "header" }),
            expect.objectContaining({ role: "body" }),
          ]),
        }),
      },
    });
    expect(table.props.table.cells.some((cell) =>
      cell.content.some((content) => content.type === "paragraph" && content.children.some((child) => child.type === "text" && child.text === "値")),
    )).toBe(true);
    expect(table.props.table.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({
        columnId: `${table.id}_col_1`,
        colSpan: 2,
      }),
    ]));
  });

  it("converts the same shapes when falling back to direct XML parsing", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createFixturePptx(), "lesson.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const blue = findShapeByPowerPointName(shapes, "Blue rectangle");
    const arrow = findShapeByPowerPointName(shapes, "Arrow 1");
    const picture = findShapeByPowerPointName(shapes, "Picture 1");

    // The fallback path must land on the same shapes as the pptx-viewer-core path;
    // a difference here is a slide that looks different depending on which parser ran.
    expect(blue).toMatchObject({
      type: "geo",
      props: expect.objectContaining({ geo: "rectangle", fillColor: "#4472C4", color: "#FF0000", dash: "dashed" }),
    });
    expect(arrow).toMatchObject({
      type: "arrow",
      props: expect.objectContaining({ arrowheadEnd: "arrow", color: "#00AA00" }),
    });
    const table = findShapeByPowerPointName(shapes, "Table 1") as Extract<OverlayShape, { type: "tableShape" }>;

    expect(picture).toMatchObject({
      type: "image",
      opacity: 0.75,
      props: expect.objectContaining({
        crop: {
          topLeft: { x: 0.1, y: 0.2 },
          bottomRight: { x: 0.7, y: 0.6 },
        },
      }),
    });
    expect(table).toMatchObject({
      type: "tableShape",
      props: {
        table: expect.objectContaining({
          columns: expect.arrayContaining([
            expect.objectContaining({ width: expect.objectContaining({ mode: "fixed" }) }),
          ]),
          rows: expect.arrayContaining([
            expect.objectContaining({ role: "header", height: expect.objectContaining({ mode: "fixed" }) }),
          ]),
          cells: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  children: expect.arrayContaining([
                    expect.objectContaining({ text: "項目", marks: expect.arrayContaining(["bold"]) }),
                  ]),
                }),
              ]),
              style: expect.objectContaining({
                backgroundColor: "#D9EAF7",
                verticalAlign: "middle",
                paddingX: 9.6,
                paddingY: 4.8,
              }),
            }),
          ]),
          grid: expect.objectContaining({
            borderColor: "#1F4E79",
            borderStyle: "dashed",
          }),
        }),
      },
    });
  });

  it("resolves OOXML theme colors and color modifiers in XML fallback parsing", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createThemeColorFallbackPptx(), "theme-colors.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes[0];

    expect(shape).toMatchObject({
      type: "geo",
      props: expect.objectContaining({
        fillColor: "#99B3CC",
        fillOpacity: 0.6,
        color: "#1A334D",
      }),
    });

    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const gradient = findShapeByPowerPointName(shapes, "Gradient rectangle");
    const pattern = findShapeByPowerPointName(shapes, "Pattern rectangle");
    const text = findShapeByPowerPointName(shapes, "Theme text") as Extract<OverlayShape, { type: "text" }>;
    const custom = findShapeByPowerPointName(shapes, "Custom triangle") as Extract<OverlayShape, { type: "line" }>;
    const customCurve = findShapeByPowerPointName(shapes, "Custom curve") as Extract<OverlayShape, { type: "line" }>;
    const adjustedTriangle = findShapeByPowerPointName(shapes, "Adjusted triangle") as Extract<OverlayShape, { type: "geo" }>;
    const adjustedArrow = findShapeByPowerPointName(shapes, "Adjusted arrow") as Extract<OverlayShape, { type: "geo" }>;
    const customArc = findShapeByPowerPointName(shapes, "Custom arc") as Extract<OverlayShape, { type: "line" }>;
    const fallbackBullets = findShapeByPowerPointName(shapes, "Fallback bullets") as Extract<OverlayShape, { type: "text" }>;

    // The overlay model has no gradient or pattern fill: both flatten to the
    // solid colour PowerPoint reports, so the shape keeps its footprint.
    expect(gradient).toMatchObject({
      type: "geo",
      props: expect.objectContaining({
        fill: "solid",
        fillColor: "#336699",
      }),
    });
    expect(pattern).toMatchObject({
      type: "geo",
      props: expect.objectContaining({
        fill: "solid",
        fillColor: "#1A334D",
      }),
    });
    expect(text.props.color).toBe("#99B3CC");
    expect(JSON.stringify(text.props.blocks)).toContain('"color":"#99B3CC"');
    expect(JSON.stringify(text.props.blocks)).toContain('"fontSize":18');
    expect(custom).toMatchObject({
      type: "line",
      props: expect.objectContaining({
        kind: "polyline",
        closed: true,
        fill: "solid",
        fillColor: "#CCFFCC",
        color: "#008000",
        points: [
          { x: 96, y: 0 },
          { x: 192, y: 96 },
          { x: 0, y: 96 },
          { x: 96, y: 0 },
        ],
      }),
    });
    expect(customCurve).toMatchObject({
      type: "line",
      props: expect.objectContaining({
        kind: "polyline",
        closed: false,
        fill: "none",
        color: "#7030A0",
      }),
    });
    expect(customCurve.props.points).toHaveLength(25);
    expect(customCurve.props.points[0]).toEqual({ x: 0, y: 96 });
    expect(customCurve.props.points[24]).toEqual({ x: 192, y: 96 });
    expect(adjustedTriangle).toMatchObject({
      type: "geo",
      props: expect.objectContaining({
        geo: "triangle",
        apexX: 48,
        fillColor: "#FFFFCC",
      }),
    });
    expect(adjustedArrow).toMatchObject({
      type: "geo",
      props: expect.objectContaining({
        geo: "blockArrow",
        headLengthRatio: 0.6,
        shaftRatio: 0.3,
        fillColor: "#CCE5FF",
      }),
    });
    expect(customArc).toMatchObject({
      type: "line",
      props: expect.objectContaining({
        kind: "polyline",
        closed: false,
        fill: "none",
        color: "#C00000",
      }),
    });
    expect(customArc.props.points).toHaveLength(7);
    expect(customArc.props.points[0]).toEqual({ x: 192, y: 0 });
    expect(customArc.props.points[6]).toEqual({ x: 0, y: 96 });
    expect(richTextPlainText(fallbackBullets.props.blocks)).toContain("• First XML bullet");
    expect(richTextPlainText(fallbackBullets.props.blocks)).toContain("4. Numbered XML bullet");
    expect(richTextPlainText(fallbackBullets.props.blocks)).toContain("- Nested XML bullet");
    expect(richTextPlainText(fallbackBullets.props.blocks)).toContain("Plain XML paragraph");
    expect(fallbackBullets.props.blocks[2]).toMatchObject({ align: "center", lineHeight: "1.15" });
  });

  it("can import pptx slide objects as high-compatibility SVG image overlays when requested", async () => {
    const pptx = await createFixturePptx();
    const document = await importPptx(pptx, "lesson.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      objectMode: "renderedSvg",
      pptxSvgWasmSource: getPptxSvgWasmSource(),
    });
    const parsed = parseSigmaDocument(document);
    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;
    const shapes = snapshot?.shapes ?? [];

    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(shapes).toHaveLength(7);
    expect(shapes.some((shape) => shape.type === "tableShape" || shape.type === "image")).toBe(true);

    const blue = findShapeByPowerPointName(shapes, "Blue rectangle") as Extract<OverlayShape, { type: "image" }>;
    const blueAsset = snapshot?.assets[blue.props.assetId];
    expect(blue).toMatchObject({
      type: "image",
    });
    expect(blueAsset?.props.mimeType).toBe("image/svg+xml");
    expect(decodeDataUrl(blueAsset!.props.src)).toContain("data-ooxml-geom=\"rect\"");

    const arrow = findShapeByPowerPointName(shapes, "Arrow 1") as Extract<OverlayShape, { type: "image" }>;
    const arrowAsset = snapshot?.assets[arrow.props.assetId];
    expect(decodeDataUrl(arrowAsset!.props.src)).toContain("marker");

    const picture = findShapeByPowerPointName(shapes, "Picture 1") as Extract<OverlayShape, { type: "image" }>;
    const pictureAsset = snapshot?.assets[picture.props.assetId];
    expect(pictureAsset?.props.mimeType).toBe("image/svg+xml");
    expect(decodeDataUrl(pictureAsset!.props.src)).toContain("data:image/png;base64,");
  });

  it("keeps objects editable when visual rendering is disabled", async () => {
    const pptx = await createFixturePptx();
    const document = await importPptx(pptx, "lesson.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsed = parseSigmaDocument(document);
    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;

    expect(parsed.pageLayout?.marginsMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);

    const shapes = snapshot?.shapes ?? [];
    expect(shapes).toHaveLength(7);
    expect(shapes.map(getPowerPointShapeName)).toEqual([
      "Blue rectangle",
      "Arrow 1",
      "Arc 1",
      "TextBox 1",
      "Green ellipse",
      "Picture 1",
      "Table 1",
    ]);

    const blue = findShapeByPowerPointName(shapes, "Blue rectangle");
    expect(blue).toMatchObject({
      type: "geo",
      x: 96,
      y: 72,
      anchor: { type: "page" },
      props: expect.objectContaining({
        geo: "rectangle",
        w: 192,
        h: 96,
        fill: "solid",
        fillColor: "#4472C4",
        color: "#FF0000",
        dash: "dashed",
      }),
    });

    const arrow = findShapeByPowerPointName(shapes, "Arrow 1");
    expect(arrow).toMatchObject({
      type: "arrow",
      x: 360,
      y: 96,
      props: expect.objectContaining({
        end: { x: 192, y: 96 },
        arrowheadEnd: "arrow",
        color: "#00AA00",
      }),
    });

    const arc = findShapeByPowerPointName(shapes, "Arc 1");
    expect(arc).toMatchObject({
      type: "arc",
      x: 120,
      y: 240,
      props: expect.objectContaining({
        rx: 96,
        ry: 48,
        color: "#7030A0",
      }),
    });

    const text = findShapeByPowerPointName(shapes, "TextBox 1");
    expect(text).toMatchObject({
      type: "text",
      x: 384,
      y: 264,
      props: expect.objectContaining({
        w: 192,
        h: 72,
      }),
    });
    const textShape = text as Extract<OverlayShape, { type: "text" }>;
    expect(JSON.stringify(textShape.props.blocks)).toContain("重要");
    expect(JSON.stringify(textShape.props.blocks)).toContain("な式");
    expect(textShape.props.color).toBe("#C00000");
    // Run styling lives on the inline node itself; `fontSize` is points. The run is
    // authored `sz="1800"`, so it is 18 here. (This previously read 24 - the deck's
    // 18pt seen through `pptx-viewer-core`'s px values, 18 * 96/72.)
    expect(overlayTextBlocksToInlineNodes(textShape.props.blocks)[0]).toMatchObject({
      type: "text",
      text: "重要",
      marks: expect.arrayContaining(["bold", "italic", "underline"]),
      color: "#C00000",
      fontSize: 18,
    });

    const image = findShapeByPowerPointName(shapes, "Picture 1") as Extract<OverlayShape, { type: "image" }>;
    const asset = snapshot?.assets[image.props.assetId];
    expect(image).toMatchObject({
      type: "image",
      x: 144,
      y: 396,
      props: expect.objectContaining({ w: 96, h: 72 }),
    });
    expect(asset?.props.mimeType).toBe("image/png");
    expect(asset?.props.src).toMatch(/^data:image\/png;base64,/u);
  });

  it("places every slide on its own page at the slide's own coordinates", async () => {
    const document = await importPptx(await createMultiSlideLayoutPptx(), "deck.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsed = parseSigmaDocument(document);
    const metrics = getPageMetrics(parsed.pageLayout);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    // The sheet is the slide: 13.333in x 7.5in at 96dpi, no margins. Any margin
    // here would shift every object on every page.
    expect(parsed.pageLayout?.orientation).toBe("landscape");
    expect(metrics.page.widthPx).toBeCloseTo(1280, 2);
    expect(metrics.page.heightPx).toBeCloseTo(720, 2);
    expect(metrics.margins).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });

    // Nothing may be dropped on the way through the snapshot normalizer.
    expect(shapes.map((shape) => shape.id))
      .toEqual(document.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id));
    expect(shapes).toHaveLength(4);

    // Slide N sits at N * (pageHeight + pageGap); the in-page offset is the
    // object's own offset on the slide, unchanged.
    const stride = metrics.page.heightPx + PAGE_GAP_PX;
    const placement = shapes.map((shape) => ({
      name: getPowerPointShapeName(shape),
      page: Math.round((shape.y - (shape.y % stride)) / stride),
      x: Number(shape.x.toFixed(3)),
      yInPage: Number((shape.y % stride).toFixed(3)),
    }));
    expect(placement).toEqual([
      { name: "Slide 1 box", page: 0, x: 96, yInPage: 48 },
      { name: "Slide 2 box", page: 1, x: 96, yInPage: 48 },
      { name: "Slide 3 box", page: 2, x: 96, yInPage: 48 },
      // Flush against the bottom-right corner of slide 3: still inside its page.
      { name: "Slide 3 corner", page: 2, x: 1088, yInPage: 624 },
    ]);
    for (const shape of shapes) {
      const yInPage = shape.y % stride;
      expect(yInPage).toBeGreaterThanOrEqual(0);
      expect(yInPage).toBeLessThanOrEqual(metrics.page.heightPx);
      expect(shape.x).toBeGreaterThanOrEqual(0);
      expect(shape.x).toBeLessThanOrEqual(metrics.page.widthPx);
    }
  });

  it("keeps autofit-shrunk text at the size PowerPoint renders it", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createAutoFitPptx(), "autofit.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsed = parseSigmaDocument(document);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const shrunk = findShapeByPowerPointName(shapes, "Shrunk body") as Extract<OverlayShape, { type: "text" }>;
    const plain = findShapeByPowerPointName(shapes, "Plain body") as Extract<OverlayShape, { type: "text" }>;

    // normAutofit fontScale="62500" means PowerPoint draws this 40pt run at 25pt
    // to keep it inside the box. Rendering it at 40pt spills it out of the shape.
    expect(shrunk.props.fontSize).toBe(25);
    expect(overlayTextBlocksToInlineNodes(shrunk.props.blocks)[0]).toMatchObject({ fontSize: 25 });
    // A box without normAutofit keeps its nominal size.
    expect(plain.props.fontSize).toBe(40);
    expect(overlayTextBlocksToInlineNodes(plain.props.blocks)[0]).toMatchObject({ fontSize: 40 });
  });

  it("reads run font size in points on both parse paths", async () => {
    // `pptx-viewer-core` reports run font size in CSS px (it multiplies OOXML's
    // hundredths-of-a-point by 96/72), while the XML fallback keeps points. When the
    // importer believed the library, every run on the primary path came out 4/3 too
    // large - and the autofit test above never caught it, because mocking
    // `PptxHandler.load` into rejecting means it only ever exercises the fallback.
    const pptx = await createAutoFitPptx();

    const readFontSizes = async (): Promise<Record<string, number | undefined>> => {
      const parsed = parseSigmaDocument(await importPptx(pptx, "autofit.pptx", {
        importedAt: "2026-08-26T00:00:00.000Z",
        visualRenderer: "none",
      }));
      const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
      return Object.fromEntries(["Shrunk body", "Plain body"].map((name) => [
        name,
        (findShapeByPowerPointName(shapes, name) as Extract<OverlayShape, { type: "text" }>).props.fontSize,
      ]));
    };

    // Pin the primary run to the library parser. `importPptx` silently falls back to
    // XML on any `load` failure, and both paths agree by design once fixed - so without
    // this the test could quietly decay into comparing the fallback with itself: green
    // while guarding nothing, the exact blindness it was written to end.
    const loadSpy = vi.spyOn(PptxHandler.prototype, "load");
    const primary = await readFontSizes();
    expect(loadSpy).toHaveBeenCalled();
    await expect(loadSpy.mock.results[0]!.value).resolves.toBeDefined();
    expect(primary).toEqual({ "Shrunk body": 25, "Plain body": 40 });

    loadSpy.mockRejectedValue(new Error("unsupported pptx model"));
    const fallback = await readFontSizes();

    // The real invariant: one deck, one answer, whichever parser produced it.
    expect(fallback).toEqual(primary);
  });

  it("stamps the source slide into every imported shape id", async () => {
    // The fidelity harness attributes an imported shape to its slide by reading this
    // id, because geometry cannot do it for pasteboard content or group children.
    // If the id format ever changes, that attribution must break here first.
    const document = await importPptx(await createMultiSlideLayoutPptx(), "layout.pptx", {
      importedAt: "2026-08-26T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = parseSigmaDocument(document).pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    expect(readPowerPointShapeSlideIndex(findShapeByPowerPointName(shapes, "Slide 1 box").id)).toBe(0);
    expect(readPowerPointShapeSlideIndex(findShapeByPowerPointName(shapes, "Slide 2 box").id)).toBe(1);
    expect(readPowerPointShapeSlideIndex(findShapeByPowerPointName(shapes, "Slide 3 box").id)).toBe(2);
    expect(shapes.every((shape) => readPowerPointShapeSlideIndex(shape.id) !== undefined)).toBe(true);
    expect(readPowerPointShapeSlideIndex("not-an-imported-id")).toBeUndefined();
  });

  it("keeps an outline-only shape that has no fill and no text", async () => {
    // Mirrors deck02 slide 15 "Google Shape;5755;p51": a framed box drawn with a
    // stroke, `a:noFill`, and an empty `a:t`. On the slide that is visible content, so
    // "has fill or text" would be the wrong test for whether an object is drawable -
    // the stroke alone makes it drawable.
    const pptx = await createOutlineOnlyPptx();

    const readNames = async (): Promise<string[]> => {
      const parsed = parseSigmaDocument(await importPptx(pptx, "outline.pptx", {
        importedAt: "2026-08-26T00:00:00.000Z",
        visualRenderer: "none",
      }));
      const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
      return shapes.map((shape) => String(getPowerPointShapeName(shape)));
    };

    const loadSpy = vi.spyOn(PptxHandler.prototype, "load");
    const primary = await readNames();
    expect(loadSpy).toHaveBeenCalled();
    await expect(loadSpy.mock.results[0]!.value).resolves.toBeDefined();
    expect(primary).toEqual(["Framed box", "Filled control"]);

    loadSpy.mockRejectedValue(new Error("unsupported pptx model"));
    expect(await readNames()).toEqual(primary);
  });

  it("imports PowerPoint groups as Sigma groups with editable children", async () => {
    const document = await importPptx(await createGroupedFixturePptx(), "grouped.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const group = shapes.find((shape) => shape.type === "group");
    const children = group ? shapes.filter((shape) => shape.parentId === group.id) : [];

    expect(parseSigmaDocument(document).docId).toBe(document.docId);
    expect(group).toMatchObject({
      type: "group",
    });
    expect(children.map((shape) => shape.type)).toEqual(["geo", "text"]);
    expect(children.map(getPowerPointShapeName)).toEqual(["Grouped rectangle", "Grouped label"]);
    expect(group).toMatchObject({ x: 96, y: 96 });
    expect(children[0]).toMatchObject({ x: 96, y: 96, props: { w: 96, h: 96 } });
    expect(children[1]).toMatchObject({ x: 216, y: 96, props: { w: 72, h: 96 } });
  });

  it("uses table grid and row sizes when Google Slides exports a placeholder frame size", async () => {
    const pptx = await createGroupedFixturePptx();
    const assertIntrinsicTableSize = (document: Awaited<ReturnType<typeof importPowerPointPptxBuffer>>) => {
      const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
      const table = findShapeByPowerPointName(shapes, "Google table") as Extract<OverlayShape, { type: "tableShape" }>;
      const group = shapes.find((shape) => shape.type === "group");
      const children = group ? shapes.filter((shape) => shape.parentId === group.id) : [];

      expect(table.x).toBeCloseTo(28, 0);
      expect(table.y).toBe(360);
      expect(table.props.w).toBeCloseTo(904.21, 3);
      expect(table.props.h).toBeCloseTo(89.701, 3);
      expect(table.props.table.columns.map((column) => column.width)).toEqual([
        { mode: "fixed", value: 236.22 },
        { mode: "fixed", value: 667.99 },
      ]);
      expect(table.props.table.rows.map((row) => row.height)).toEqual([
        { mode: "fixed", value: 44.851 },
        { mode: "fixed", value: 44.851 },
      ]);
      expect(group).toMatchObject({ x: 96, y: 96 });
      expect(children[0]).toMatchObject({ x: 96, y: 96, props: { w: 96, h: 96 } });
      expect(children[1]).toMatchObject({ x: 216, y: 96, props: { w: 72, h: 96 } });
    };

    assertIntrinsicTableSize(await importPptx(pptx, "google-slides.pptx", {
      importedAt: "2026-07-10T00:00:00.000Z",
      visualRenderer: "none",
    }));

    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    assertIntrinsicTableSize(await importPptx(pptx, "google-slides.pptx", {
      importedAt: "2026-07-10T00:00:00.000Z",
      visualRenderer: "none",
    }));
  });

  it("imports PowerPoint slide backgrounds as Sigma background shapes", async () => {
    const document = await importPptx(await createBackgroundFixturePptx(), "background.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const background = shapes.find((shape) => getPowerPointShapeName(shape) === "Slide 1 background");

    expect(parseSigmaDocument(document).docId).toBe(document.docId);
    expect(background).toMatchObject({
      type: "geo",
      stackLayer: "background",
      x: 0,
      y: 0,
      props: expect.objectContaining({
        w: 960,
        h: 540,
        geo: "rectangle",
        fillColor: "#FFF2CC",
        strokeOpacity: 0,
      }),
    });
  });

  it("imports visible slide master and layout objects as editable Sigma shapes", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockResolvedValue(createMasterLayoutModel());
    const document = await importPptx(await createEmptyFixturePptx(), "master-layout.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsed = parseSigmaDocument(document);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const masterFooter = findShapeByPowerPointName(shapes, "Master footer");
    const layoutAccent = findShapeByPowerPointName(shapes, "Layout accent");
    const slideTitle = findShapeByPowerPointName(shapes, "Slide title");

    expect(masterFooter).toMatchObject({
      type: "text",
    });
    expect(layoutAccent).toMatchObject({
      type: "geo",
    });
    expect(slideTitle).toMatchObject({
      type: "text",
    });
  });

  it("imports slide layout and master objects when XML fallback parsing is used", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createXmlMasterLayoutFixturePptx(), "xml-master-layout.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsed = parseSigmaDocument(document);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const masterFooter = findShapeByPowerPointName(shapes, "XML Master footer");
    const layoutAccent = findShapeByPowerPointName(shapes, "XML Layout accent");
    const slideTitle = findShapeByPowerPointName(shapes, "XML Slide title");
    const slideBody = findShapeByPowerPointName(shapes, "XML Slide body") as Extract<OverlayShape, { type: "text" }>;

    expect(masterFooter).toMatchObject({
      type: "text",
    });
    expect(layoutAccent).toMatchObject({
      type: "geo",
    });
    expect(slideTitle).toMatchObject({
      type: "text",
    });
    expect(JSON.stringify(slideBody.props.blocks)).toContain('"fontSize":22');
    expect(JSON.stringify(slideBody.props.blocks)).toContain('"color":"#C00000"');
  });

  it("imports PowerPoint charts as editable Sigma groups with child shapes", async () => {
    const document = await importPptx(await createChartFixturePptx(), "chart.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const group = shapes.find((shape) => getPowerPointShapeName(shape) === "Sales chart");
    const children = group ? shapes.filter((shape) => shape.parentId === group.id) : [];
    const bars = children.filter((shape) => isPowerPointChartPart(shape, "bar"));

    expect(parseSigmaDocument(document).docId).toBe(document.docId);
    expect(group).toMatchObject({
      type: "group",
    });
    expect(bars).toHaveLength(4);
    expect(bars.every((shape) => shape.type === "geo")).toBe(true);
    expect(children.some((shape) => isPowerPointChartPart(shape, "category"))).toBe(true);
  });

  it("imports chart data as editable Sigma groups when XML fallback parsing is used", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createChartFixturePptx(), "xml-chart.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const group = shapes.find((shape) => getPowerPointShapeName(shape) === "Sales chart");
    const children = group ? shapes.filter((shape) => shape.parentId === group.id) : [];
    const bars = children.filter((shape) => isPowerPointChartPart(shape, "bar"));

    expect(parseSigmaDocument(document).docId).toBe(document.docId);
    expect(group).toMatchObject({
      type: "group",
    });
    expect(bars).toHaveLength(4);
    expect(children.some((shape) => isPowerPointChartPart(shape, "category"))).toBe(true);
    expect(children.some((shape) => isPowerPointChartPart(shape, "legend_label"))).toBe(true);
  });

  it("imports SmartArt data as editable Sigma groups when XML fallback parsing is used", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const document = await importPptx(await createSmartArtFixturePptx(), "xml-smartart.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const group = shapes.find((shape) => getPowerPointShapeName(shape) === "Process SmartArt");
    const children = group ? shapes.filter((shape) => shape.parentId === group.id) : [];
    const nodes = children.filter((shape): shape is Extract<OverlayShape, { type: "geo" }> =>
      shape.type === "geo" && isPowerPointChartPart(shape, "smartart_node"),
    );

    expect(parseSigmaDocument(document).docId).toBe(document.docId);
    expect(group).toMatchObject({
      type: "group",
    });
    expect(nodes).toHaveLength(0);
    const drawingShapes = children.filter((shape): shape is Extract<OverlayShape, { type: "geo" }> =>
      shape.type === "geo" && isPowerPointChartPart(shape, "smartart_shape"),
    );
    expect(drawingShapes).toHaveLength(2);
    expect(drawingShapes.map((shape) => shape.props.label)).toEqual(["Plan", "Build"]);
    expect(drawingShapes[0]).toMatchObject({
      x: 96,
      y: 72,
      props: expect.objectContaining({
        fillColor: "#D9EAF7",
        color: "#0070C0",
      }),
    });
    expect(drawingShapes[1]).toMatchObject({
      x: 384,
      y: 181.714,
      props: expect.objectContaining({
        fillColor: "#E2F0D9",
        color: "#70AD47",
      }),
    });
  });

  it("imports internal PPTX objects as editable overlays with preserved metadata", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockResolvedValue(createInternalObjectModel());
    const document = await importPptx(await createEmptyFixturePptx(), "internal-objects.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
      visualRenderer: "none",
    });
    const parsedDocument = parseSigmaDocument(document);
    const snapshot = parsedDocument.pageLayout?.overlay?.overlaySnapshot;
    const shapes = snapshot?.shapes ?? [];

    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);

    const ole = findShapeByPowerPointName(shapes, "Spreadsheet") as Extract<OverlayShape, { type: "image" }>;
    const oleAsset = snapshot?.assets[ole.props.assetId];
    expect(oleAsset?.props.src).toMatch(/^data:image\/png;base64,/u);
    expect(ole).toMatchObject({
      type: "image",
    });

    const media = findShapeByPowerPointName(shapes, "Video clip") as Extract<OverlayShape, { type: "image" }>;
    expect(media).toMatchObject({
      type: "image",
    });

    // Ink becomes one freehand line per stroke, wrapped in a group. The snapshot
    // normalizer dissolves a group with a single child, so this one-stroke object
    // arrives as the line itself - same geometry, one level less nesting.
    const ink = findShapeByPowerPointName(shapes, "Ink strokes");
    expect(ink).toMatchObject({
      type: "line",
      props: expect.objectContaining({
        kind: "freehand",
        points: expect.arrayContaining([
          expect.objectContaining({ x: 0, y: 0 }),
          expect.objectContaining({ x: 40, y: 0 }),
        ]),
        color: "#C00000",
      }),
    });

    const zoom = findShapeByPowerPointName(shapes, "Zoom 1");
    expect(zoom).toMatchObject({
      type: "image",
    });

    const model3d = findShapeByPowerPointName(shapes, "Model 1");
    expect(model3d).toMatchObject({
      type: "image",
    });

    const linkedText = findShapeByPowerPointName(shapes, "Linked text");
    expect(linkedText.locked).toBeUndefined();
    expect(linkedText).toMatchObject({
      type: "text",
      opacity: 0.5,
    });

    const bulletText = findShapeByPowerPointName(shapes, "Bullet text") as Extract<OverlayShape, { type: "text" }>;
    expect(bulletText.type).toBe("text");
    const bulletPlainText = richTextPlainText(bulletText.props.blocks);
    const bulletRichTextJson = JSON.stringify(bulletText.props.blocks);
    expect(bulletPlainText).toContain("\u2022 First");
    expect(bulletPlainText).toContain("3. Second");
    expect(bulletPlainText).toContain("- Nested");
    expect(bulletText.props.blocks[2]).toMatchObject({ align: "center", lineHeight: "1.2" });
    expect(bulletRichTextJson).toContain("\"backgroundColor\":\"#FFF2CC\"");

    expect(media).toMatchObject({
      hidden: true,
      opacity: 0.65,
    });
  });

  it("converts supported preset geometries to polyline and arc overlays", async () => {
    const document = await importPptx(await createGeometryFixturePptx(), "geometry.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    for (const [name, minimumPointCount] of [
      ["Hexagon preset", 6],
      ["Star preset", 10],
      ["Chevron preset", 6],
      ["Wedge callout preset", 7],
      ["Heart preset", 10],
    ] as const) {
      const shape = findShapeByPowerPointName(shapes, name);
      expect(shape).toMatchObject({
        type: "line",
        props: expect.objectContaining({
          kind: "polyline",
          closed: true,
        }),
      });
      expect(shape.type === "line" ? shape.props.points.length : 0).toBeGreaterThanOrEqual(minimumPointCount);
    }

    expect(findShapeByPowerPointName(shapes, "Arc preset")).toMatchObject({
      type: "arc",
      props: expect.objectContaining({ kind: "arc", fill: "none" }),
    });
    expect(findShapeByPowerPointName(shapes, "Pie preset")).toMatchObject({
      type: "arc",
      props: expect.objectContaining({ kind: "sector", fill: "solid" }),
    });
  });

  it("preserves custom geometry subpath boundaries in XML fallback parsing", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported custom geometry fixture"));
    const document = await importPptx(await createGeometryFixturePptx(), "geometry.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const subpaths = shapes.filter((shape): shape is Extract<OverlayShape, { type: "line" }> =>
      shape.type === "line" && getPowerPointShapeName(shape) === "Holed custom geometry",
    );

    expect(subpaths).toHaveLength(2);
    expect(subpaths.map((shape) => shape.props.closed)).toEqual([true, true]);
    expect(subpaths[0]?.props.points).toEqual([
      { x: 0, y: 0 },
      { x: 192, y: 0 },
      { x: 192, y: 96 },
      { x: 0, y: 96 },
      { x: 0, y: 0 },
    ]);
    expect(subpaths[1]?.props.points).toEqual([
      { x: 57.6, y: 28.8 },
      { x: 57.6, y: 67.2 },
      { x: 134.4, y: 67.2 },
      { x: 134.4, y: 28.8 },
      { x: 57.6, y: 28.8 },
    ]);
  });

  it("approximates a:arcTo custom geometry as an editable curved polyline", async () => {
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported arcTo fixture"));
    const document = await importPptx(await createGeometryFixturePptx(), "geometry.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const arcTo = findShapeByPowerPointName(shapes, "ArcTo custom geometry");

    expect(arcTo).toMatchObject({
      type: "line",
      props: expect.objectContaining({ kind: "polyline", closed: false }),
    });
    expect(arcTo.type === "line" ? arcTo.props.points.length : 0).toBeGreaterThan(2);
  });

  it("uses pptx-viewer-core custom geometry in the default import path", async () => {
    const loadSpy = vi.spyOn(PptxHandler.prototype, "load");
    const document = await importPptx(await createGeometryFixturePptx(), "geometry.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const customSubpaths = shapes.filter((shape) => getPowerPointShapeName(shape) === "Holed custom geometry");
    const arcTo = findShapeByPowerPointName(shapes, "ArcTo custom geometry");

    expect(loadSpy).toHaveBeenCalledOnce();
    expect(customSubpaths).toHaveLength(2);
    expect(customSubpaths.every((shape) => shape.type === "line")).toBe(true);
    expect(arcTo.type).toBe("line");
  });

  it("correctly handles table merge cells in both primary and fallback paths", async () => {
    const pptx = await createMergedTableFixturePptx();

    // Test primary path (pptx-viewer-core)
    const doc1 = await importPptx(pptx, "merged-table.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    const shapes1 = doc1.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const table1 = findShapeByPowerPointName(shapes1, "Merged Table") as Extract<OverlayShape, { type: "tableShape" }>;

    // Test fallback path (XML parsing)
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValue(new Error("unsupported pptx model"));
    const doc2 = await importPptx(pptx, "merged-table.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });
    vi.restoreAllMocks();
    const shapes2 = doc2.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const table2 = findShapeByPowerPointName(shapes2, "Merged Table") as Extract<OverlayShape, { type: "tableShape" }>;

    // The 4x4 source grid contains six continuation cells, leaving ten editable cells.
    expect(table1.props.table.cells).toHaveLength(10);
    expect(table2.props.table.cells).toHaveLength(10);

    // Verify colSpan and rowSpan are correctly set
    const cellWithColSpan = table1.props.table.cells.find(cell => cell.colSpan && cell.colSpan > 1);
    expect(cellWithColSpan).toBeDefined();
    expect(cellWithColSpan?.colSpan).toBeGreaterThan(1);

    const cellWithRowSpan = table1.props.table.cells.find(cell => cell.rowSpan && cell.rowSpan > 1);
    expect(cellWithRowSpan).toBeDefined();
    expect(cellWithRowSpan?.rowSpan).toBeGreaterThan(1);

    // Both paths should produce identical colSpan/rowSpan values
    table1.props.table.cells.forEach((cell1, index) => {
      const cell2 = table2.props.table.cells[index];
      expect(cell2).toBeDefined();
      expect(cell2?.colSpan).toEqual(cell1.colSpan);
      expect(cell2?.rowSpan).toEqual(cell1.rowSpan);
    });
  });

  it("records library load errors in metadata", async () => {
    const pptx = await createFixturePptx();
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValueOnce(new Error("Test library error"));
    const document = await importPptx(pptx, "lesson.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
    });
    const parsed = parseSigmaDocument(document);

    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;
    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);
  });

  it("preserves text from m:oMath formulas in paragraph text", async () => {
    const zip = new JSZip();
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
        <p:cSld>
          <p:spTree>
            <p:nvGrpSpPr><p:cNvPr id="1" name="Title 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
            <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="9144000" cy="6858000"/></a:xfrm></p:grpSpPr>
            <p:sp>
              <p:nvSpPr><p:cNvPr id="2" name="Shape 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
              <p:txBody>
                <a:bodyPr/>
                <a:lstStyle/>
                <a:p>
                  <a:r><a:t>Before </a:t></a:r>
                  <m:oMath>
                    <m:e><m:t>x</m:t></m:e>
                    <m:supPr/>
                    <m:sup><m:e><m:t>2</m:t></m:e></m:sup>
                  </m:oMath>
                  <a:r><a:t> after</a:t></a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`;

    zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`);
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`);
    zip.file("ppt/slides/slide1.xml", slideXml);
    zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);

    const pptx = await zip.generateAsync({ type: "uint8array" });
    vi.spyOn(PptxHandler.prototype, "load").mockRejectedValueOnce(new Error("unsupported OMML fixture"));
    const document = await importPptx(pptx, "test-omml.pptx", {
      importedAt: "2026-07-04T00:00:00.000Z",
    });

    const parsed = parseSigmaDocument(document);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const textShape = shapes.find((shape): shape is Extract<OverlayShape, { type: "text" }> => shape.type === "text");
    const text = textShape ? richTextPlainText(textShape.props.blocks) : "";

    expect(textShape).toBeDefined();
    expect(text).toContain("x");
    expect(text).toContain("2");
  });

  it("preserves all generated geometry shapes through document validation", async () => {
    const pptx = await createGeometryFixturePptx();
    const document = await importPptx(pptx, "source.pptx", {
      importedAt: "2026-07-19T00:00:00.000Z",
      visualRenderer: "none",
    });

    const parsed = parseSigmaDocument(document);
    const snapshot = parsed.pageLayout?.overlay?.overlaySnapshot;
    const shapes = snapshot?.shapes ?? [];

    expect(snapshot && isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(shapes.length).toBeGreaterThan(0);
    // Nothing may be dropped by the snapshot normalizer on the way into the
    // document: a shape that fails validation is a shape missing from the page.
    expect(shapes).toHaveLength(document.pageLayout?.overlay?.overlaySnapshot?.shapes.length ?? -1);
  });

});

async function createGeometryFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const presetShapes = [
    { id: 2, name: "Hexagon preset", preset: "hexagon", x: 457200, y: 457200, fill: "D9EAF7" },
    { id: 3, name: "Star preset", preset: "star5", x: 1828800, y: 457200, fill: "FFF2CC" },
    { id: 4, name: "Chevron preset", preset: "chevron", x: 3200400, y: 457200, fill: "E2F0D9" },
    { id: 5, name: "Wedge callout preset", preset: "wedgeRectCallout", x: 4572000, y: 457200, fill: "FCE4D6" },
    { id: 6, name: "Heart preset", preset: "heart", x: 5943600, y: 457200, fill: "F4CCCC" },
    { id: 7, name: "Arc preset", preset: "arc", x: 7315200, y: 457200, fill: "FFFFFF" },
    { id: 8, name: "Pie preset", preset: "pie", x: 7315200, y: 1828800, fill: "D9D2E9" },
  ].map(({ id, name, preset, x, y, fill }) => `
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1143000" cy="914400"/></a:xfrm>
          <a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>
          ${preset === "arc" ? "<a:noFill/>" : `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`}
          <a:ln w="19050"><a:solidFill><a:srgbClr val="1F2937"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>`).join("");

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${presetShapes}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="Holed custom geometry"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="2286000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:custGeom>
            <a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="100000" b="100000"/>
            <a:pathLst>
              <a:path w="100000" h="100000">
                <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                <a:lnTo><a:pt x="100000" y="0"/></a:lnTo>
                <a:lnTo><a:pt x="100000" y="100000"/></a:lnTo>
                <a:lnTo><a:pt x="0" y="100000"/></a:lnTo>
                <a:close/>
              </a:path>
              <a:path w="100000" h="100000">
                <a:moveTo><a:pt x="30000" y="30000"/></a:moveTo>
                <a:lnTo><a:pt x="30000" y="70000"/></a:lnTo>
                <a:lnTo><a:pt x="70000" y="70000"/></a:lnTo>
                <a:lnTo><a:pt x="70000" y="30000"/></a:lnTo>
                <a:close/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
          <a:solidFill><a:srgbClr val="BDD7EE"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="10" name="ArcTo custom geometry"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="3657600" y="2286000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:custGeom>
            <a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="100000" b="100000"/>
            <a:pathLst>
              <a:path w="100000" h="100000" fill="none">
                <a:moveTo><a:pt x="100000" y="50000"/></a:moveTo>
                <a:arcTo wR="50000" hR="50000" stAng="0" swAng="5400000"/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
          <a:noFill/>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createMergedTableFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  // Table with 4x4 grid with various merge patterns
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="Merged Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="914400" y="914400"/><a:ext cx="2743200" cy="1828800"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1"><a:tblStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tblStyleId></a:tblPr>
              <a:tblGrid><a:gridCol w="457200"/><a:gridCol w="457200"/><a:gridCol w="457200"/><a:gridCol w="457200"/></a:tblGrid>
              <a:tr h="304800">
                <a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"/><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="d9eaf7"/></a:solidFill></a:tcPr></a:tc>
                <a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="d9eaf7"/></a:solidFill></a:tcPr></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"/><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="e2f0d9"/></a:solidFill></a:tcPr></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"/><a:t>C</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="f4cccc"/></a:solidFill></a:tcPr></a:tc>
              </a:tr>
              <a:tr h="304800">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>D</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>
                <a:tc rowSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>E</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="fff2cc"/></a:solidFill></a:tcPr></a:tc>
                <a:tc vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="fff2cc"/></a:solidFill></a:tcPr></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>F</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>
              </a:tr>
              <a:tr h="304800">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>G</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>
                <a:tc vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="fff2cc"/></a:solidFill></a:tcPr></a:tc>
                <a:tc gridSpan="2" rowSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>I</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="cfe2f3"/></a:solidFill></a:tcPr></a:tc>
                <a:tc hMerge="1" vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="cfe2f3"/></a:solidFill></a:tcPr></a:tc>
              </a:tr>
              <a:tr h="304800">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>J</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"/><a:t>K</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>
                <a:tc hMerge="1" vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="cfe2f3"/></a:solidFill></a:tcPr></a:tc>
                <a:tc hMerge="1" vMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="cfe2f3"/></a:solidFill></a:tcPr></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);
  return zip.generateAsync({ type: "uint8array" });
}


function getPptxSvgWasmSource(): Uint8Array {
  return readFileSync(require.resolve("pptx-svg/wasm"));
}

async function createAutoFitPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Shrunk body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>
          <a:lstStyle/>
          <a:p><a:r><a:rPr sz="4000"/><a:t>Too much text for this box</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Plain body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:rPr sz="4000"/><a:t>Fits fine</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  return await zip.generateAsync({ type: "uint8array" });
}

async function createOutlineOnlyPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Framed box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="1828800" y="914400"/><a:ext cx="1939200" cy="1026600"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln cap="flat" cmpd="sng" w="9525"><a:solidFill><a:srgbClr val="9A7B28"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t></a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Filled control"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="457200" y="457200"/><a:ext cx="914400" cy="457200"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>
        </p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createMultiSlideLayoutPptx(): Promise<Uint8Array> {
  // 16:9 widescreen: 12192000 x 6858000 EMU = 1280 x 720 px at 96dpi.
  const slideBox = (id: number, name: string, xEmu: number, yEmu: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>
        </p:spPr>
      </p:sp>
      ${id === 4 ? `<p:sp>
        <p:nvSpPr><p:cNvPr id="99" name="Slide 3 corner"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="10363200" y="5943600"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill>
        </p:spPr>
      </p:sp>` : ""}
    </p:spTree>
  </p:cSld>
</p:sld>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`);
  // Same offset on every slide: 914400 x 457200 EMU = 96 x 48 px.
  zip.file("ppt/slides/slide1.xml", slideBox(2, "Slide 1 box", 914400, 457200));
  zip.file("ppt/slides/slide2.xml", slideBox(3, "Slide 2 box", 914400, 457200));
  zip.file("ppt/slides/slide3.xml", slideBox(4, "Slide 3 box", 914400, 457200));
  return await zip.generateAsync({ type: "uint8array" });
}

async function createFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Blue rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="685800"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
          <a:ln w="25400"><a:solidFill><a:srgbClr val="ff0000"/></a:solidFill><a:prstDash val="dash"/></a:ln>
        </p:spPr>
      </p:sp>
      <p:cxnSp>
        <p:nvCxnSpPr><p:cNvPr id="3" name="Arrow 1"/><p:cNvCxnSpPr><a:stCxn id="2" idx="1"/><a:endCxn id="6" idx="3"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>
        <p:spPr>
          <a:xfrm><a:off x="3429000" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
          <a:ln w="38100"><a:solidFill><a:srgbClr val="00aa00"/></a:solidFill><a:headEnd type="triangle"/></a:ln>
        </p:spPr>
      </p:cxnSp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Arc 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="1143000" y="2286000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="arc"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="7030a0"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="TextBox 1" descr="Body placeholder" title="本文"/><p:cNvSpPr txBox="1"><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1" sz="half"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="3657600" y="2514600"/><a:ext cx="1828800" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" i="1" u="sng" sz="1800"><a:solidFill><a:srgbClr val="c00000"/></a:solidFill></a:rPr><a:t>重要</a:t></a:r><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>な式</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="6" name="Green ellipse"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="6172200" y="1828800"/><a:ext cx="1371600" cy="1371600"/></a:xfrm>
          <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="70ad47"/></a:solidFill>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="7" name="Picture 1" descr="説明画像" title="図1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rIdImage1">
            <a:alphaModFix amt="75000"/>
            <a:blur rad="12700"/>
          </a:blip>
          <a:srcRect l="10000" t="20000" r="30000" b="40000"/>
          <a:stretch><a:fillRect l="5000" t="6000" r="7000" b="8000"/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="1371600" y="3771900"/><a:ext cx="914400" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="8" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="3429000" y="3771900"/><a:ext cx="1828800" cy="914400"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1" bandRow="1"><a:tblStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tblStyleId></a:tblPr>
              <a:tblGrid><a:gridCol w="609600"/><a:gridCol w="609600"/><a:gridCol w="609600"/></a:tblGrid>
              <a:tr h="365760">
                <a:tc gridSpan="2">
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>項目</a:t></a:r></a:p></a:txBody>
                  <a:tcPr anchor="ctr" marL="91440" marR="91440" marT="45720" marB="45720">
                    <a:solidFill><a:srgbClr val="d9eaf7"/></a:solidFill>
                    <a:lnT w="19050"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:prstDash val="dash"/></a:lnT>
                    <a:lnB w="19050"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:prstDash val="dash"/></a:lnB>
                    <a:lnL w="19050"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:prstDash val="dash"/></a:lnL>
                    <a:lnR w="19050"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:prstDash val="dash"/></a:lnR>
                  </a:tcPr>
                </a:tc>
                <a:tc hMerge="1">
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>
                  <a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="d9eaf7"/></a:solidFill></a:tcPr>
                </a:tc>
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>値</a:t></a:r></a:p></a:txBody>
                  <a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="d9eaf7"/></a:solidFill></a:tcPr>
                </a:tc>
              </a:tr>
              <a:tr h="365760">
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody>
                  <a:tcPr anchor="ctr"/>
                </a:tc>
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>y</a:t></a:r></a:p></a:txBody>
                  <a:tcPr anchor="ctr"/>
                </a:tc>
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody>
                  <a:tcPr anchor="ctr"/>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`);
  zip.file("ppt/media/image1.png", Buffer.from(TINY_PNG_BASE64, "base64"));
  return zip.generateAsync({ type: "uint8array" });
}

async function createThemeColorFallbackPptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/theme/theme1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Theme Colors">
  <a:themeElements>
    <a:clrScheme name="Custom">
      <a:dk1><a:srgbClr val="111111"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="222222"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="336699"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Theme color rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="685800"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:schemeClr val="accent1"><a:tint val="50000"/><a:alpha val="60000"/></a:schemeClr></a:solidFill>
          <a:ln w="25400"><a:solidFill><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Gradient rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="3200400" y="685800"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:gradFill>
            <a:gsLst>
              <a:gs pos="0"><a:schemeClr val="accent1"/></a:gs>
              <a:gs pos="100000"><a:srgbClr val="ff0000"><a:alpha val="50000"/></a:srgbClr></a:gs>
            </a:gsLst>
          </a:gradFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Pattern rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="5486400" y="685800"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:pattFill prst="pct20">
            <a:fgClr><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:fgClr>
            <a:bgClr><a:srgbClr val="ffffff"/></a:bgClr>
          </a:pattFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="Theme text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="2057400"/><a:ext cx="2743200" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p>
            <a:r><a:rPr b="1" sz="1800"><a:solidFill><a:schemeClr val="accent1"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t>Theme text</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="6" name="Custom triangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="4114800" y="2057400"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:custGeom>
            <a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst>
            <a:gdLst><a:gd name="mid" fmla="*/ w adj 100000"/></a:gdLst>
            <a:ahLst><a:ahXY gdRefX="adj" minX="0" maxX="100000"><a:pos x="mid" y="0"/></a:ahXY></a:ahLst>
            <a:cxnLst><a:cxn ang="0"><a:pos x="50000" y="0"/></a:cxn></a:cxnLst>
            <a:rect l="0" t="0" r="100000" b="100000"/>
            <a:pathLst>
              <a:path w="100000" h="100000">
                <a:moveTo><a:pt x="50000" y="0"/></a:moveTo>
                <a:lnTo><a:pt x="100000" y="100000"/></a:lnTo>
                <a:lnTo><a:pt x="0" y="100000"/></a:lnTo>
                <a:close/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
          <a:solidFill><a:srgbClr val="CCFFCC"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="008000"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="7" name="Custom curve"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="6400800" y="2057400"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:custGeom>
            <a:pathLst>
              <a:path w="100000" h="100000">
                <a:moveTo><a:pt x="0" y="100000"/></a:moveTo>
                <a:cubicBezTo>
                  <a:pt x="25000" y="0"/>
                  <a:pt x="75000" y="0"/>
                  <a:pt x="100000" y="100000"/>
                </a:cubicBezTo>
              </a:path>
            </a:pathLst>
          </a:custGeom>
          <a:noFill/>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="7030A0"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="8" name="Adjusted triangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="3429000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="triangle">
            <a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst>
          </a:prstGeom>
          <a:solidFill><a:srgbClr val="FFFFCC"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="C09000"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="Adjusted arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="3200400" y="3429000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rightArrow">
            <a:avLst>
              <a:gd name="adj" fmla="val 60000"/>
              <a:gd name="adj2" fmla="val 30000"/>
            </a:avLst>
          </a:prstGeom>
          <a:solidFill><a:srgbClr val="CCE5FF"/></a:solidFill>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="0070C0"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="10" name="Custom arc"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="5486400" y="3429000"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
          <a:custGeom>
            <a:pathLst>
              <a:path w="100000" h="100000">
                <a:moveTo><a:pt x="100000" y="50000"/></a:moveTo>
                <a:arcTo wR="50000" hR="50000" stAng="0" swAng="5400000"/>
              </a:path>
            </a:pathLst>
          </a:custGeom>
          <a:noFill/>
          <a:ln w="19050"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="11" name="Fallback bullets"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="4457700"/><a:ext cx="4572000" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p>
            <a:pPr lvl="0" algn="left">
              <a:buClr><a:schemeClr val="accent1"/></a:buClr>
              <a:buFont typeface="Aptos"/>
              <a:buSzPts val="1600"/>
              <a:buChar char="•"/>
            </a:pPr>
            <a:r><a:rPr sz="1600"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>First XML bullet</a:t></a:r>
          </a:p>
          <a:p>
            <a:pPr lvl="0">
              <a:buAutoNum type="arabicPeriod" startAt="4"/>
            </a:pPr>
            <a:r><a:rPr sz="1600"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Numbered XML bullet</a:t></a:r>
          </a:p>
          <a:p>
            <a:pPr lvl="1" algn="ctr">
              <a:lnSpc><a:spcPct val="115000"/></a:lnSpc>
              <a:buClr><a:schemeClr val="accent6"/></a:buClr>
              <a:buFont typeface="Aptos"/>
              <a:buSzPts val="1800"/>
              <a:buChar char="-"/>
            </a:pPr>
            <a:r><a:rPr sz="1600"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Nested XML bullet</a:t></a:r>
          </a:p>
          <a:p>
            <a:pPr><a:buNone/></a:pPr>
            <a:r><a:rPr sz="1600"><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Plain XML paragraph</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  return zip.generateAsync({ type: "uint8array" });
}

/**
 * One slide object can produce a group plus generated children, all carrying the
 * object's name. Children append a suffix to the parent's id, so the shortest id
 * among the matches is the object's own shape.
 */
function findShapeByPowerPointName(shapes: OverlayShape[], name: string): OverlayShape {
  const matches = shapes.filter((item) => getPowerPointShapeName(item) === name);
  const shape = [...matches].sort((a, b) => a.id.length - b.id.length)[0];
  expect(shape, `shape named ${name}`).toBeDefined();
  return shape!;
}

const powerPointShapeNames = new Map<string, string>();

async function importPptx(
  ...args: Parameters<typeof importPowerPointPptxBuffer>
): Promise<SigmaDocument> {
  const document = await importPowerPointPptxBuffer(...args);
  const extension = document.pageLayout?.overlay?.overlaySnapshot?.extensions?.["sigma.powerpoint"];
  const shapeNames = (extension as { shapeNames?: Record<string, string> } | undefined)?.shapeNames ?? {};
  for (const [shapeId, name] of Object.entries(shapeNames)) {
    powerPointShapeNames.set(shapeId, name);
  }
  return document;
}

function getPowerPointShapeName(shape: OverlayShape): unknown {
  return powerPointShapeNames.get(shape.id);
}

/**
 * Chart and SmartArt children are generated shapes, so they are addressed by the
 * `<groupId>_<part>_<n>` ids the importer assigns rather than by a slide-object name.
 */
function isPowerPointChartPart(shape: OverlayShape, part: string): boolean {
  return new RegExp(`_${part}_\\d`, "u").test(shape.id);
}

function richTextPlainText(blocks: OverlayTextBlock[]): string {
  return blocks
    .map((block) => (block.type === "list"
      ? block.items.map((item) => item.children.map((child) => (child.type === "text" ? child.text : "")).join("")).join("\n")
      : overlayTextBlockInlineRuns(block).map((child) => (child.type === "text" ? child.text : "")).join("")))
    .join("\n");
}

function decodeDataUrl(dataUrl: string): string {
  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64").toString("utf8");
}

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJgYGB4T8ABBgCAgnYqE0AAAAASUVORK5CYII=";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

function createInternalObjectModel(): PptxData {
  return {
    width: 960,
    height: 540,
    slideSizeType: "screen16x9",
    notesWidthEmu: 6858000,
    notesHeightEmu: 9144000,
    sections: [
      { id: "section_1", name: "Section A", firstSlideId: "slide_1", slideIds: ["slide_1"] },
    ],
    customShows: [
      { id: "custom_show_1", name: "Review path", slideIds: ["slide_1"] },
    ],
    commentAuthors: [
      { id: "0", name: "Reviewer", initials: "RV", lastIdx: 1, clrIdx: 0 },
    ],
    coreProperties: { title: "Internal deck", creator: "Sigma QA" },
    appProperties: { application: "Microsoft PowerPoint", slides: 1, notes: 1 },
    customProperties: [
      { name: "Project", value: "Sigma", type: "lpwstr" },
    ],
    presentationProperties: { showSpecialPlsOnTitleSld: true },
    theme: {
      name: "Office",
      colorScheme: { name: "Office", accent1: "#4472C4" },
      fontScheme: { name: "Office" },
      formatScheme: { name: "Office", fillStyles: [], lineStyles: [], effectStyles: [], bgFillStyles: [] },
    },
    themeColorMap: {
      dk1: "#000000",
      lt1: "#FFFFFF",
      accent1: "#4472C4",
      hlink: "#0563C1",
    },
    themeOptions: [
      { path: "ppt/theme/theme1.xml", name: "Office" },
    ],
    tableStyleMap: {
      "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": {
        name: "Medium Style 2 - Accent 1",
        wholeTable: { fillColor: "#D9EAF7", textColor: "#111827" },
      },
    },
    isPasswordProtected: false,
    embeddedFonts: [
      {
        name: "Sigma Sans",
        dataUrl: "data:font/woff;base64,AAAA",
        bold: true,
        format: "woff",
        rawFontData: new Uint8Array([1, 2, 3]),
        partPath: "ppt/fonts/sigma-sans.fntdata",
      },
    ],
    mruColors: ["#111827"],
    presentationGuides: [
      { id: "guide_1", orientation: "vert", positionEmu: 914400 },
    ],
    viewProperties: {
      lastView: "sldView",
      showComments: true,
      slideViewPr: {
        snapToGrid: true,
        showGuides: true,
        scale: { n: 100, d: 100 },
      },
    },
    modifyVerifier: {
      algorithmName: "SHA-512",
      hashData: "hash==",
      saltData: "salt==",
      spinValue: 100000,
    },
    photoAlbum: {
      layout: "1pic",
      showCaptions: true,
      frame: "frameStyle1",
    },
    kinsoku: {
      lang: "ja-JP",
      invalStChars: "、。",
      invalEndChars: "（",
    },
    customXmlParts: [
      {
        id: "1",
        schemaUri: "urn:sigma",
        data: "<root><value>42</value></root>",
        properties: "<props/>",
        rels: "<rels/>",
      },
    ],
    customerData: [
      {
        id: "ppt/customerData/item1.xml",
        relId: "rIdCustomer",
        data: "<customer/>",
      },
    ],
    thumbnailData: new Uint8Array([137, 80, 78, 71]),
    slides: [{
      id: "slide_1",
      rId: "rId1",
      layoutPath: "ppt/slideLayouts/slideLayout1.xml",
      layoutName: "Title and Content",
      slideNumber: 1,
      sectionName: "Section A",
      sectionId: "section_1",
      transition: {
        type: "fade",
        durationMs: 700,
        advanceOnClick: true,
      },
      notes: "Remember to explain the linked workbook.",
      notesSegments: [
        { text: "Remember to explain the linked workbook.", style: { fontSize: 12, color: "#111827" } },
      ],
      notesShapes: [
        {
          type: "text",
          id: "notes_text_1",
          name: "Notes Placeholder",
          x: 0,
          y: 0,
          width: 300,
          height: 120,
          text: "Remember to explain the linked workbook.",
          textSegments: [
            { text: "Remember to explain the linked workbook.", style: { fontSize: 12, color: "#111827" } },
          ],
        },
      ],
      comments: [
        {
          id: "comment_1",
          text: "Check the embedded sheet.",
          author: "Reviewer",
          createdAt: "2026-07-04T00:00:00.000Z",
          elementId: "ole_1",
        },
      ],
      animations: [
        {
          elementId: "link_text_1",
          entrance: "fadeIn",
          durationMs: 600,
          order: 1,
          trigger: "onClick",
        },
      ],
      elements: [
        {
          type: "ole",
          id: "ole_1",
          name: "Spreadsheet",
          x: 24,
          y: 32,
          width: 120,
          height: 80,
          oleProgId: "Excel.Sheet.12",
          oleObjectType: "excel",
          oleEmbeddedFileName: "data.xlsx",
          oleEmbeddedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          oleEmbeddedByteSize: 128,
          oleEmbeddedData: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AAAA",
          previewImageData: TINY_PNG_DATA_URL,
        },
        {
          type: "media",
          id: "media_1",
          name: "Video clip",
          x: 160,
          y: 32,
          width: 160,
          height: 90,
          mediaType: "video",
          mediaPath: "ppt/media/media1.mp4",
          mediaMimeType: "video/mp4",
          posterFrameData: TINY_PNG_DATA_URL,
          hidden: true,
          opacity: 0.65,
          autoPlay: true,
          loop: true,
          volume: 0.75,
          playbackSpeed: 1.25,
        },
        {
          type: "ink",
          id: "ink_1",
          name: "Ink strokes",
          x: 40,
          y: 160,
          width: 60,
          height: 30,
          inkPaths: ["M 0 0 L 20 10 L 40 0"],
          inkColors: ["#C00000"],
          inkWidths: [3],
          inkOpacities: [0.8],
          inkTool: "pen",
        },
        {
          type: "zoom",
          id: "zoom_1",
          name: "Zoom 1",
          x: 340,
          y: 32,
          width: 120,
          height: 68,
          zoomType: "slide",
          targetSlideIndex: 2,
          imageData: TINY_PNG_DATA_URL,
        },
        {
          type: "model3d",
          id: "model3d_1",
          name: "Model 1",
          x: 480,
          y: 32,
          width: 100,
          height: 100,
          modelPath: "ppt/media/model1.glb",
          modelData: "data:model/gltf-binary;base64,AAAA",
          modelMimeType: "model/gltf-binary",
          posterImage: TINY_PNG_DATA_URL,
        },
        {
          type: "text",
          id: "link_text_1",
          name: "Linked text",
          x: 40,
          y: 220,
          width: 240,
          height: 48,
          opacity: 0.5,
          actionClick: {
            url: "https://example.com",
            tooltip: "Open example",
            highlightClick: true,
          },
          locks: {
            noMove: true,
            noResize: true,
          },
          text: "Open link 1",
          textStyle: { fontSize: 18, color: "#111827" },
          textSegments: [
            { text: "Open ", style: { fontSize: 18, color: "#111827" } },
            {
              text: "link",
              style: {
                fontSize: 18,
                color: "#0563C1",
                underline: true,
                hyperlink: "https://example.com/run",
                hyperlinkTooltip: "Run link",
                hyperlinkAction: "ppaction://hlinkshowjump",
                hyperlinkTargetSlideIndex: 1,
              },
            },
            {
              text: "1",
              style: { fontSize: 18, color: "#111827" },
              fieldType: "slidenum",
              fieldGuid: "{field-guid}",
            },
          ],
          promptText: "Click to add title",
          linkedTxbxId: 9,
          linkedTxbxSeq: 0,
          rawXml: {
            "p:sp": {
              "p:nvSpPr": {
                "p:cNvPr": {
                  "@_id": "9",
                  "@_name": "Linked text",
                  "@_descr": "Linked placeholder description",
                  "@_title": "Linked title",
                  "a:hlinkClick": {
                    "@_r:id": "rIdExternal",
                    "@_tooltip": "Open example",
                  },
                },
                "p:cNvSpPr": {
                  "a:spLocks": { "@_noGrp": "1" },
                },
                "p:nvPr": {
                  "p:ph": { "@_type": "body", "@_idx": "1", "@_sz": "half", "@_orient": "horz" },
                },
              },
            },
          },
        },
        {
          type: "text",
          id: "bullet_text_1",
          name: "Bullet text",
          x: 310,
          y: 220,
          width: 220,
          height: 96,
          text: "First\nSecond\nNested",
          textStyle: { fontSize: 16, color: "#111827" },
          textSegments: [
            {
              text: "First",
              style: { fontSize: 16, color: "#111827", align: "left", lineSpacing: 1.2 },
              bulletInfo: { char: "\u2022", color: "#111827" },
              paragraphLevel: 0,
            },
            { text: "", style: {}, isParagraphBreak: true },
            {
              text: "Second",
              style: { fontSize: 16, color: "#111827", align: "left", lineSpacing: 1.2 },
              bulletInfo: { autoNumType: "arabicPeriod", autoNumStartAt: 3 },
              paragraphLevel: 0,
            },
            { text: "", style: {}, isParagraphBreak: true },
            {
              text: "Nested",
              style: { fontSize: 16, color: "#111827", align: "center", lineSpacing: 1.2, highlightColor: "#FFF2CC" },
              bulletInfo: { char: "-" },
              paragraphLevel: 1,
            },
          ],
        },
      ],
    }],
  } as unknown as PptxData;
}

function createMasterLayoutModel(): PptxData {
  return {
    width: 960,
    height: 540,
    layoutOptions: [
      {
        path: "ppt/slideLayouts/slideLayout1.xml",
        name: "Title and Content",
        type: "obj",
        masterPath: "ppt/slideMasters/slideMaster1.xml",
      },
    ],
    theme: {
      name: "Office",
      colorScheme: { name: "Office", accent1: "#4472C4" },
      fontScheme: { name: "Office" },
    },
    slideMasters: [
      {
        path: "ppt/slideMasters/slideMaster1.xml",
        name: "Office Master",
        backgroundColor: "#F8FAFC",
        themePath: "ppt/theme/theme1.xml",
        layoutPaths: ["ppt/slideLayouts/slideLayout1.xml"],
        placeholders: [{ type: "title", idx: "1" }],
        txStyles: {
          titleStyle: {
            0: { fontSize: 36, bold: true, color: "#111827" },
          },
          bodyStyle: {
            0: { fontSize: 18, color: "#1F2937" },
          },
        },
        elements: [
          {
            type: "text",
            id: "2",
            name: "Master footer",
            x: 720,
            y: 500,
            width: 200,
            height: 28,
            text: "Confidential",
            textSegments: [
              { text: "Confidential", style: { fontSize: 10, color: "#64748B" } },
            ],
            rawXml: {
              "p:sp": {
                "p:nvSpPr": { "p:cNvPr": { "@_id": "2", "@_name": "Master footer" } },
              },
            },
          },
        ],
        layouts: [
          {
            path: "ppt/slideLayouts/slideLayout1.xml",
            name: "Title and Content",
            backgroundColor: "#EEF6FF",
            matchingName: "Title and Content",
            preserve: true,
            placeholders: [{ type: "body", idx: "1" }],
            elements: [
              {
                type: "shape",
                id: "2",
                name: "Layout accent",
                x: 40,
                y: 84,
                width: 880,
                height: 8,
                shapeType: "rect",
                shapeStyle: {
                  fillColor: "#2563EB",
                  strokeColor: "#2563EB",
                  strokeWidth: 0,
                },
                rawXml: {
                  "p:sp": {
                    "p:nvSpPr": { "p:cNvPr": { "@_id": "2", "@_name": "Layout accent" } },
                    "p:spPr": { "a:prstGeom": { "@_prst": "rect" } },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
    slides: [
      {
        id: "slide_1",
        rId: "rId1",
        layoutPath: "ppt/slideLayouts/slideLayout1.xml",
        layoutName: "Title and Content",
        slideNumber: 1,
        elements: [
          {
            type: "text",
            id: "2",
            name: "Slide title",
            x: 40,
            y: 24,
            width: 640,
            height: 52,
            text: "Inherited layout test",
            textSegments: [
              { text: "Inherited layout test", style: { fontSize: 28, bold: true, color: "#111827" } },
            ],
            rawXml: {
              "p:sp": {
                "p:nvSpPr": { "p:cNvPr": { "@_id": "2", "@_name": "Slide title" } },
              },
            },
          },
        ],
      },
    ],
  } as unknown as PptxData;
}

async function createEmptyFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="mp3" ContentType="audio/mpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
  <Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rIdTableStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment1.xml"/>
  <Relationship Id="rIdAudio" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio" Target="../media/audio1.mp3"/>
  <Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`);
  zip.file("ppt/notesSlides/notesSlide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Notes">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Remember to explain the linked workbook.</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`);
  zip.file("ppt/comments/comment1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm authorId="0" dt="2026-07-04T00:00:00Z" idx="1">
    <p:pos x="0" y="0"/>
    <p:text>Check the embedded sheet.</p:text>
  </p:cm>
</p:cmLst>`);
  zip.file("ppt/media/audio1.mp3", new Uint8Array([0x49, 0x44, 0x33]));
  zip.file("ppt/theme/theme1.xml", `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"/>`);
  zip.file("ppt/tableStyles.xml", `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`);
  zip.file("customXml/item1.xml", `<root><value>42</value></root>`);
  zip.file("customXml/itemProps1.xml", `<props/>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createXmlMasterLayoutFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="XML Slide">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="XML Slide title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="685800"/><a:ext cx="3657600" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/><a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"/><a:t>Slide title</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="XML Slide body"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="1600200"/><a:ext cx="3657600" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/><a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Inherited body text</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`);
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="XML Layout">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="XML Layout accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="3429000"/><a:ext cx="1828800" cy="342900"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="D9EAF7"/></a:solidFill>
          <a:ln><a:noFill/></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="XML Layout body style"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="1600200"/><a:ext cx="3657600" cy="685800"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/><a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2200"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>Layout body style</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);
  zip.file("ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="XML Master">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="XML Master footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="914400" y="4457700"/><a:ext cx="3657600" cy="342900"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/><a:ln><a:noFill/></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>Master footer</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldMaster>`);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`);
  zip.file("ppt/theme/theme1.xml", `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"/>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createGroupedFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="2" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="457200"/></a:xfrm></p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="3" name="Grouped rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="f4b183"/></a:solidFill>
            <a:ln w="12700"><a:solidFill><a:srgbClr val="7f6000"/></a:solidFill></a:ln>
          </p:spPr>
        </p:sp>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="4" name="Grouped label"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="571500" y="0"/><a:ext cx="342900" cy="457200"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
            <a:ln><a:noFill/></a:ln>
          </p:spPr>
          <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>G</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:grpSp>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="5" name="Google table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="265708" y="3429000"/><a:ext cx="3000000" cy="3000000"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1" bandRow="1"/>
              <a:tblGrid><a:gridCol w="2250000"/><a:gridCol w="6362600"/></a:tblGrid>
              <a:tr h="427200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>項目</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>値</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
              <a:tr h="427200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createBackgroundFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  return zip.generateAsync({ type: "uint8array" });
}

async function createChartFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
  <Override PartName="/ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="Sales chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="914400" y="685800"/><a:ext cx="4572000" cy="2743200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart r:id="rIdChart1"/>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`);
  zip.file("ppt/charts/chart1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>売上</a:t></a:r></a:p></c:rich></c:tx>
    </c:title>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:spPr><a:solidFill><a:srgbClr val="5B9BD5"/></a:solidFill></c:spPr>
          <c:marker>
            <c:symbol val="circle"/>
            <c:size val="7"/>
            <c:spPr><a:solidFill><a:srgbClr val="5B9BD5"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill></a:ln></c:spPr>
          </c:marker>
          <c:dPt>
            <c:idx val="1"/>
            <c:spPr><a:solidFill><a:srgbClr val="70AD47"/></a:solidFill></c:spPr>
            <c:invertIfNegative val="0"/>
          </c:dPt>
          <c:dLbls>
            <c:dLbl>
              <c:idx val="0"/>
              <c:dLblPos val="outEnd"/>
              <c:showVal val="1"/>
              <c:showCatName val="0"/>
            </c:dLbl>
            <c:showVal val="1"/>
            <c:showCatName val="1"/>
            <c:dLblPos val="outEnd"/>
          </c:dLbls>
          <c:trendline>
            <c:trendlineType val="linear"/>
            <c:dispEq val="1"/>
            <c:dispRSqr val="1"/>
            <c:spPr><a:ln><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln></c:spPr>
          </c:trendline>
          <c:errBars>
            <c:errDir val="y"/>
            <c:errBarType val="both"/>
            <c:errValType val="fixedVal"/>
            <c:val val="2"/>
          </c:errBars>
          <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>2025</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c:ser>
        <c:ser>
          <c:idx val="1"/><c:order val="1"/>
          <c:spPr><a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill></c:spPr>
          <c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>2026</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>24</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c:ser>
        <c:axId val="123456"/><c:axId val="654321"/>
      </c:barChart>
      <c:catAx><c:axId val="123456"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="654321"/></c:catAx>
      <c:valAx><c:axId val="654321"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/><c:max val="30"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:majorUnit val="10"/><c:crossAx val="123456"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
    <c:plotVisOnly val="1"/>
    <c:externalData r:id="rIdWorkbook"><c:autoUpdate val="0"/></c:externalData>
  </c:chart>
</c:chartSpace>`);
  zip.file("ppt/charts/_rels/chart1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdWorkbook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/>
</Relationships>`);
  zip.file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  return zip.generateAsync({ type: "uint8array" });
}

async function createSmartArtFixturePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>
  <Override PartName="/ppt/diagrams/layout1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"/>
  <Override PartName="/ppt/diagrams/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramDrawing+xml"/>
  <Override PartName="/ppt/diagrams/colors1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"/>
  <Override PartName="/ppt/diagrams/quickStyle1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramQuickStyle+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
</p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="Process SmartArt"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="914400" y="685800"/><a:ext cx="4572000" cy="1828800"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
            <dgm:relIds r:dm="rIdData1" r:lo="rIdLayout1" r:dr="rIdDrawing1" r:cs="rIdColors1" r:qs="rIdQuickStyle1"/>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  zip.file("ppt/slides/_rels/slide1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdData1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data1.xml"/>
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout" Target="../diagrams/layout1.xml"/>
  <Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>
  <Relationship Id="rIdColors1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors" Target="../diagrams/colors1.xml"/>
  <Relationship Id="rIdQuickStyle1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle" Target="../diagrams/quickStyle1.xml"/>
</Relationships>`);
  zip.file("ppt/diagrams/data1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram">
  <dgm:ptLst>
    <dgm:pt modelId="node1" type="node"><dgm:t><a:p><a:r><a:t>Plan</a:t></a:r></a:p></dgm:t></dgm:pt>
    <dgm:pt modelId="node2" type="node"><dgm:t><a:p><a:r><a:t>Build</a:t></a:r></a:p></dgm:t></dgm:pt>
  </dgm:ptLst>
  <dgm:cxnLst>
    <dgm:cxn modelId="cxn1" type="parOf" srcId="node1" destId="node2" srcOrd="0" destOrd="0"/>
  </dgm:cxnLst>
</dgm:dataModel>`);
  zip.file("ppt/diagrams/layout1.xml", `<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="process"/>`);
  zip.file("ppt/diagrams/colors1.xml", `<dgm:colorsDef xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="colorful1" title="Colorful">
  <dgm:fillClrLst>
    <a:solidFill><a:srgbClr val="D9EAF7"/></a:solidFill>
    <a:solidFill><a:srgbClr val="E2F0D9"/></a:solidFill>
  </dgm:fillClrLst>
  <dgm:linClrLst>
    <a:solidFill><a:srgbClr val="0070C0"/></a:solidFill>
    <a:solidFill><a:srgbClr val="70AD47"/></a:solidFill>
  </dgm:linClrLst>
</dgm:colorsDef>`);
  zip.file("ppt/diagrams/quickStyle1.xml", `<dgm:styleDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" uniqueId="moderateEffect" title="Moderate Effect" effect="moderate"/>`);
  zip.file("ppt/diagrams/drawing1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="10" name="Plan drawing"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="685800"/></a:xfrm>
          <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="D9EAF7"/></a:solidFill>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="0070C0"/></a:solidFill></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Plan</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="11" name="Build drawing"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="2743200" y="914400"/><a:ext cx="1828800" cy="685800"/></a:xfrm>
          <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="E2F0D9"/></a:solidFill>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="70AD47"/></a:solidFill></a:ln>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="111827"/></a:solidFill></a:rPr><a:t>Build</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);
  return zip.generateAsync({ type: "uint8array" });
}
