import { describe, expect, it } from "vitest";

import {
  parseSigmaDocument,
  type Graph3DSpec,
  type OverlayShape,
  type SigmaDocument,
} from "./index";
import { getViewerSafetyIssues, validateImageDataUrl } from "./viewer-safety";

const VALID_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("viewer safety boundary", () => {
  it("validates every 3D material color and limits authored expression size", () => {
    const document = createDocument();
    const shape = graph3DShape();
    shape.props.spec.objects[0].style = {
      color: "url(https://example.com/mesh)",
      wireframeColor: "#111827",
      fill: { mode: "solid", color: "red;background:url(https://example.com/fill)" },
    };
    shape.props.spec.view.backgroundColor = "#ffffff";
    if (shape.props.spec.cuts[0]?.section) {
      shape.props.spec.cuts[0].section.lineWidth = 99;
      shape.props.spec.cuts[0].section.overlapMode = "xor" as "add";
    }
    if (shape.props.spec.objects[0].kind === "parametricSurface") {
      shape.props.spec.objects[0].z = "x".repeat(4_097);
      shape.props.spec.objects[0].translation = { x: "x".repeat(4_097), y: "0", z: "0" };
    }
    document.pageLayout = pageLayoutWithShapes([shape]);

    expect(getViewerSafetyIssues(document)).toEqual(expect.arrayContaining([
      expect.stringContaining("objects.0.style.color"),
      expect.stringContaining("objects.0.style.fill.color"),
      expect.stringContaining("objects.0.z"),
      expect.stringContaining("objects.0.translation.x"),
      expect.stringContaining("cuts.0.section.lineWidth"),
      expect.stringContaining("cuts.0.section.overlapMode"),
    ]));
  });

  it("accepts only TeX-compatible box title positions", () => {
    const document = createDocument();
    document.content = [{
      type: "boxBlock",
      id: "box-title-position",
      styleId: "itembox",
      frame: { titlePosition: "center" as "l" },
      blocks: [{ type: "paragraph", id: "box-body", children: [] }],
    }];

    expect(getViewerSafetyIssues(document)).toContain(
      "content.0.frame.titlePosition: タイトル位置はl・c・rのいずれかで指定してください。",
    );
  });

  it("rejects CSS injection in overlay shape colors after canonical parsing", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "unsafe-color",
      type: "geo",
      x: 10,
      y: 10,
      props: {
        w: 120,
        h: 80,
        geo: "rectangle",
        fill: "solid",
        color: "url(https://example.com/stroke)",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    }]);

    // The canonical schema boundary now neutralizes the value on the way in (it substitutes the
    // app's default color instead of dropping the shape), so parsing succeeds and the injected
    // string never reaches a style attribute.
    const parsed = parseSigmaDocument(document);

    expect(parsed.pageLayout?.overlay?.overlaySnapshot?.shapes[0].props).toMatchObject({ color: "black" });
    // The viewer keeps its own net for documents a host hands over without parsing.
    expect(getViewerSafetyIssues(document)).toContain(
      "pageLayout.overlay.overlaySnapshot.shapes.0.props.color: CSS注入につながる文字列は指定できません。",
    );
  });

  /**
   * TeX にブラックリストは置かない。数式 markup の無害化は描画の出口
   * (`features/rendering/adapters/math-html.ts` の `renderMathHtml`) が引き受けるので、
   * この境界は `tex` の中身を検査しない — その事実をここで明示しておく。
   * 実際に `<img>` が描かれないことは `SigmaDocViewer.test.tsx` が DOM で確かめる。
   */
  it("does not blacklist TeX: math markup is sanitized at the render outlet", () => {
    const document = createDocument();
    document.content = [{
      type: "paragraph",
      id: "body",
      children: [{
        type: "mathInline",
        id: "math_xss",
        tex: "\\text{<img src=x onerror=alert(1)>}",
        display: "inline",
      }],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([]);
    expect(() => parseSigmaDocument(document)).not.toThrow();
  });

  it("deeply rejects injected rich-text style attributes and control characters", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "unsafe-rich-text",
      type: "text",
      x: 10,
      y: 10,
      props: {
        w: 240,
        h: 16,
        color: "#111111",
        size: "m",
        blocks: [{
          type: "paragraph",
          id: "p_unsafe",
          children: [{
            type: "text",
            text: "unsafe",
            backgroundColor: "red;background:url(https://example.com/a)",
            fontFamily: "serif\u0000sans-serif",
          }],
        }],
      },
    }]);

    const parsed = parseSigmaDocument(document);
    const child = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes[0].props as unknown as {
      blocks: { children: Record<string, unknown>[] }[];
    };

    expect("backgroundColor" in child.blocks[0].children[0]).toBe(false);
    expect("fontFamily" in child.blocks[0].children[0]).toBe(false);
    expect(getViewerSafetyIssues(document).length).toBeGreaterThan(0);
  });

  /**
   * The blocks a shape gained. A quote holds blocks rather than runs and a code block holds one of
   * its own, so a walker that only knew about paragraphs and lists would either miss the styling
   * inside them or throw on the way past — and this validator is the last thing between a document
   * and the renderer.
   */
  it("walks the styling inside a shape's quote and code block", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "unsafe-body-blocks",
      type: "text",
      x: 10,
      y: 10,
      props: {
        w: 240,
        h: 96,
        color: "#111111",
        size: "m",
        blocks: [
          {
            type: "quote",
            id: "quote_1",
            blocks: [{
              type: "paragraph",
              id: "quote_p",
              children: [{ type: "text", text: "引用", color: "red;background:url(https://example.com/a)" }],
            }],
          },
          {
            type: "codeBlock",
            id: "code_1",
            children: [{ type: "text", text: "code", backgroundColor: "blue;position:fixed" }],
          },
          { type: "divider", id: "divider_1" },
        ],
      },
    }] as unknown as Parameters<typeof pageLayoutWithShapes>[0]);

    const issues = getViewerSafetyIssues(document);

    expect(issues.some((issue) => issue.includes("blocks.0.blocks.0.children.0"))).toBe(true);
    expect(issues.some((issue) => issue.includes("blocks.1.children.0"))).toBe(true);
  });

  it("accepts a shape holding a well-formed quote, code block and rule", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "safe-body-blocks",
      type: "text",
      x: 10,
      y: 10,
      props: {
        w: 240,
        h: 96,
        color: "#111111",
        size: "m",
        blocks: [
          {
            type: "quote",
            id: "quote_1",
            blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
          },
          { type: "codeBlock", id: "code_1", children: [{ type: "text", text: "code" }] },
          { type: "divider", id: "divider_1" },
        ],
      },
    }] as unknown as Parameters<typeof pageLayoutWithShapes>[0]);

    expect(getViewerSafetyIssues(document)).toEqual([]);
    expect(parseSigmaDocument(document).pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
  });

  it("checks callout colors and rich text, which were previously unvisited", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "unsafe-callout",
      type: "callout",
      x: 10,
      y: 10,
      props: {
        w: 160,
        h: 90,
        radius: 8,
        tail: { baseStart: { x: 0, y: 90 }, baseEnd: { x: 20, y: 90 }, tip: { x: 10, y: 120 } },
        blocks: [{
          type: "paragraph",
          id: "p_unsafe_callout",
          children: [{
            type: "text",
            text: "unsafe",
            color: "red;position:fixed;top:0;left:0;width:100vw;height:100vh",
          }],
        }],
        color: "url(https://example.com/stroke)",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    }]);

    const issues = getViewerSafetyIssues(document);

    expect(issues).toContain(
      "pageLayout.overlay.overlaySnapshot.shapes.0.props.color: CSS注入につながる文字列は指定できません。",
    );
    expect(issues).toContain(
      "pageLayout.overlay.overlaySnapshot.shapes.0.props.blocks.0.children.0.color: CSS注入につながる文字列は指定できません。",
    );
  });

  it("reports a self-referential list instead of recursing into it", () => {
    const document = createDocument();
    const list = {
      type: "list",
      id: "list_cycle",
      listType: "bullet",
      items: [{ type: "listItem", id: "li_cycle", children: [], nested: [] as unknown[] }],
    };
    list.items[0].nested.push(list);
    document.content = [list as never];

    expect(getViewerSafetyIssues(document)).toContain(
      "content.0.items.0.nested.0: ブロックに循環参照があります。",
    );
  });

  it("checks a table trend label even when a decoy children array is present", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "trend-label",
      type: "tableShape",
      x: 0,
      y: 0,
      props: {
        w: 200,
        h: 100,
        table: {
          version: 1,
          kind: "variation",
          rows: [{ id: "r1", height: { mode: "auto" } }],
          columns: [{ id: "c1", width: { mode: "auto" } }],
          cells: [{
            id: "cell1",
            rowId: "r1",
            columnId: "c1",
            content: [{
              type: "trend",
              id: "t1",
              direction: "up",
              children: [],
              label: [{ type: "text", text: "x", color: "red;position:fixed;top:0;left:0" }],
            }],
          }],
          grid: { borderColor: "#111827", borderWidth: 1 },
          defaultCellStyle: {},
        },
      },
    }] as never);

    expect(getViewerSafetyIssues(document)).toContain(
      "pageLayout.overlay.overlaySnapshot.shapes.0.props.table.cells.0.content.0.label.0.color: CSS注入につながる文字列は指定できません。",
    );
  });

  it("checks every chart series color", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "chart",
      type: "chartShape",
      x: 0,
      y: 0,
      props: {
        w: 320,
        h: 200,
        spec: {
          version: 1,
          kind: "bar",
          orientation: "columns",
          headerRow: true,
          labelColumn: true,
          legend: true,
          seriesColors: {
            c2: "#0083d5",
            c3: "red;position:fixed;top:0;left:0;width:100vw;height:100vh",
          },
        },
        dataSnapshot: { labels: ["a"], series: [{ id: "c2", name: "A", values: [1] }] },
      },
    }] as never);

    expect(getViewerSafetyIssues(document)).toContain(
      "pageLayout.overlay.overlaySnapshot.shapes.0.props.spec.seriesColors.c3: CSS注入につながる文字列は指定できません。",
    );
  });

  it("accepts a callout that uses the colors the app writes", () => {
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "safe-callout",
      type: "callout",
      x: 10,
      y: 10,
      props: {
        w: 160,
        h: 90,
        radius: 8,
        tail: { baseStart: { x: 0, y: 90 }, baseEnd: { x: 20, y: 90 }, tip: { x: 10, y: 120 } },
        blocks: [{
          type: "paragraph",
          id: "p_safe_callout",
          children: [{ type: "text", text: "safe", color: "#1f2937" }],
        }],
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    }]);

    expect(getViewerSafetyIssues(document)).toEqual([]);
  });

  it("validates raster signatures and normalizes surrounding whitespace", () => {
    const validated = validateImageDataUrl(`  ${VALID_PNG}\n`);
    expect(validated).toEqual({
      ok: true,
      value: { src: VALID_PNG, mimeType: "image/png" },
    });

    expect(validateImageDataUrl("data:image/png;base64,AAAA")).toEqual(expect.objectContaining({ ok: false }));
    expect(validateImageDataUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")).toEqual(expect.objectContaining({ ok: false }));
    expect(validateImageDataUrl("data:image/jpg;base64,/9j/2Q==")).toEqual(expect.objectContaining({ ok: false }));
  });

  it("accepts self-contained SVG and rejects active or externally-referencing SVG", () => {
    const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="gradient"><stop stop-color="#fff"/></linearGradient><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><rect width="10" height="10" fill="url(#gradient)" clip-path="url(\'#clip\')"/></svg>';
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(safeSvg)}`))
      .toEqual(expect.objectContaining({ ok: true }));

    const externalSvg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>';
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(externalSvg)}`))
      .toEqual(expect.objectContaining({ ok: false }));

    const cssSvg = '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/a.css";</style></svg>';
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(cssSvg)}`))
      .toEqual(expect.objectContaining({ ok: false }));

    const externalCssUrlSvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.com/paint.svg#gradient)"/></svg>';
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(externalCssUrlSvg)}`))
      .toEqual(expect.objectContaining({ ok: false }));
  });

  it("returns invalid instead of throwing for out-of-range XML character references", () => {
    const invalidEntitySvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>&#1114112;</text></svg>';
    const oversizedEntitySvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>&#999999999999999999999999999999;</text></svg>';

    expect(() => validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(invalidEntitySvg)}`)).not.toThrow();
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(invalidEntitySvg)}`))
      .toEqual(expect.objectContaining({ ok: false }));
    expect(validateImageDataUrl(`data:image/svg+xml,${encodeURIComponent(oversizedEntitySvg)}`))
      .toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("block space after", () => {
  const OUT_OF_RANGE = "ブロック下余白は0以上400以下の数値で指定してください。";

  it("reports an out-of-range value on a top-level block", () => {
    const document = createDocument();
    document.content = [{ type: "paragraph", id: "body", children: [], spaceAfterPx: -1 }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once for a rich block (the dispatcher must not double count)", () => {
    const document = createDocument();
    document.content = [{ type: "heading", id: "h", level: 2, children: [], spaceAfterPx: 401 }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once inside a problem area", () => {
    const document = createDocument();
    document.content = [{
      type: "problem",
      id: "problem",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "in_problem", children: [], spaceAfterPx: Number.NaN }],
      solution: [],
      hints: [],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.prompt.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once inside a layout section", () => {
    const document = createDocument();
    document.content = [{
      type: "layoutSection",
      id: "layout",
      layout: { columnCount: 2 },
      children: [{ type: "paragraph", id: "in_layout", children: [], spaceAfterPx: -2 }],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.children.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once inside a box block", () => {
    const document = createDocument();
    document.content = [{
      type: "boxBlock",
      id: "box",
      styleId: "itembox",
      blocks: [{ type: "paragraph", id: "in_box", children: [], spaceAfterPx: -3 }],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.blocks.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once for a layout section nested in a box block", () => {
    const document = createDocument();
    document.content = [{
      type: "boxBlock",
      id: "box",
      styleId: "itembox",
      blocks: [{
        type: "layoutSection",
        id: "nested_layout",
        layout: { columnCount: 2 },
        spaceAfterPx: -4,
        children: [{ type: "paragraph", id: "nested_p", children: [] }],
      }],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.blocks.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once inside a quote", () => {
    const document = createDocument();
    document.content = [{
      type: "quote",
      id: "quote",
      blocks: [{ type: "paragraph", id: "in_quote", children: [], spaceAfterPx: -5 }],
    }];

    expect(getViewerSafetyIssues(document)).toEqual([`content.0.blocks.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once for a nested list", () => {
    const document = createDocument();
    document.content = [{
      type: "list",
      id: "list",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "li",
        children: [],
        nested: [{ type: "list", id: "nested_list", listType: "bullet", items: [], spaceAfterPx: -6 }],
      }],
    }];

    expect(getViewerSafetyIssues(document))
      .toEqual([`content.0.items.0.nested.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("reports it exactly once in a running region", () => {
    const document = createDocument();
    document.pageLayout = {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      header: {
        enabled: true,
        heightMm: 12,
        offsetMm: 8,
        showOnFirstPage: true,
        blocks: [{ type: "paragraph", id: "header_p", children: [], spaceAfterPx: -7 }],
      },
    };

    expect(getViewerSafetyIssues(document))
      .toEqual([`pageLayout.header.blocks.0.spaceAfterPx: ${OUT_OF_RANGE}`]);
  });

  it("accepts the whole allowed range and an untouched block", () => {
    const document = createDocument();
    document.content = [
      { type: "paragraph", id: "zero", children: [], spaceAfterPx: 0 },
      { type: "paragraph", id: "max", children: [], spaceAfterPx: 400 },
      { type: "paragraph", id: "fraction", children: [], spaceAfterPx: 12.5 },
      { type: "paragraph", id: "unset", children: [] },
    ];

    expect(getViewerSafetyIssues(document)).toEqual([]);
  });
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "viewer-safety",
    metadata: { title: "Safety" },
    content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "safe" }] }],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function pageLayoutWithShapes(
  shapes: NonNullable<NonNullable<SigmaDocument["pageLayout"]>["overlay"]>["overlaySnapshot"] extends infer Snapshot
    ? Snapshot extends { shapes: infer Shapes }
      ? Shapes
      : never
    : never,
): NonNullable<SigmaDocument["pageLayout"]> {
  return {
    preset: "A4",
    orientation: "portrait",
    pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes,
        assets: {},
      },
    },
  };
}

function graph3DShape(): Extract<OverlayShape, { type: "graph3dShape" }> {
  const spec: Graph3DSpec = {
    version: 1,
    parameters: [],
    objects: [{
      id: "surface",
      kind: "parametricSurface",
      x: "u",
      y: "v",
      z: "sin(u) + cos(v)",
      u: { min: "-5", max: "5", samples: 24 },
      v: { min: "-5", max: "5", samples: 24 },
      style: { color: "#65788a", wireframeColor: "#17212b" },
    }],
    cuts: [{
      id: "cut",
      targetObjectIds: ["surface"],
      plane: { kind: "equation", expression: "x + y = 1" },
      section: {
        fill: { mode: "pattern", color: "#d97706", pattern: "diagonal" },
        lineColor: "#92400e",
      },
      trail: { parameterId: "s", samples: 8, color: "#2563eb" },
    }],
    regions: [],
    annotations: [],
    camera: {
      projection: "perspective",
      position: { x: 5, y: -6, z: 4 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
    view: {
      coordinateSystem: "zUp",
      showAxes: true,
      showGrid: true,
      showAxisLabels: true,
      backgroundColor: "#ffffff",
    },
  };
  return {
    id: "graph3d",
    type: "graph3dShape",
    x: 10,
    y: 20,
    props: { w: 320, h: 220, spec },
  };
}
