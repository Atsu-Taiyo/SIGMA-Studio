import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";

import type { SelectionToolbarShapeBinding, SelectionToolbarTextBinding } from "./binding";
import { ShapeSelectionTools } from "./ShapeSelectionTools";
import { TextSelectionTools } from "./TextSelectionTools";

const noop = vi.fn();

const text: SelectionToolbarTextBinding = {
  enabled: true,
  canBlockStyle: true,
  canBlockStructure: true,
  canAlign: true,
  fontSize: 12,
  fontSizeMixed: false,
  blockStyle: "h2",
  blockStructure: { listType: null, orderedMarkerStyle: null, inQuoteBlock: false, inCodeBlock: false, onDivider: false, codeLanguage: null },
  bold: true,
  italic: false,
  underline: false,
  boxed: false,
  boxedVariant: "frame",
  boxedPaddingY: 0,
  textColor: "#111111",
  textBackgroundColor: null,
  textAlign: "left",
  toggleInline: noop,
  applyBlockStyle: noop,
  applyBlockStructure: noop,
  setFontSize: noop,
  toggleBoxed: noop,
  selectBoxedVariant: noop,
  setBoxedPaddingY: noop,
  setTextColor: noop,
  setTextBackgroundColor: noop,
  applyTextAlign: noop,
  insertBoxBlock: noop,
};

function shapeBinding(shapes: OverlayShape[], patch: Partial<OverlaySelectionSummary> = {}): SelectionToolbarShapeBinding {
  return {
    enabled: true,
    selection: {
      selectedCount: shapes.length,
      selectedShapeIds: shapes.map((shape) => shape.id),
      selectedShapes: shapes,
      selectedAssets: {},
      locked: false,
      hidden: false,
      grouped: false,
      canAlign: shapes.length >= 2,
      canDistribute: shapes.length >= 3,
      canStyleStroke: false,
      canStyleFill: false,
      canStyleLine: false,
      canStyleLineEndpoints: false,
      arrowheadStart: null,
      arrowheadEnd: null,
      fill: { kind: "unavailable" },
      ...patch,
    },
    strokeColor: null,
    fillColor: null,
    fillOpacity: 1,
    applyStyle: noop,
    fillColorPatch: () => ({}),
    request: noop,
    saveAsMaterial: noop,
  };
}

const image = { id: "img", type: "image", x: 0, y: 0, props: { assetId: "a", w: 10, h: 10 } } as OverlayShape;
const rect = {
  id: "rect", type: "geo", x: 0, y: 0,
  props: { geo: "rectangle", w: 10, h: 10, color: "#111111", fill: "none", dash: "solid", size: "m" },
} as unknown as OverlayShape;
const arrow = {
  id: "arrow", type: "arrow", x: 0, y: 0,
  props: { start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, arrowheadEnd: "arrow", color: "#111111", dash: "solid", size: "m" },
} as unknown as OverlayShape;

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("TextSelectionTools", () => {
  it("shows the paragraph style (heading level), font size and inline format for body text", () => {
    const html = render(<TextSelectionTools text={text} />);
    expect(html).toContain("見出し 2");
    expect(html).toContain('aria-label="フォントサイズ"');
    expect(html).toContain(">12<");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("囲み文字の種類と上下余白 0px");
  });

  it("leaves the paragraph style and block menus out for text inside a shape", () => {
    const html = render(<TextSelectionTools text={text} scope="shape" />);
    expect(html).not.toContain('aria-label="段落スタイル"');
    expect(html).not.toContain("その他のブロック");
    expect(html).toContain('aria-label="フォントサイズ"');
  });

  it("shows a mixed font size as a dash and disables the steppers with the toolbar", () => {
    const html = render(<TextSelectionTools text={{ ...text, enabled: false, fontSizeMixed: true }} />);
    expect(html).toContain(">–<");
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("ShapeSelectionTools", () => {
  it("offers crop, replace, natural size and opacity for an image, but no stroke or fill", () => {
    const html = render(<ShapeSelectionTools shape={shapeBinding([image])} text={text} />);
    expect(html).toContain("トリミング");
    expect(html).toContain("差し替え");
    expect(html).toContain("元のサイズに戻す");
    expect(html).toContain('aria-label="透明度"');
    expect(html).not.toContain('aria-label="枠線"');
    expect(html).not.toContain('aria-label="内部塗りつぶし"');
  });

  it("has no opacity button for a shape whose colour palettes carry the opacity", () => {
    const html = render(<ShapeSelectionTools
      shape={shapeBinding([rect], { canStyleStroke: true, canStyleFill: true, canStyleLine: true })}
      text={text}
    />);
    expect(html).toContain('aria-label="内部塗りつぶし"');
    expect(html).not.toContain('aria-label="透明度"');
  });

  it("still offers the opacity button for a shape that already stores one", () => {
    const faded = { ...rect, opacity: 0.5 } as OverlayShape;
    const html = render(<ShapeSelectionTools
      shape={shapeBinding([faded], { canStyleStroke: true, canStyleFill: true, canStyleLine: true })}
      text={text}
    />);
    expect(html).toContain('aria-label="透明度"');
  });

  it("offers the crop reset only after the image was cropped", () => {
    const cropped = { ...image, props: { ...(image as { props: object }).props, crop: { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } } } } as OverlayShape;
    expect(render(<ShapeSelectionTools shape={shapeBinding([image])} text={text} />)).not.toContain("トリミングをリセット");
    expect(render(<ShapeSelectionTools shape={shapeBinding([cropped])} text={text} />)).toContain("トリミングをリセット");
  });

  it("offers type, fill, stroke, width and dash for a rectangle but no line ends", () => {
    const html = render(<ShapeSelectionTools
      shape={shapeBinding([rect], { canStyleStroke: true, canStyleFill: true, canStyleLine: true })}
      text={text}
    />);
    expect(html).toContain('aria-label="図形の種類を変更"');
    expect(html).toContain('aria-label="内部塗りつぶし"');
    expect(html).toContain('aria-label="枠線"');
    expect(html).toContain("線幅");
    expect(html).toContain("線種");
    expect(html).not.toContain("線の左端");
  });

  it("offers both line ends for an open arrow", () => {
    const html = render(<ShapeSelectionTools
      shape={shapeBinding([arrow], { canStyleStroke: true, canStyleLine: true, canStyleLineEndpoints: true })}
      text={text}
    />);
    expect(html).toContain("線の左端");
    expect(html).toContain("線の右端");
    expect(html).not.toContain('aria-label="内部塗りつぶし"');
  });

  it("offers grouping for several shapes", () => {
    const html = render(<ShapeSelectionTools shape={shapeBinding([rect, arrow])} text={text} />);
    expect(html).toContain('aria-label="グループ化"');
  });

  it("shows only the unlock button for a locked selection", () => {
    const html = render(<ShapeSelectionTools shape={shapeBinding([rect], { locked: true, canStyleFill: true })} text={text} />);
    expect(html).toContain("ロック解除");
    expect(html).not.toContain('aria-label="内部塗りつぶし"');
  });

  it("shows the text tools while text inside a shape is being edited", () => {
    const html = render(<ShapeSelectionTools shape={shapeBinding([rect], { textEditing: { shapeId: "rect", kind: "text" } })} text={text} />);
    expect(html).toContain('aria-label="フォントサイズ"');
    expect(html).not.toContain('aria-label="図形の種類を変更"');
  });
});
