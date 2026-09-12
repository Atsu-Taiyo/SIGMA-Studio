import path from "node:path";
import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SigmaTableSpec } from "@/features/document";
import { OverlayTableStaticView } from "@/features/rendering/adapters/react";
import  {
  OVERLAY_TABLE_CELL_CONTENT_LAYER_STATIC_STYLE,
  OVERLAY_TABLE_CELL_STATIC_STYLE,
  OVERLAY_TABLE_TEXT_STATIC_STYLE,
} from "@/features/rendering/core";

/**
 * `OverlayTableStaticView` inlines the structural declarations `globals.css` gives a table cell,
 * because the exported SVG is also viewed without the stylesheet. That output is re-injected into
 * the app with `dangerouslySetInnerHTML`, where inline styles beat the stylesheet — so a value that
 * drifts from the CSS does not just look wrong standalone, it makes the SVG-rendered table differ
 * from the natively rendered one.
 *
 * A comment saying "keep these in sync" is the failure mode this session is removing, so the CSS
 * is parsed and compared here (same approach as `lib/problem-frame.test.ts` and
 * `rich-text-self-contained.test.ts`).
 *
 * The editor deliberately does NOT inline these: an inline declaration would beat the state rules
 * (`.overlay-table-shape.editing …`) that the editing surface relies on.
 */

const globalsCss = readFileSync(
  path.resolve(import.meta.dirname, "../../../app/globals.css"),
  "utf8",
);

function ruleDeclarations(css: string, selector: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let index = 0;
  while (index < withoutComments.length) {
    const open = withoutComments.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const close = findBlockEnd(withoutComments, open);
    const prelude = withoutComments.slice(index, open).trim();
    const selectors = prelude.split(",").map((entry) => entry.trim().replace(/\s+/g, " "));
    if (!prelude.startsWith("@") && selectors.includes(selector)) {
      return parseDeclarations(withoutComments.slice(open + 1, close));
    }
    index = close + 1;
  }
  throw new Error(`no rule for "${selector}"`);
}

function findBlockEnd(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return css.length;
}

function parseDeclarations(body: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      declarations[declaration.slice(0, separator).trim()] = declaration
        .slice(separator + 1)
        .trim()
        .replace(/\s+/g, " ");
    }
  }
  return declarations;
}

function toCamelCase(declarations: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(declarations).map(([property, value]) => [
      property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value === "0" ? "0" : value,
    ]),
  );
}

/**
 * Declarations that exist in CSS but are deliberately not inlined, each with a reason. The
 * staleness test below keeps the list honest.
 */
const NOT_INLINED: Record<string, string> = {
  "contentLayer.pointerEvents":
    "編集中だけ `auto` に切り替わる状態依存の値。静的出力にはそもそも入力が無く、インライン化すると"
    + "アプリへ再注入したときに `.overlay-table-shape.editing` の上書きを潰す",
};

/** `.overlay-table-shape` declarations that describe its own box rather than its text. */
const TABLE_SHAPE_BOX_DECLARATIONS = ["position", "width", "height", "overflow"];

