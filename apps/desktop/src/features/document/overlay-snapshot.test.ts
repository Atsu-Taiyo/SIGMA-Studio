import { overlayTextBlocksToInlineNodes } from "./overlay-inline-projection";
import { isOverlayShape } from "./overlay-validation";
import { describe, expect, it } from "vitest";

import {
  createEmptyOverlaySnapshot,
  normalizeOverlaySnapshot,
  prepareOverlaySnapshotForValidation,
  recoverOverlaySnapshot,
  patchShape,
  removeShapes,
  upsertShape,
} from "./overlay-snapshot";
import type {
  OverlayGeoShape,
  OverlayShape,
  OverlayTextShape,
} from "./overlay-model";

function rectangle(id: string, x = 0): OverlayGeoShape {
  return {
    id,
    type: "geo",
    x,
    y: 20,
    props: {
      w: 100,
      h: 60,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function textShape(id: string): OverlayTextShape {
  return {
    id,
    type: "text",
    x: 10,
    y: 20,
    props: {
      w: 120,
      h: 24,
      blocks: [{
          type: "paragraph", id: "overlay_snapshot_test_13",
          children: [{ type: "text", text: "式" }],
        }],
      color: "black",
      size: "m",
    },
  };
}

describe("overlay snapshot normalization", () => {
  it("returns the same normalized reference for the same immutable input", () => {
    const snapshot = {
      version: 1,
      shapes: [rectangle("shape_a")],
      assets: {},
    };

    const normalized = normalizeOverlaySnapshot(snapshot);

    expect(normalizeOverlaySnapshot(snapshot)).toBe(normalized);
    expect(normalized).not.toBe(snapshot);
  });

  it("returns a fresh canonical empty snapshot for invalid input", () => {
    expect(normalizeOverlaySnapshot(null)).toEqual(createEmptyOverlaySnapshot());
    expect(normalizeOverlaySnapshot({ version: 2, shapes: [], assets: {} })).toEqual(
      createEmptyOverlaySnapshot(),
    );
  });

  it("drops invalid records and strips undefined persisted shape fields", () => {
    const shape = {
      ...rectangle("shape_valid"),
      parentId: undefined,
      groupId: undefined,
      anchor: undefined,
    };
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [shape, { id: "invalid" }],
      assets: {
        invalid_asset: { id: "invalid_asset", type: "video" },
      },
    });

    expect(normalized.shapes).toHaveLength(1);
    expect(normalized.assets).toEqual({});
    expect(Object.hasOwn(normalized.shapes[0], "parentId")).toBe(false);
    expect(Object.hasOwn(normalized.shapes[0], "groupId")).toBe(false);
    expect(Object.hasOwn(normalized.shapes[0], "anchor")).toBe(false);
  });

  it("preserves valid flip flags and rejects non-boolean flip values", () => {
    const flipped = { ...rectangle("shape_flipped"), flipX: true, flipY: false };
    const invalid = { ...rectangle("shape_invalid_flip"), flipX: "yes" };
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [flipped, invalid],
      assets: {},
    });

    expect(normalized.shapes).toHaveLength(1);
    expect(normalized.shapes[0]).toMatchObject({ id: "shape_flipped", flipX: true, flipY: false });
  });

  it("keeps only canonical fields and moves legacy metadata into namespaced extensions", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      ignoredSnapshotField: true,
      extensions: {
        "vendor.example": { enabled: true },
      },
      shapes: [{
        ...rectangle("shape_meta"),
        meta: { source: "pptx", slide: 2 },
        ignoredShapeField: "remove",
        props: {
          ...rectangle("shape_meta").props,
          ignoredPropField: "remove",
        },
      }],
      assets: {
        image_1: {
          id: "image_1",
          type: "image",
          props: {
            w: 10,
            h: 20,
            name: "image.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "data:image/png;base64,AA==",
            fileSize: 2,
            ignoredPropField: "remove",
          },
          meta: { importedBy: "legacy" },
          ignoredAssetField: "remove",
        },
      },
    });

    expect(normalized.extensions).toEqual({
      "vendor.example": { enabled: true },
      "sigma.legacy.metadata": {
        shapes: {
          shape_meta: { source: "pptx", slide: 2 },
        },
        assets: {
          image_1: { importedBy: "legacy" },
        },
      },
    });
    expect(normalized.shapes[0]).not.toHaveProperty("meta");
    expect(normalized.shapes[0]).not.toHaveProperty("ignoredShapeField");
    expect(normalized.shapes[0]?.props).not.toHaveProperty("ignoredPropField");
    expect(normalized.assets.image_1).not.toHaveProperty("meta");
    expect(normalized.assets.image_1?.props).not.toHaveProperty("ignoredPropField");
  });

  it("migrates legacy graph outer bounds to canonical plot bounds", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "legacy_graph",
        type: "graph2dShape",
        x: 10,
        y: 20,
        props: {
          w: 360,
          h: 240,
          spec: {
            kind: "cartesian",
            title: "",
            width: 360,
            height: 240,
            viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
            axes: { grid: false },
            curves: [],
          },
        },
      }],
      assets: {},
    });

    expect(normalized.shapes).toEqual([
      expect.objectContaining({
        id: "legacy_graph",
        x: 56,
        y: 38,
        props: expect.objectContaining({
          boundsMode: "plot",
          w: 296,
          h: 188,
        }),
      }),
    ]);
  });
});

