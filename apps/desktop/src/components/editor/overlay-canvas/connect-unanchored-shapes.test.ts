import { describe, expect, it } from "vitest";
import { resolveShapesPosition, type MeasuredBlock } from "./anchor";
import { connectUnanchoredShapesToBody, type BodyPageBand } from "./connect-unanchored-shapes";
import type { OverlayAnchor, OverlayShape } from "./types";

// A4 の紙面 (1123px) + ページ間 36px、上余白 76px・本文域 971px。
const band: BodyPageBand = { pageStridePx: 1159, contentTopPx: 76, contentHeightPx: 971 };
const PAGE2 = 1159;

function rect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  anchor?: OverlayAnchor,
  extra: Partial<OverlayShape> = {},
): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    ...(anchor ? { anchor } : {}),
    ...extra,
    props: { w, h, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" },
  } as OverlayShape;
}

function paragraph(id: string, top: number, lineCount: number, left = 40, width = 600, lineHeight = 20): MeasuredBlock {
  return {
    id,
    top,
    left,
    width,
    height: lineCount * lineHeight,
    lines: Array.from({ length: lineCount }, (_, index) => ({ index, top: top + index * lineHeight, height: lineHeight, left, width })),
  };
}

const page = { type: "page" } as const;
// p1: 100–140 (2 行)、p2: 160–200 (2 行)。行どうしの間に隙間は無く、段落の間に 20px の隙間。
const blocks = [paragraph("p1", 100, 2), paragraph("p2", 160, 2)];

function positionsOf(shapes: OverlayShape[], measured: readonly MeasuredBlock[] = blocks) {
  const resolved = resolveShapesPosition(shapes, new Map(measured.map((block) => [block.id, block])));
  return Object.fromEntries(resolved.map((shape) => [shape.id, { x: shape.x, y: shape.y }]));
}

