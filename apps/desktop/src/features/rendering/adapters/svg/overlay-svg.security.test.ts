import { describe, expect, it } from "vitest";

import type { OverlayAsset, OverlayShape, SigmaTableSpec } from "@/features/document";

import { exportOverlaySvg, serializeOverlaySvg, type OverlaySvgRenderers } from ".";

/**
 * Injection is defended in two independent layers, and this file measures the serializer layer.
 * Poisoned values are handed straight to the serializer, so a passing case here is not an
 * observation about `overlay-snapshot.ts` doing its job upstream.
 */
const INJECTED_COLOR =
  "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

const renderers: OverlaySvgRenderers = {
  renderGraphHtml: (_spec, idSeed) => `<svg data-graph="${idSeed}"></svg>`,
  renderMathHtml: (tex) => `<span data-math="${tex}"></span>`,
  renderOverlayTextHtml: (blocks) => `<div data-overlay-text="${blocks.length}"></div>`,
  renderTableHtml: (_table, width, height) => `<div data-table="${width}x${height}"></div>`,
  renderChartSvg: (_data, spec, width, height) => `<g data-chart="${spec.kind}:${width}x${height}"></g>`,
};

function serialize(shape: OverlayShape): string {
  return serializeOverlaySvg([shape], {}, { width: 400, height: 300 }, renderers) ?? "";
}

/** Every `style="…"` value in the markup, split into its individual declarations. */
function styleDeclarations(svg: string): string[] {
  return [...svg.matchAll(/style="([^"]*)"/g)]
    .flatMap((match) => match[1].split(";"))
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0);
}

function textShape(color: string): OverlayShape {
  return {
    id: "shape_text",
    type: "text",
    x: 10,
    y: 20,
    props: {
      w: 120,
      h: 24,
      blocks: [{ type: "paragraph", id: "overlay_svg_security_test_18", children: [{ type: "text", text: "式" }] }],
      color,
      size: "m",
    },
  };
}

function calloutShape(color: string): OverlayShape {
  return {
    id: "shape_callout",
    type: "callout",
    x: 10,
    y: 20,
    props: {
      w: 120,
      h: 60,
      radius: 8,
      tail: { baseStart: { x: 0, y: 60 }, baseEnd: { x: 20, y: 60 }, tip: { x: 10, y: 90 } },
      blocks: [{ type: "paragraph", id: "overlay_svg_security_test_19", children: [{ type: "text", text: "注" }] }],
      color,
      size: "m",
      dash: "solid",
      strokeWidth: "m",
    },
  };
}

describe("overlay SVG serializer CSS injection", () => {
  it("does not let a text shape color add declarations", () => {
    const svg = serialize(textShape(INJECTED_COLOR));

    expect(svg).not.toContain("position:fixed");
    expect(svg).not.toContain("z-index:2147483647");
    expect(styleDeclarations(svg).filter((declaration) => declaration.startsWith("position:"))).toEqual([]);
  });

  it("does not let a callout color add declarations", () => {
    const svg = serialize(calloutShape(INJECTED_COLOR));

    expect(svg).not.toContain("position:fixed");
    expect(svg).not.toContain("z-index:2147483647");
    expect(styleDeclarations(svg).filter((declaration) => declaration.startsWith("position:"))).toEqual([]);
  });

  it("emits exactly the same declaration count for a poisoned and a clean color", () => {
    const poisoned = styleDeclarations(serialize(textShape(INJECTED_COLOR)));
    const clean = styleDeclarations(serialize(textShape("#1f2937")));

    expect(poisoned).toHaveLength(clean.length);
  });

  it("keeps a legitimate color verbatim", () => {
    expect(serialize(textShape("#1f2937"))).toContain("color:#1f2937");
    expect(serialize(calloutShape("rgb(255, 0, 0)"))).toContain("color:rgb(255, 0, 0)");
  });

  it("does not let inline rich-text styling add declarations", () => {
    const shape = textShape("#1f2937");
    (shape.props as { blocks: unknown }).blocks = [
      {
        type: "paragraph",
        id: "p_injected",
        children: [{
          type: "text",
          text: "式",
          color: INJECTED_COLOR,
          backgroundColor: INJECTED_COLOR,
          fontFamily: "serif;}html{display:none",
        }],
      },
    ];

    const svg = serialize(shape);

    expect(svg).not.toContain("position:fixed");
    expect(svg).not.toContain("display:none");
    expect(styleDeclarations(svg).filter((declaration) => declaration.startsWith("position:"))).toEqual([]);
  });
});

describe("overlay SVG image sources", () => {
  function imageDocument(src: string) {
    return {
      shape: {
        id: "shape_image",
        type: "image" as const,
        x: 0,
        y: 0,
        props: { assetId: "asset_1", w: 100, h: 80 },
      },
      assets: {
        asset_1: {
          id: "asset_1",
          type: "image",
          props: { w: 100, h: 80, name: "x.png", isAnimated: false, mimeType: "image/png", src, fileSize: 10 },
        },
      } as unknown as Record<string, OverlayAsset>,
    };
  }

  it("never writes a local or remote URL into the exported SVG", () => {
    // 書き出した SVG は印刷面と PDF にそのまま入る。ここに `file://` が残ると、被害者の
    // ローカルファイルが PDF へ焼き込まれて外へ出る。
    for (const src of [
      "file:///Users/victim/Desktop/private.png",
      "https://attacker.example/beacon.png",
      // `trim()` は U+FEFF を落とすが URL パーサは落とさない。真偽値だけ見て元の値を書くと、
      // 「検証は data URL・ブラウザには相対 URL」で `file://` を基準に解決されてしまう。
      "\uFEFFdata:image/png,../../../../Users/victim/Desktop/private.png",
    ]) {
      const { shape, assets } = imageDocument(src);
      const svg = serializeOverlaySvg([shape], assets, { width: 400, height: 300 }, renderers) ?? "";

      expect(svg, src).not.toContain(src);
      expect(svg, src).not.toContain("<image");
    }
  });

  it("still writes the data URL the app itself produced", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const { shape, assets } = imageDocument(dataUrl);

    expect(serializeOverlaySvg([shape], assets, { width: 400, height: 300 }, renderers) ?? "")
      .toContain(dataUrl);
  });
});