describe("overlay CSS scalar sanitization", () => {
  // One value that, written into any string-serialized `style` attribute, closes the color
  // declaration and paints an opaque full-screen layer over the app.
  const INJECTED = "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

  it("replaces an injected required color without dropping the shape or touching its geometry", () => {
    const input = rectangle("shape_geo");
    input.props.color = INJECTED;

    const normalized = normalizeOverlaySnapshot({ version: 1, shapes: [input], assets: {} });

    expect(normalized.shapes).toHaveLength(1);
    expect(normalized.shapes[0]).toMatchObject({
      id: "shape_geo",
      type: "geo",
      x: 0,
      y: 20,
      props: { w: 100, h: 60, geo: "rectangle", fill: "none", dash: "solid", size: "m" },
    });
    expect((normalized.shapes[0] as OverlayGeoShape).props.color).toBe("black");
  });

  it("replaces an injected labelColor and deletes an injected optional fillColor", () => {
    const input = rectangle("shape_geo");
    input.props.labelColor = INJECTED;
    input.props.fillColor = INJECTED;

    const props = (normalizeOverlaySnapshot({
      version: 1,
      shapes: [input],
      assets: {},
    }).shapes[0] as OverlayGeoShape).props;

    expect(props.labelColor).toBe("black");
    expect("fillColor" in props).toBe(false);
  });

  it("keeps every color notation the app itself writes", () => {
    const input = rectangle("shape_geo");
    input.props.color = "#1f2937";
    input.props.labelColor = "rgba(0, 0, 0, 0.5)";
    input.props.fillColor = "transparent";

    const props = (normalizeOverlaySnapshot({
      version: 1,
      shapes: [input],
      assets: {},
    }).shapes[0] as OverlayGeoShape).props;

    expect(props.color).toBe("#1f2937");
    expect(props.labelColor).toBe("rgba(0, 0, 0, 0.5)");
    expect(props.fillColor).toBe("transparent");
  });

  it("replaces an injected text shape color", () => {
    const input = textShape("shape_text");
    input.props.color = INJECTED;

    const shape = normalizeOverlaySnapshot({
      version: 1,
      shapes: [input],
      assets: {},
    }).shapes[0] as OverlayTextShape;

    expect(shape.props.color).toBe("black");
    expect(overlayTextBlocksToInlineNodes(shape.props.blocks)[0]).toMatchObject({ type: "text", text: "式" });
  });

  it("replaces an injected callout color", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_callout",
        type: "callout",
        x: 0,
        y: 0,
        props: {
          w: 120,
          h: 60,
          radius: 8,
          tail: { baseStart: { x: 0, y: 0 }, baseEnd: { x: 10, y: 0 }, tip: { x: 5, y: 20 } },
          blocks: [{ type: "paragraph", id: "overlay_snapshot_test_14", children: [{ type: "text", text: "注" }] }],
          color: INJECTED,
          size: "m",
          dash: "solid",
          strokeWidth: "m",
        },
      }],
      assets: {},
    });

    expect(normalized.shapes).toHaveLength(1);
    expect((normalized.shapes[0].props as { color: string }).color).toBe("black");
  });

  it("deletes injected inline node styling instead of inheriting it", () => {
    const input = textShape("shape_text");
    input.props.blocks = [{
      type: "paragraph",
      id: "p_injected",
      children: [{
        type: "text",
        text: "式",
        color: INJECTED,
        backgroundColor: INJECTED,
        fontFamily: "serif;}html{display:none",
      }],
    }];

    const child = overlayTextBlocksToInlineNodes((normalizeOverlaySnapshot({
      version: 1,
      shapes: [input],
      assets: {},
    }).shapes[0] as OverlayTextShape).props.blocks)[0] as unknown as Record<string, unknown>;

    expect(child).toMatchObject({ type: "text", text: "式" });
    expect("color" in child).toBe(false);
    expect("backgroundColor" in child).toBe(false);
    expect("fontFamily" in child).toBe(false);
  });

  it("keeps inline styling the settings UI produces", () => {
    const input = textShape("shape_text");
    input.props.blocks = [{
      type: "paragraph",
      id: "p_settings",
      children: [{
        type: "text",
        text: "式",
        color: "#1f2937",
        backgroundColor: "rgb(255, 255, 0)",
        fontFamily: "KaTeX_Main, \"M PLUS 1p\", serif",
      }],
    }];

    expect(overlayTextBlocksToInlineNodes((normalizeOverlaySnapshot({
      version: 1,
      shapes: [input],
      assets: {},
    }).shapes[0] as OverlayTextShape).props.blocks)[0]).toMatchObject({
      color: "#1f2937",
      backgroundColor: "rgb(255, 255, 0)",
      fontFamily: "KaTeX_Main, \"M PLUS 1p\", serif",
    });
  });

  it("replaces an injected graph axis color and keeps the rest of the spec", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_graph",
        type: "graph2dShape",
        x: 10,
        y: 20,
        props: {
          boundsMode: "plot",
          w: 296,
          h: 188,
          spec: {
            kind: "cartesian",
            title: "",
            width: 360,
            height: 240,
            viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
            axes: { grid: false, axisColor: INJECTED },
            curves: [{ id: "c1", expr: "x", color: INJECTED }],
            points: [{ id: "p1", x: "1", y: "1", color: INJECTED }],
            fills: [{ id: "f1", x: "0", y: "0", color: INJECTED }],
          },
        },
      }],
      assets: {},
    });

    const spec = (normalized.shapes[0].props as { spec: {
      axes: { axisColor?: string; grid: boolean };
      curves: { color: string; expr: string }[];
      points?: { color?: string }[];
      fills?: { color?: string }[];
    } }).spec;

    expect(spec.axes.axisColor).toBeUndefined();
    expect(spec.axes.grid).toBe(false);
    expect(spec.curves[0]).toMatchObject({ expr: "x", color: "black" });
    expect(spec.points?.[0].color).toBeUndefined();
    expect(spec.fills?.[0].color).toBeUndefined();
  });

  it("replaces injected table colors and font families without dropping the table", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_table",
        type: "tableShape",
        x: 0,
        y: 0,
        props: {
          w: 200,
          h: 100,
          table: {
            version: 1,
            kind: "plain",
            rows: [{ id: "r1", height: { mode: "auto" } }],
            columns: [{ id: "c1", width: { mode: "auto" } }],
            cells: [{
              id: "cell1",
              rowId: "r1",
              columnId: "c1",
              content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "1", color: INJECTED }] }],
              style: { color: INJECTED, backgroundColor: INJECTED, fontFamily: "serif;}html{display:none" },
            }],
            grid: {
              borderColor: INJECTED,
              borderWidth: 1,
              lineOverrides: [{ axis: "vertical", edge: "left", style: { borderColor: INJECTED } }],
            },
            defaultCellStyle: { backgroundColor: INJECTED },
          },
        },
      }],
      assets: {},
    });

    expect(normalized.shapes).toHaveLength(1);
    const table = (normalized.shapes[0].props as unknown as { table: {
      grid: { borderColor: string; borderWidth: number; lineOverrides?: { style: { borderColor?: string } }[] };
      defaultCellStyle?: { backgroundColor?: string };
      cells: { style?: Record<string, unknown>; content: { children: Record<string, unknown>[] }[] }[];
    } }).table;

    expect(table.grid.borderColor).toBe("black");
    expect(table.grid.borderWidth).toBe(1);
    expect(table.grid.lineOverrides?.[0].style.borderColor).toBeUndefined();
    expect(table.defaultCellStyle?.backgroundColor).toBeUndefined();
    expect("color" in (table.cells[0].style ?? {})).toBe(false);
    expect("backgroundColor" in (table.cells[0].style ?? {})).toBe(false);
    expect("fontFamily" in (table.cells[0].style ?? {})).toBe(false);
    expect("color" in table.cells[0].content[0].children[0]).toBe(false);
  });

  it("rejects a non-string color, which no structural type guard checks", () => {
    // `isGraph2DSpec` never looks at the type of `axes.axisColor` (every other graph color IS
    // string-guarded), and React stringifies a non-string style value with `"" + value` — so a
    // one-element array smuggles the same payload past a `typeof value === "string"` check.
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_graph",
        type: "graph2dShape",
        x: 10,
        y: 20,
        props: {
          boundsMode: "plot",
          w: 296,
          h: 188,
          spec: {
            kind: "cartesian",
            title: "",
            width: 360,
            height: 240,
            viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
            axes: { grid: false, axisColor: [INJECTED] },
            curves: [{ id: "c1", expr: "x", color: INJECTED }],
          },
        },
      }],
      assets: {},
    });

    const spec = (normalized.shapes[0].props as unknown as { spec: {
      axes: Record<string, unknown>;
      curves: { color: string }[];
    } }).spec;

    expect("axisColor" in spec.axes).toBe(false);
    expect(spec.curves[0].color).toBe("black");
  });

  it("sanitizes a table trend label even when a decoy children array is present", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_table",
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
                // The trend type carries its inline nodes in `label`; an empty `children` beside it
                // must not be mistaken for the node list.
                children: [],
                label: [{ type: "text", text: "x", color: INJECTED }],
              }],
            }],
            grid: { borderColor: "#111827", borderWidth: 1 },
            defaultCellStyle: {},
          },
        },
      }],
      assets: {},
    });

    const label = (normalized.shapes[0].props as unknown as { table: {
      cells: { content: { label: Record<string, unknown>[] }[] }[];
    } }).table.cells[0].content[0].label[0];

    expect(label).toMatchObject({ type: "text", text: "x" });
    expect("color" in label).toBe(false);
  });

  it("leaves a clean snapshot's nested objects untouched by reference", () => {
    const spec = {
      kind: "cartesian",
      title: "",
      width: 360,
      height: 240,
      viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
      axes: { grid: false, axisColor: "#1f2937" },
      curves: [{ id: "c1", expr: "x", color: "#c00000" }],
    };

    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_graph",
        type: "graph2dShape",
        x: 10,
        y: 20,
        props: { boundsMode: "plot", w: 296, h: 188, spec },
      }],
      assets: {},
    });

    expect((normalized.shapes[0].props as { spec: unknown }).spec).toBe(spec);
  });
});