describe("connectUnanchoredShapesToBody", () => {
  it("connects a page-fixed or anchorless figure to the body line at its top, without moving it", () => {
    const shapes = [
      rect("fixed", 400, 125, 80, 30, page),
      rect("loose", 400, 170, 80, 20),
    ];

    const next = connectUnanchoredShapesToBody(shapes, blocks, band);

    expect(next[0].anchor).toEqual({ type: "block", blockId: "p1", dy: 25, dx: 360, line: { index: 1, dy: 5 } });
    expect(next[1].anchor).toMatchObject({ type: "block", blockId: "p2", line: { index: 0 } });
    expect(positionsOf(next)).toEqual(positionsOf(shapes));
  });

  it("leaves figures that are already connected exactly as they are", () => {
    const anchored = rect("anchored", 400, 300, 80, 30, { type: "block", blockId: "p1", dy: 200 });
    const missing = rect("missing", 400, 500, 80, 30, { type: "block", blockId: "gone", dy: 0 });
    const label = rect("label", 420, 310, 10, 10, { type: "shape", shapeId: "anchored", dx: 20, dy: 10 });
    const shapes = [anchored, missing, label];

    expect(connectUnanchoredShapesToBody(shapes, blocks, band)).toBe(shapes);
  });

  it("hangs a figure whose top sits just above a paragraph beside that paragraph", () => {
    // 上端 155 は p1 の下端 (140) と p2 の上端 (160) の間。下の p2 の方が近く、図は p2 の高さまで降りている。
    const next = connectUnanchoredShapesToBody([rect("beside", 400, 155, 80, 60, page)], blocks, band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "p2", dy: -5, line: { index: 0, dy: -5 } });
  });

  it("hangs a figure placed just below a paragraph from that paragraph", () => {
    // 上端 145 は p1 の下端に近い: p1 の後ろに置いた図。
    const next = connectUnanchoredShapesToBody([rect("below", 400, 145, 80, 60, page)], blocks, band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "p1", dy: 45, line: { index: 1, dy: 25 } });
  });

  it("does not snap down to a paragraph the figure never reaches", () => {
    // 上端は p2 に近いが、図の下端 (158) が p2 の上端 (160) まで降りていない。
    const next = connectUnanchoredShapesToBody([rect("short", 400, 154, 80, 4, page)], blocks, band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "p1", line: { index: 1 } });
  });

  it("uses the first body text of the figure's own page when the figure sits above it", () => {
    const measured = [...blocks, paragraph("q1", PAGE2 + 300, 2)];
    const next = connectUnanchoredShapesToBody([rect("top", 400, PAGE2 + 200, 80, 60, page)], measured, band);

    // 前のページの最後の段落 (p2) ではなく、同じページの最初の段落へ。
    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "q1", dy: -100, line: { index: 0, dy: -100 } });
  });

  it("follows a paragraph that continues from the previous page onto the line beside the figure", () => {
    const longParagraph: MeasuredBlock = {
      id: "long",
      top: 900,
      left: 40,
      width: 600,
      height: PAGE2 + 116 - 900,
      lines: [
        { index: 0, top: 900, height: 20 },
        { index: 1, top: 920, height: 20 },
        { index: 2, top: PAGE2 + 76, height: 20 },
        { index: 3, top: PAGE2 + 96, height: 20 },
      ],
    };
    const next = connectUnanchoredShapesToBody([rect("cont", 400, PAGE2 + 100, 80, 40, page)], [longParagraph], band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "long", line: { index: 3, dy: 4 } });
  });

  it("keeps page furniture and figures on pages without body text fixed to the page", () => {
    const shapes = [
      rect("header", 100, 10, 200, 30, page),
      rect("footer", 100, 76 + 971 + 5, 200, 30, page),
      rect("frame", 30, 80, 700, 900, page),
      rect("locked", 400, 125, 80, 30, page, { locked: true }),
      rect("empty-page", 400, PAGE2 * 2 + 300, 80, 30, page),
    ];

    expect(connectUnanchoredShapesToBody(shapes, blocks, band)).toBe(shapes);
  });

  it("keeps the parts of one figure together on the line its top is beside", () => {
    // 図 (p1 の 2 行目から p2 まで) と、p2 の高さで図に重なるラベル。ラベルだけなら p2 を選ぶ。
    const shapes = [
      rect("graph", 400, 125, 120, 90, page),
      rect("label", 510, 190, 40, 20, page),
    ];

    const next = connectUnanchoredShapesToBody(shapes, blocks, band);

    expect(next.map((shape) => shape.anchor)).toEqual([
      { type: "block", blockId: "p1", dy: 25, dx: 360, line: { index: 1, dy: 5 } },
      { type: "block", blockId: "p1", dy: 90, dx: 470, line: { index: 1, dy: 70 } },
    ]);
    expect(positionsOf(next)).toEqual(positionsOf(shapes));
  });

  it("joins a figure that overlaps an already connected one to that figure's anchor", () => {
    // 本文へ繋がった図 (p2 の 1 行目) に重なる注記。注記の上端は p1 の高さにある。
    const figure = rect("figure", 400, 0, 120, 60, { type: "block", blockId: "p2", dy: 0, dx: 360, line: { index: 0, dy: 0 } });
    const note = rect("note", 380, 130, 40, 40, page);

    const next = connectUnanchoredShapesToBody([figure, note], blocks, band);

    expect(next[0]).toBe(figure);
    expect(next[1].anchor).toEqual({ type: "block", blockId: "p2", dy: -30, dx: 340, line: { index: 0, dy: -30 } });
  });

  it("connects a page-fixed group as one unit and lets its members follow the group", () => {
    const shapes: OverlayShape[] = [
      { id: "group", type: "group", x: 400, y: 125, anchor: page, props: { w: 150, h: 80 } } as OverlayShape,
      rect("member-a", 400, 125, 50, 20, page, { parentId: "group" }),
      rect("member-b", 500, 185, 50, 20, undefined, { parentId: "group" }),
    ];

    const next = connectUnanchoredShapesToBody(shapes, blocks, band);

    for (const shape of next) {
      expect(shape.anchor).toMatchObject({ type: "block", blockId: "p1", line: { index: 1 } });
    }
    expect(positionsOf(next)).toEqual(positionsOf(shapes));
  });

  it("connects the page-fixed members of a group that is already connected to the group's line", () => {
    const groupAnchor = { type: "block", blockId: "p1", dy: 25, dx: 360, line: { index: 1, dy: 5 } } as const;
    const shapes: OverlayShape[] = [
      { id: "group", type: "group", x: 400, y: 125, anchor: groupAnchor, props: { w: 150, h: 80 } } as OverlayShape,
      rect("member-a", 400, 125, 50, 20, groupAnchor, { parentId: "group" }),
      rect("member-b", 500, 185, 50, 20, page, { parentId: "group" }),
    ];

    const next = connectUnanchoredShapesToBody(shapes, blocks, band);

    expect(next[0]).toBe(shapes[0]);
    expect(next[1]).toBe(shapes[1]);
    expect(next[2].anchor).toEqual({ type: "block", blockId: "p1", dy: 85, dx: 460, line: { index: 1, dy: 65 } });
  });

  it("picks the body text of the column the figure sits in", () => {
    const columns = [paragraph("left", 100, 3, 40, 300), paragraph("right", 100, 3, 400, 300)];
    const next = connectUnanchoredShapesToBody([rect("fig", 450, 130, 80, 30, page)], columns, band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "right", dx: 50, line: { index: 1 } });
  });

  it("connects a figure at the top of a column, beside lines continued from the previous column, to that column", () => {
    // 2 段目の先頭 (100–160) は 1 段目から続く段落の行で、続きの段落のブロックとしては測られない。
    const columns = [paragraph("left", 100, 30, 40, 300), paragraph("right", 160, 3, 400, 300)];
    const next = connectUnanchoredShapesToBody([rect("fig", 600, 122, 60, 20, page)], columns, band);

    expect(next[0].anchor).toMatchObject({ type: "block", blockId: "right", dy: -38, dx: 200, line: { index: 0 } });
  });

  describe("columns inside the page (a layout section between full-width text)", () => {
    // 全幅の段落 intro (100–160) の下に 3 段の段組 (各段 200px・段間 20px、180– )、その下に全幅の outro (380– )。
    // 段の本文は段ごとに高さがずれている。全幅の段落は左端が 1 段目と同じ。
    // 段組そのもの (sec) も段をまたぐ入れ物のブロックとして測られる。
    const inSection = (block: MeasuredBlock): MeasuredBlock => ({ ...block, containerId: "sec" });
    const section = [
      paragraph("intro", 100, 3, 40, 640),
      { id: "sec", top: 178, left: 38, width: 644, height: 192 },
      inSection(paragraph("c0a", 180, 2, 40, 200)), inSection(paragraph("c0b", 230, 4, 40, 200)),
      inSection(paragraph("c1a", 180, 3, 260, 200)), inSection(paragraph("c1b", 250, 3, 260, 200)),
      inSection(paragraph("c2a", 180, 5, 480, 200)),
      paragraph("outro", 380, 3, 40, 640),
    ];
    const anchorOf = (x: number, y: number, w = 40) => (
      connectUnanchoredShapesToBody([rect("fig", x, y, w, 20, page)], section, band)[0].anchor
    );

    it("keeps a figure beside full-width text on that text, even over the last column", () => {
      expect(anchorOf(630, 123)).toMatchObject({ blockId: "intro", line: { index: 1 } });
      expect(anchorOf(630, 403)).toMatchObject({ blockId: "outro", line: { index: 1 } });
    });

    it("connects a figure in a middle column to that column, not to a later paragraph of the first column", () => {
      // 1 段目の c0b (230–) の方が上端に近いが、図は 2 段目の c1b (250–) の 2 行目の横。
      expect(anchorOf(410, 273)).toMatchObject({ blockId: "c1b", line: { index: 1 } });
      expect(anchorOf(410, 243)).toMatchObject({ blockId: "c1a", line: { index: 2 } });
    });

    it("connects a figure at the left edge of a column to that column", () => {
      // 図の中心 (262) は 2 段目の左端のすぐ内側。全幅の段落があっても 1 段目へは寄せない。
      expect(anchorOf(242, 203)).toMatchObject({ blockId: "c1a", line: { index: 1 } });
    });

    it("connects a figure in the gap between columns to the nearer column", () => {
      expect(anchorOf(244, 263, 10)).toMatchObject({ blockId: "c0b", line: { index: 1 } });
    });
  });

  it("never anchors to editor-only or folded blocks", () => {
    const measured: MeasuredBlock[] = [
      { ...paragraph("placeholder", 100, 2), derived: true },
      { ...paragraph("folded", 160, 2), undrawn: true },
    ];
    const shapes = [rect("fig", 400, 125, 80, 30, page)];

    expect(connectUnanchoredShapesToBody(shapes, measured, band)).toBe(shapes);
  });

  it("does not rewrite figures a feature protects", () => {
    const shapes = [rect("held", 400, 125, 80, 30, page), rect("free", 400, 300, 80, 30, page)];

    const next = connectUnanchoredShapesToBody(shapes, blocks, band, { untouchableShapeIds: new Set(["held"]) });

    expect(next[0]).toBe(shapes[0]);
    expect(next[1].anchor).toMatchObject({ type: "block", blockId: "p2" });
  });
});
