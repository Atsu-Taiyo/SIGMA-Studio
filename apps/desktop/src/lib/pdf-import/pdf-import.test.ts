import { describe, expect, it } from "vitest";
import { getPageMetrics, PAGE_GAP_PX, type OverlayTextShape, type SigmaDocument } from "@/features/document";
import { recoverSigmaDocument } from "@/lib/sigma-doc-schema";
import { buildPdfImportDocument, isPdfFilename, type PdfTextMeasurer } from "./build-document";
import { buildPdfGraphicsSvg, compactPathData, type PdfDraw } from "./graphics-svg";
import { readPdfImportResult } from "./import-pdf-file";
import { groupGlyphsIntoRuns, type PdfGlyph } from "./text-runs";
import type { PdfImportResult } from "./types";

const glyph = (text: string, x: number, overrides: Partial<PdfGlyph> = {}): PdfGlyph => ({
  text, x, y: 100, advance: 10, fontSizePx: 10, angle: 0, color: "#000000", font: "sans", ...overrides,
});

/** 1 文字を em 幅 (和文) / 0.5em 幅 (欧文) とみなす測り方。 */
const measurer: PdfTextMeasurer = {
  width: (text, _face, size) => Array.from(text).reduce((sum, char) => sum + (/[　-鿿]/u.test(char) ? size : size / 2), 0),
  metrics: () => ({ ascent: 0.9, descent: 0.1 }),
};

describe("groupGlyphsIntoRuns", () => {
  it("joins glyphs on one baseline and keeps the PDF advance as the width", () => {
    const runs = groupGlyphsIntoRuns([glyph("薬", 0), glyph("理", 10), glyph("学", 20)]);
    expect(runs).toEqual([expect.objectContaining({ text: "薬理学", x: 0, y: 100, width: 30, fontSizePx: 10 })]);
  });

  it("inserts one space for a Latin word gap and splits wide gaps", () => {
    const runs = groupGlyphsIntoRuns([
      glyph("a", 0, { advance: 5 }), glyph("b", 5, { advance: 5 }),
      glyph("c", 13, { advance: 5 }),
      glyph("d", 60, { advance: 5 }),
    ]);
    expect(runs.map((run) => run.text)).toEqual(["ab c", "d"]);
    expect(runs[0]!.width).toBe(18);
  });

  it("keeps explicit space glyphs and trims them at the edges", () => {
    const runs = groupGlyphsIntoRuns([
      glyph(" ", 0, { advance: 3 }), glyph("x", 3, { advance: 5 }), glyph(" ", 8, { advance: 3 }), glyph("y", 11, { advance: 5 }), glyph(" ", 16, { advance: 3 }),
    ]);
    expect(runs).toEqual([expect.objectContaining({ text: "x y", x: 3, width: 13 })]);
  });

  it("splits at a style, size, colour or baseline change", () => {
    const runs = groupGlyphsIntoRuns([
      glyph("A", 0), glyph("B", 10, { bold: true }), glyph("C", 20, { bold: true, color: "#ff0000" }),
      glyph("D", 30, { bold: true, color: "#ff0000", fontSizePx: 7 }), glyph("E", 40, { y: 140 }),
    ]);
    expect(runs.map((run) => run.text)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("starts a new run when the text returns to the left (next line)", () => {
    const runs = groupGlyphsIntoRuns([glyph("一", 0), glyph("二", 10), glyph("三", 0, { y: 101 })]);
    expect(runs.map((run) => run.text)).toEqual(["一二", "三"]);
  });

  it("expands ligatures and drops glyphs without text", () => {
    const runs = groupGlyphsIntoRuns([glyph("ﬁ", 0, { advance: 6 }), glyph("x", 6, { advance: 5 }), glyph("", 11)]);
    expect(runs.map((run) => run.text)).toEqual(["fix"]);
  });
});

describe("buildPdfGraphicsSvg", () => {
  const fill = (color: string, d = "M0 0L10 0L10 10Z"): PdfDraw => ({ kind: "fill", d, color, rule: "nonzero", matrix: [1, 0, 0, 1, 0, 0], clip: null, opacity: 1 });

  it("returns null for a page that only paints the white paper", () => {
    expect(buildPdfGraphicsSvg([fill("#ffffff"), fill("rgba(0,0,0,0)")], 100, 200)).toBeNull();
  });

  it("writes strokes, clips and the recorded scale into a self-contained SVG", () => {
    const clip = { parent: null, matrix: [1, 0, 0, 1, 0, 0] as const, d: "M0 0L50 0L50 50Z", rule: "nonzero" as const };
    const svg = buildPdfGraphicsSvg([
      fill("#ffffff"),
      { kind: "stroke", d: "M0 0L20.123456 0", color: "#126d70", lineWidth: 2, lineCap: "round", lineJoin: "miter", miterLimit: 10, dash: [3, 1], dashOffset: 0, matrix: [2, 0, 0, 2, 0, 0], clip, opacity: 0.5 },
    ], 100, 200, 2)!;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100" height="200" viewBox="0 0 200 400"/u);
    expect(svg).toContain('<clipPath id="c1"><path d="M0 0L50 0L50 50Z"/></clipPath>');
    expect(svg).toContain('<g clip-path="url(#c1)"><path d="M0 0L20.123 0" transform="matrix(2 0 0 2 0 0)" fill="none" stroke="#126d70" stroke-width="2" stroke-linecap="round" stroke-miterlimit="10" stroke-dasharray="3 1" stroke-opacity="0.5"/></g>');
    expect(svg).not.toContain("#ffffff");
  });

  it("crops images through a nested viewport", () => {
    const svg = buildPdfGraphicsSvg([{
      kind: "image", href: "data:image/png;base64,AAAA", imageWidth: 40, imageHeight: 20,
      sx: 10, sy: 0, sw: 20, sh: 20, dx: 0, dy: -1, dw: 1, dh: 1, matrix: [100, 0, 0, 50, 5, 6], clip: null, opacity: 1,
    }], 100, 100)!;
    expect(svg).toContain('viewBox="10 0 20 20"');
    expect(svg).toContain('<image href="data:image/png;base64,AAAA" width="40" height="20" preserveAspectRatio="none"/>');
  });

  it("rounds path numbers", () => {
    expect(compactPathData("M0.00001 1.23456L-0.0004 2e-7")).toBe("M0 1.235L0 0");
  });
});

function sampleResult(pageCount: number): PdfImportResult {
  return {
    pageCount,
    issues: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      widthPx: 793.7,
      heightPx: 1122.5,
      runs: index === pageCount - 1 ? [] : [
        { text: `第${index + 1}問`, x: 50, y: 100, width: 40, fontSizePx: 13.333, angle: 0, color: "#20323d", font: "sans" as const, bold: true },
        { text: "x", x: 400, y: 200, width: 6, fontSizePx: 10, angle: -Math.PI / 2, color: "#000000", font: "serif" as const, italic: true },
      ],
      graphicsSvg: index % 2 === 0 ? '<svg xmlns="http://www.w3.org/2000/svg" width="793.7" height="1122.5" viewBox="0 0 793.7 1122.5"><path d="M0 0L1 1" fill="#000"/></svg>' : null,
    })),
  };
}