describe("overlay asset source allow-list", () => {
  function snapshotWithAssetSrc(src: string) {
    return {
      version: 1,
      shapes: [{
        id: "shape_image",
        type: "image",
        x: 0,
        y: 0,
        props: { assetId: "asset_1", w: 100, h: 80 },
      }],
      assets: {
        asset_1: {
          id: "asset_1",
          type: "image",
          props: { w: 100, h: 80, name: "x.png", isAnimated: false, mimeType: "image/png", src, fileSize: 10 },
        },
      },
    };
  }

  it("drops an asset that points at the victim's disk, keeping the shape", () => {
    // `props.src` は `<img src>` と SVG 書き出しの `<image href>` にそのまま入る。教材を開かせる
    // だけで被害者のローカルファイルが描画され、PDF にも焼き込まれる。
    const normalized = normalizeOverlaySnapshot(snapshotWithAssetSrc("file:///Users/victim/Desktop/private.png"));

    expect(normalized.shapes).toHaveLength(1);
    expect(normalized.assets).toEqual({});
  });

  it("drops an asset that phones home", () => {
    const normalized = normalizeOverlaySnapshot(snapshotWithAssetSrc("https://attacker.example/beacon.png"));

    expect(normalized.shapes).toHaveLength(1);
    expect(normalized.assets).toEqual({});
  });

  it("keeps the sources the app itself produces", () => {
    for (const src of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "sigma-doc-storage://asset_01H9ABCDEF",
    ]) {
      const normalized = normalizeOverlaySnapshot(snapshotWithAssetSrc(src));
      expect(Object.keys(normalized.assets), src).toEqual(["asset_1"]);
      expect(normalized.assets.asset_1.props.src, src).toBe(src);
    }
  });

  it("applies the same rule on the recovery and the persistence paths", () => {
    // 3 つの入口すべて。`prepareOverlaySnapshotForValidation` は zod の preprocess なので、
    // ここを通ると **保存し直した文書にも許可外の src が残らない**。
    const poisoned = snapshotWithAssetSrc("file:///etc/passwd");

    expect(recoverOverlaySnapshot(poisoned).snapshot.assets).toEqual({});
    const prepared = prepareOverlaySnapshotForValidation(poisoned) as { assets: Record<string, unknown> };
    expect(prepared.assets).toEqual({});
  });
});