describe("the static table cell style mirrors globals.css", () => {
  // Without these the static tree fell back to `line-height: normal` where the interactive shape
  // used 1.35, so a cell's text shifted the moment the table became interactive (and the PDF and
  // the embedded viewer sat on the wrong side of that gap permanently).
  it("carries the inherited text declarations of .overlay-table-shape", () => {
    const declarations = ruleDeclarations(globalsCss, ".overlay-table-shape");
    const box = Object.fromEntries(
      Object.entries(declarations).filter(([property]) => TABLE_SHAPE_BOX_DECLARATIONS.includes(property)),
    );
    const inherited = Object.fromEntries(
      Object.entries(declarations).filter(([property]) => !TABLE_SHAPE_BOX_DECLARATIONS.includes(property)),
    );

    // The split is asserted in both directions, so a new inherited declaration in the CSS cannot
    // slip past by being mistaken for one of the shape's own box properties.
    expect(Object.keys(box).sort()).toEqual([...TABLE_SHAPE_BOX_DECLARATIONS].sort());
    expect(OVERLAY_TABLE_TEXT_STATIC_STYLE).toEqual(toCamelCase(inherited));
  });

  it("matches .overlay-table-shape td", () => {
    expect(OVERLAY_TABLE_CELL_STATIC_STYLE)
      .toEqual(toCamelCase(ruleDeclarations(globalsCss, ".overlay-table-shape td")));
  });

  it("matches .overlay-table-cell-content-layer minus the state-dependent declarations", () => {
    const declarations = toCamelCase(ruleDeclarations(globalsCss, ".overlay-table-cell-content-layer"));
    delete declarations.pointerEvents;

    expect(OVERLAY_TABLE_CELL_CONTENT_LAYER_STATIC_STYLE).toEqual(declarations);
  });

  it("keeps the not-inlined list free of stale entries", () => {
    const contentLayer = ruleDeclarations(globalsCss, ".overlay-table-cell-content-layer");

    expect(Object.keys(NOT_INLINED)).toEqual(["contentLayer.pointerEvents"]);
    expect(contentLayer["pointer-events"]).toBe("none");
    // The state rule this protects has to still exist.
    expect(ruleDeclarations(globalsCss, ".overlay-table-shape.editing .overlay-table-cell-content-layer"))
      .toEqual({ "pointer-events": "auto" });
  });

  // The remaining declarations are written as JSX literals in `OverlayTableStaticView`, so they
  // are compared against the rendered markup rather than against a constant.
  it("writes the table element rule inline", () => {
    const declarations = ruleDeclarations(globalsCss, ".overlay-table-shape-table");
    const rendered = renderedStyleOf("table");

    for (const [property, value] of Object.entries(declarations)) {
      expect(rendered[property], property).toBe(value);
    }
  });

  it("writes the overlay layer rule inline", () => {
    const declarations = ruleDeclarations(globalsCss, ".overlay-table-rendered-lines");
    const rendered = renderedStyleOf("div[style*=\"z-index\"]");

    for (const [property, value] of Object.entries(declarations)) {
      expect(rendered[property], property).toBe(value);
    }
  });

  it("keeps the connector rule's box model inline", () => {
    // `.overlay-table-line-connector` only adds `box-sizing`, which is inert for a zero-sized
    // element; it is asserted here so a future declaration cannot slip past the export.
    expect(ruleDeclarations(globalsCss, ".overlay-table-line-connector")).toEqual({
      position: "absolute",
      "z-index": "3",
      "box-sizing": "border-box",
      "pointer-events": "none",
    });
  });
});