/**
 * The formula engine relays a referenced cell's text verbatim — that is the layer's job, and
 * pre-escaping there would corrupt the value and double-escape downstream. So the escaping has to
 * happen where the markup is built, and this is the test that says so. Unlike the block above,
 * these cases run the *real* table renderer, because a stub would prove nothing about it.
 */
describe("a formula's value cannot inject markup into the exported SVG", () => {
  const HOSTILE = '</p><script>alert(1)</script><p x="';

  function tableWithFormula(referencedText: string, formula: string): OverlayShape {
    const rowIds = ["r1", "r2"];
    return {
      id: "shape_table",
      type: "tableShape",
      x: 0,
      y: 0,
      props: {
        w: 240,
        h: 100,
        table: {
          version: 1,
          kind: "plain",
          columns: [{ id: "c1", width: { mode: "auto" } }],
          rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
          cells: [
            {
              id: "r1-c1",
              rowId: "r1",
              columnId: "c1",
              content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: referencedText }] }],
            },
            {
              id: "r2-c1",
              rowId: "r2",
              columnId: "c1",
              content: [{ type: "paragraph", id: "p2", children: [{ type: "text", text: formula }] }],
            },
          ],
          grid: { borderColor: "#000000", borderWidth: 1 },
          defaultCellStyle: {},
        },
      },
    } as OverlayShape;
  }

  /** Serializes through the same renderer the export, the print path and the viewer all use. */
  function exportSvg(shape: OverlayShape): string {
    return exportOverlaySvg([shape], {}, { width: 400, height: 300 }) ?? "";
  }

  it("escapes hostile text a formula relays from another cell", () => {
    const svg = exportSvg(tableWithFormula(HOSTILE, "=A1"));

    expect(svg).not.toContain("<script>");
  });

  it("keeps the relayed text as text, so the value is still shown", () => {
    const svg = exportSvg(tableWithFormula(HOSTILE, "=A1"));

    expect(svg).toContain("&lt;script&gt;");
  });

  it("escapes hostile text left in a formula that cannot be parsed", () => {
    // A source the parser refuses falls back to drawing the text as written, which is another way
    // the same bytes reach the markup.
    const svg = exportSvg(tableWithFormula("1", `=SUM(${HOSTILE}`));

    expect(svg).not.toContain("<script>");
  });

  it("does not carry a hostile colour off the formula's own run into the style attribute", () => {
    // The projection wears the formatting of the run the formula was typed into, so the author's
    // `color` is the one value on this path that really does reach a `style` attribute.
    const shape = tableWithFormula("1", "=1+1");
    const table = (shape.props as { table: SigmaTableSpec }).table;
    const paragraph = table.cells[1].content[0];
    if (paragraph.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    paragraph.children = [{ type: "text", text: "=1+1", color: INJECTED_COLOR }];

    // `position:relative` is the table's own layout; what must never appear is the declaration the
    // injected colour smuggles in behind a `;`.
    expect(styleDeclarations(exportSvg(shape))).not.toContain("position:fixed");
  });

  it("drops the hostile colour rather than emitting it", () => {
    const shape = tableWithFormula("1", "=1+1");
    const table = (shape.props as { table: SigmaTableSpec }).table;
    const paragraph = table.cells[1].content[0];
    if (paragraph.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    paragraph.children = [{ type: "text", text: "=1+1", color: INJECTED_COLOR }];

    expect(exportSvg(shape)).not.toContain("2147483647");
  });

  it("writes the error colour as a style declaration rather than as text", () => {
    const declarations = styleDeclarations(exportSvg(tableWithFormula("1", "=1/0")));

    expect(declarations).toContain("color:#b42318");
  });

  it("still shows the error value itself", () => {
    expect(exportSvg(tableWithFormula("1", "=1/0"))).toContain("#DIV/0!");
  });

  it("escapes hostile text a formula relays into a chart's labels", () => {
    // `getTableCellText` now returns evaluated values, so a formula in a header cell names a chart
    // series — a second way the same bytes reach markup, drawn as SVG `<text>`.
    const shape = tableWithFormula(HOSTILE, "=A1");
    const table = (shape.props as { table: SigmaTableSpec }).table;
    const chart: OverlayShape = {
      id: "shape_chart",
      type: "chartShape",
      x: 0,
      y: 200,
      props: {
        w: 240,
        h: 160,
        spec: {
          version: 1,
          kind: "bar",
          orientation: "columns",
          headerRow: true,
          labelColumn: false,
          legend: true,
          seriesColors: {},
        },
        sourceTableShapeId: shape.id,
        dataSnapshot: { labels: [], series: [] },
      },
    } as OverlayShape;
    void table;

    const svg = exportOverlaySvg([shape, chart], {}, { width: 400, height: 400 }) ?? "";

    expect(svg).not.toContain("<script>");
  });
});