describe("overlay shape collection operations", () => {
  it("upserts without replacing unaffected shape references", () => {
    const first = rectangle("shape_a");
    const second = rectangle("shape_b", 200);
    const replacement = rectangle("shape_a", 40);

    const replaced = upsertShape([first, second], replacement);
    const appended = upsertShape([first], second);

    expect(replaced).toEqual([replacement, second]);
    expect(replaced[1]).toBe(second);
    expect(appended).toEqual([first, second]);
    expect(appended[0]).toBe(first);
  });

  it("takes any number for a block's bottom spacing and stores the normalized one", () => {
    // The body's own schema normalizes rather than refuses, and a shape block is a body block: a
    // paragraph copied out of the body must not be able to make the whole document unopenable.
    const input = textShape("shape_text");
    input.props.blocks = [{
      type: "paragraph",
      id: "p_space",
      spaceAfterPx: 12.5,
      children: [{ type: "text", text: "式" }],
    }];

    expect(isOverlayShape(input)).toBe(true);
    const normalized = normalizeOverlaySnapshot({ version: 1, shapes: [input], assets: {} });
    expect((normalized.shapes[0] as OverlayTextShape).props.blocks[0]).toMatchObject({ spaceAfterPx: 13 });
  });

  it("patches props shallowly and strips undefined fields", () => {
    const shape = textShape("shape_text");

    const [patched] = patchShape([shape], {
      id: shape.id,
      type: shape.type,
      x: 30,
      parentId: undefined,
      props: {
        color: "#2563eb",
      },
    });

    expect(patched).toMatchObject({
      id: shape.id,
      x: 30,
      props: {
        w: 120,
        h: 24,
        color: "#2563eb",
        size: "m",
      },
    });
    expect(Object.hasOwn(patched, "parentId")).toBe(false);
  });

  it("removes shape-anchored descendants transitively", () => {
    const root = rectangle("shape_root");
    const child: OverlayShape = {
      ...rectangle("shape_child"),
      anchor: {
        type: "shape",
        shapeId: root.id,
        dx: 0,
        dy: 0,
      },
    };
    const grandchild: OverlayShape = {
      ...rectangle("shape_grandchild"),
      anchor: {
        type: "shape",
        shapeId: child.id,
        dx: 0,
        dy: 0,
      },
    };
    const survivor = rectangle("shape_survivor");

    const next = removeShapes(
      [root, child, grandchild, survivor],
      [root.id],
    );

    expect(next).toEqual([survivor]);
    expect(next[0]).toBe(survivor);
  });
});