describe("overlay table static markup CSS injection", () => {
  // `renderToStaticMarkup` does NOT escape `;` inside a style object value, so an injected color
  // reaching `toReactStyle` becomes real extra declarations in the exported markup. The live DOM
  // path hides this (CSSOM discards the malformed value), which is why it is measured here on the
  // serialized string, with no document normalization in front of the component.
  const INJECTED = "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

  function markupWithCellStyle(style: Record<string, string>): string {
    const table = {
      kind: "plain",
      columns: [{ id: "c1", width: { mode: "fixed", value: 80 } }],
      rows: [{ id: "r1", height: { mode: "fixed", value: 40 } }],
      cells: [{
        id: "cell1",
        rowId: "r1",
        columnId: "c1",
        content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "1" }] }],
        style,
      }],
      grid: { borderColor: "#111827", borderWidth: 1 },
      defaultCellStyle: {},
    } as unknown as SigmaTableSpec;
    return renderToStaticMarkup(
      <OverlayTableStaticView height={40} selfContained table={table} width={80} />,
    );
  }

  it("does not emit a position declaration from an injected cell color", () => {
    const html = markupWithCellStyle({ color: INJECTED });

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("z-index:2147483647");
  });

  it("does not emit a position declaration from an injected cell backgroundColor", () => {
    expect(markupWithCellStyle({ backgroundColor: INJECTED })).not.toContain("position:fixed");
  });

  it("does not emit a rule block from an injected cell fontFamily", () => {
    const html = markupWithCellStyle({ fontFamily: "serif;}html{display:none" });

    expect(html).not.toContain("display:none");
  });

  it("does not emit a position declaration from an injected grid border color", () => {
    const table = {
      kind: "plain",
      columns: [{ id: "c1", width: { mode: "fixed", value: 80 } }],
      rows: [{ id: "r1", height: { mode: "fixed", value: 40 } }],
      cells: [],
      // `getTableRenderedLineStyleModel` builds `border-top: <w>px <style> <color>`, so the color
      // arrives embedded in a composite value that a color-shaped check cannot see.
      grid: { borderColor: INJECTED, borderWidth: 1, showOuterBorder: true, showInnerBorders: true },
      defaultCellStyle: {},
    } as unknown as SigmaTableSpec;

    const html = renderToStaticMarkup(
      <OverlayTableStaticView height={40} selfContained table={table} width={80} />,
    );

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("z-index:2147483647");
  });

  it("does not emit a position declaration from an injected paragraph align", () => {
    // A cell paragraph is an HTML element inside the `<foreignObject>`, so unlike the `<td>` styles
    // an injected `position:fixed` here really would cover the page.
    const table = {
      kind: "plain",
      columns: [{ id: "c1", width: { mode: "fixed", value: 80 } }],
      rows: [{ id: "r1", height: { mode: "fixed", value: 40 } }],
      cells: [{
        id: "cell1",
        rowId: "r1",
        columnId: "c1",
        content: [{
          type: "paragraph",
          id: "p1",
          children: [{ type: "text", text: "1" }],
          align: `left;${INJECTED}`,
        }],
      }],
      grid: { borderColor: "#111827", borderWidth: 1 },
      defaultCellStyle: {},
    } as unknown as SigmaTableSpec;

    const html = renderToStaticMarkup(
      <OverlayTableStaticView height={40} selfContained table={table} width={80} />,
    );

    expect(html).not.toContain("position:fixed");
    // The literal margin is untouched; only the document-supplied align was dropped.
    expect(html).toContain("<p style=\"margin:0\">");
  });

  it("keeps a legitimate paragraph align", () => {
    const table = {
      kind: "plain",
      columns: [{ id: "c1", width: { mode: "fixed", value: 80 } }],
      rows: [{ id: "r1", height: { mode: "fixed", value: 40 } }],
      cells: [{
        id: "cell1",
        rowId: "r1",
        columnId: "c1",
        content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "1" }], align: "center" }],
      }],
      grid: { borderColor: "#111827", borderWidth: 1 },
      defaultCellStyle: {},
    } as unknown as SigmaTableSpec;

    expect(renderToStaticMarkup(
      <OverlayTableStaticView height={40} selfContained table={table} width={80} />,
    )).toContain("text-align:center");
  });

  it("keeps a legitimate cell color and font family", () => {
    const html = markupWithCellStyle({ color: "#1f2937", fontFamily: "KaTeX_Main, serif" });

    expect(html).toContain("color:#1f2937");
    expect(html).toContain("KaTeX_Main, serif");
  });
});

const DOUBLE_BORDER_TABLE = {
  kind: "plain",
  columns: [{ id: "c1", width: { mode: "fixed", value: 80 } }],
  rows: [{ id: "r1", height: { mode: "fixed", value: 40 } }],
  cells: [],
  grid: {
    borderColor: "#111827",
    borderWidth: 3,
    borderStyle: "double",
    showOuterBorder: true,
    showInnerBorders: true,
  },
  defaultCellStyle: {},
} as unknown as SigmaTableSpec;

function renderedStyleOf(selector: string): Record<string, string> {
  const html = renderToStaticMarkup(
    <OverlayTableStaticView height={40} selfContained table={DOUBLE_BORDER_TABLE} width={80} />,
  );
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const element = container.querySelector(selector);
  const style = parseDeclarations(element?.getAttribute("style") ?? "");
  window.close();
  return style;
}