describe("buildPdfImportDocument", () => {
  const build = (result: PdfImportResult): SigmaDocument => buildPdfImportDocument(result, {
    filename: "教材.pdf", importedAt: "2026-11-26T00:00:00.000Z", measurer, idPrefix: "pdf_t",
  });

  it("places every page at the stride the document's own page layout produces", () => {
    const document = build(sampleResult(200));
    const metrics = getPageMetrics(document.pageLayout!);
    const shapes = document.pageLayout!.overlay!.overlaySnapshot!.shapes;
    const title = shapes.find((shape) => shape.id === "pdf_t_p150_t1") as OverlayTextShape;
    // 行高 1 の行では、ベースラインは上端から (0.5 + (0.9 - 0.1) / 2)em = 0.9em。
    expect(title.y).toBeCloseTo(149 * (metrics.page.heightPx + PAGE_GAP_PX) + 100 - 13.333 * 0.9, 2);
    expect(title.x).toBe(50);
    expect(title.props).toMatchObject({ textWrap: "none", color: "#20323d", fontSize: 10, w: 40 });
    // 「第150問」は和文 2 字 + 数字 3 字 = 13.333 × 2 + 6.667 × 3 ≒ 46.67px。PDF の 40px へ縮める。
    expect(title.props.textScaleX).toBeCloseTo(40 / 46.666, 3);
    expect(title.props.blocks[0]).toMatchObject({ children: [{ text: "第150問", marks: ["bold"] }] });
    expect(metrics.page.widthMm).toBeCloseTo(210, 1);
    expect(metrics.page.heightMm).toBeCloseTo(297, 1);
  });

  it("rotates text around the computed top-left so the baseline origin stays put", () => {
    const shapes = build(sampleResult(2)).pageLayout!.overlay!.overlaySnapshot!.shapes;
    const rotated = shapes.find((shape) => shape.id === "pdf_t_p1_t2") as OverlayTextShape;
    expect(rotated.rotation).toBeCloseTo(-Math.PI / 2, 5);
    // 図形の中心で回したとき、図形内の (0, baseline) が PDF の原点 (400, 200) へ来る。
    const { w, h } = rotated.props;
    const theta = rotated.rotation!;
    const vx = -w / 2, vy = 9 - h / 2;
    expect(rotated.x + w / 2 + vx * Math.cos(theta) - vy * Math.sin(theta)).toBeCloseTo(400, 3);
    expect(rotated.y + h / 2 + vx * Math.sin(theta) + vy * Math.cos(theta)).toBeCloseTo(200, 3);
    expect(rotated.props.textScaleX).toBeCloseTo(6 / 5, 3);
  });

  it.each([[2, 1.5], [1.6, 2]])("fits oversized pages (%s × %s) with the same scale for graphics and text", (widthFactor, heightFactor) => {
    const result = sampleResult(3);
    const original = result.pages[0]!;
    const oversized = result.pages[1]!;
    oversized.widthPx = original.widthPx * widthFactor;
    oversized.heightPx = original.heightPx * heightFactor;
    oversized.graphicsSvg = original.graphicsSvg;
    oversized.runs = [{ ...original.runs[0]!, x: 1200, y: 1400, width: 120, fontSizePx: 24 }];

    const document = build(result);
    const layout = document.pageLayout!;
    const stride = getPageMetrics(layout).page.heightPx + PAGE_GAP_PX;
    const shapes = layout.overlay!.overlaySnapshot!.shapes;
    const graphics = shapes.find((shape) => shape.id === "pdf_t_p2_graphics");
    const title = shapes.find((shape) => shape.id === "pdf_t_p2_t1");
    expect(graphics?.type).toBe("image");
    if (graphics?.type !== "image") throw new Error("Missing page background");
    expect(graphics.x).toBe(0);
    expect(graphics.y).toBeCloseTo(stride, 2);
    expect(graphics.props.w).toBeCloseTo(oversized.widthPx / 2, 2);
    expect(graphics.props.h).toBeCloseTo(oversized.heightPx / 2, 2);
    expect(title).toMatchObject({ x: 600, props: { w: 60, fontSize: 9 } });
    expect(title!.y).toBeCloseTo(stride + 700 - 12 * 0.9, 2);
    expect(shapes.find((shape) => shape.id === "pdf_t_p1_t1")).toMatchObject({ x: 50, props: { w: 40 } });
  });

  it("puts page graphics behind the text as locked background images and keeps a blank last page", () => {
    const document = build(sampleResult(3));
    const snapshot = document.pageLayout!.overlay!.overlaySnapshot!;
    const graphics = snapshot.shapes.filter((shape) => shape.type === "image");
    expect(graphics.map((shape) => shape.id)).toEqual(["pdf_t_p1_graphics", "pdf_t_p3_graphics"]);
    expect(graphics.every((shape) => shape.stackLayer === "background" && shape.locked)).toBe(true);
    expect(snapshot.assets["pdf_t_p1_graphics_asset"]!.props.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/u);
    expect(document.metadata.source).toMatchObject({ format: "pdf", layoutMode: "fixedOverlay", slideCount: 3 });
    expect(document.metadata.styleUnits).toEqual({ fontSize: "pt" });
  });

  it("produces a document that the SigmaDoc schema accepts without repairs", () => {
    const recovered = recoverSigmaDocument(JSON.parse(JSON.stringify(build(sampleResult(5)))));
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.issues).toEqual([]);
      expect(recovered.document.pageLayout?.overlay?.overlaySnapshot?.shapes.length).toBe(build(sampleResult(5)).pageLayout!.overlay!.overlaySnapshot!.shapes.length);
    }
  });
});

describe("readPdfImportResult", () => {
  it("drops malformed runs and graphics but rejects malformed pages", () => {
    const result = readPdfImportResult({
      pages: [{ widthPx: 100, heightPx: 100, graphicsSvg: "<script>", runs: [{ text: "ok", x: 1, y: 2, width: 3, fontSizePx: 4, angle: 0, color: "#ABCDEF", font: "serif" }, { text: "bad", color: "red" }] }],
      issues: ["pattern", 3],
    });
    expect(result.pages[0]!.graphicsSvg).toBeNull();
    expect(result.pages[0]!.runs).toEqual([{ text: "ok", x: 1, y: 2, width: 3, fontSizePx: 4, angle: 0, color: "#abcdef", font: "serif" }]);
    expect(result.issues).toEqual(["pattern"]);
    expect(() => readPdfImportResult({ pages: [{ widthPx: -1, heightPx: 1 }] })).toThrow();
  });

  it("recognizes PDF file names", () => {
    expect(isPdfFilename("教材.PDF ")).toBe(true);
    expect(isPdfFilename("a.pdf.json")).toBe(false);
  });
});