function chartShape(seriesColors: Record<string, string>): OverlayShape {
  return {
    id: "shape_chart",
    type: "chartShape",
    x: 20,
    y: 40,
    props: {
      w: 360,
      h: 220,
      spec: {
        version: 1,
        kind: "bar",
        orientation: "columns",
        headerRow: true,
        labelColumn: true,
        title: "Scores",
        legend: true,
        seriesColors,
      },
      sourceTableShapeId: "shape_table",
      dataSnapshot: {
        labels: ["Class A"],
        series: [{ id: "c2", name: "Math", values: [80] }],
      },
    },
  };
}

describe("chart snapshot normalization", () => {
  it("keeps every chart prop through normalization", () => {
    const shape = chartShape({ c2: "#0083d5" });

    expect(normalizeOverlaySnapshot({ version: 1, shapes: [shape], assets: {} }).shapes)
      .toEqual([shape]);
  });

  it("drops only the series colour that is not a safe CSS colour", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [chartShape({ c2: "#0083d5", c3: "url(javascript:alert(1))" })],
      assets: {},
    });
    const spec = (normalized.shapes[0] as Extract<OverlayShape, { type: "chartShape" }>).props.spec;

    expect(spec.seriesColors).toEqual({ c2: "#0083d5" });
  });

  it("keeps the chart itself when a series colour is rejected", () => {
    const normalized = normalizeOverlaySnapshot({
      version: 1,
      shapes: [chartShape({ c2: "url(javascript:alert(1))" })],
      assets: {},
    });

    expect(normalized.shapes).toHaveLength(1);
  });
});
