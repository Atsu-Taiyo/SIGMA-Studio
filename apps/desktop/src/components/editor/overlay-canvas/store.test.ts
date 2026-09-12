import { describe, expect, it } from "vitest";

import { getGraphPlotBox } from "@/lib/graph2d";

import { resolveShapeAnchorPositions } from "./anchor";
import { createGraphShapeProps } from "./shapes/graph";
import { createTableShapeProps } from "./shapes/table";
import { isValidOverlaySnapshot, normalizeOverlaySnapshot, removeShapes } from "./store";
import type { OverlaySnapshot } from "./types";

describe("overlay canvas store", () => {
  it("drops a text shape whose content is not in the canonical block form", () => {
    const snapshot = {
      version: 1,
      shapes: [{
        id: "legacy_text",
        type: "text",
        x: 10,
        y: 20,
        props: {
          w: 120,
          richText: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "式" }] },
              { type: "mathInline", attrs: { id: "legacy_math", tex: "x+1" } },
            ],
          },
          color: "black",
          size: "m",
        },
      }],
      assets: {},
    };

    // Shapes carry the body's blocks now; nothing translates an older representation on the way
    // in, so a shape that still holds one simply does not survive validation.
    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    const normalized = normalizeOverlaySnapshot(snapshot);
    expect(normalizeOverlaySnapshot(snapshot)).toBe(normalized);
    expect(normalized.shapes).toEqual([]);
  });

  it("keeps a text shape whose content is a canonical block list", () => {
    const snapshot = {
      version: 1,
      shapes: [{
        id: "list_text",
        type: "text",
        x: 10,
        y: 20,
        props: {
          w: 120,
          h: 32,
          blocks: [{
            type: "list",
            id: "list_1",
            listType: "bullet",
            items: [
              { type: "listItem", id: "li_1", children: [{ type: "text", text: "一" }] },
              { type: "listItem", id: "li_2", children: [{ type: "text", text: "二" }] },
            ],
          }],
          color: "black",
          size: "m",
        },
      }],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    const normalized = normalizeOverlaySnapshot(snapshot);
    expect(normalized.shapes[0].type === "text" ? normalized.shapes[0].props.blocks : []).toEqual(
      snapshot.shapes[0].props.blocks,
    );
  });

  it("migrates legacy graph outer bounds to plot bounds without moving anchored labels", () => {
    const graphProps = createGraphShapeProps("blank");
    const plotBox = getGraphPlotBox(graphProps.spec);
    const legacyGraph = {
      id: "legacy_graph",
      type: "graph2dShape" as const,
      x: 20,
      y: 30,
      anchor: { type: "block" as const, blockId: "block_1", dx: 20, dy: 30 },
      props: {
        ...graphProps,
        boundsMode: undefined,
        w: graphProps.w + plotBox.left + plotBox.right,
        h: graphProps.h + plotBox.top + plotBox.bottom,
      },
    };
    const legacyLabel = {
      id: "legacy_label",
      type: "text" as const,
      x: 0,
      y: 0,
      anchor: { type: "shape" as const, shapeId: legacyGraph.id, rx: 0.5, ry: 0.5, dx: 12, dy: -8 },
      props: {
        w: 20,
        h: 16,
        blocks: [{ type: "paragraph" as const, id: "p_1", children: [{ type: "text" as const, text: "x" }] }],
        color: "black",
        size: "s" as const,
      },
    };
    const previousLabelPosition = {
      x: legacyGraph.x + legacyGraph.props.w * legacyLabel.anchor.rx + legacyLabel.anchor.dx,
      y: legacyGraph.y + legacyGraph.props.h * legacyLabel.anchor.ry + legacyLabel.anchor.dy,
    };

    const normalized = normalizeOverlaySnapshot({ version: 1, shapes: [legacyGraph, legacyLabel], assets: {} });
    const graph = normalized.shapes[0];
    const resolvedLabel = resolveShapeAnchorPositions(normalized.shapes)[1];

    expect(graph.type).toBe("graph2dShape");
    expect(graph.type === "graph2dShape" ? graph.props.boundsMode : undefined).toBe("plot");
    expect(graph.x).toBe(legacyGraph.x + plotBox.left);
    expect(graph.y).toBe(legacyGraph.y + plotBox.top);
    expect(graph.type === "graph2dShape" ? graph.props.w : 0).toBe(graphProps.w);
    expect(graph.type === "graph2dShape" ? graph.props.h : 0).toBe(graphProps.h);
    expect(graph.anchor?.type === "block" ? graph.anchor.dx : undefined).toBe(legacyGraph.anchor.dx + plotBox.left);
    expect(graph.anchor?.type === "block" ? graph.anchor.dy : undefined).toBe(legacyGraph.anchor.dy + plotBox.top);
    expect(resolvedLabel.x).toBe(previousLabelPosition.x);
    expect(resolvedLabel.y).toBe(previousLabelPosition.y);
  });

  it("validates regular polygon side counts from five through twelve", () => {
    const createSnapshot = (polygonSides: number) => ({
      version: 1,
      shapes: [{
        id: "shape_polygon",
        type: "geo",
        x: 10,
        y: 20,
        props: {
          w: 120,
          h: 90,
          geo: "regularPolygon",
          polygonSides,
          fill: "none",
          color: "black",
          labelColor: "black",
          dash: "solid",
          size: "m",
        },
      }],
      assets: {},
    });

    expect(isValidOverlaySnapshot(createSnapshot(5))).toBe(true);
    expect(isValidOverlaySnapshot(createSnapshot(12))).toBe(true);
    expect(isValidOverlaySnapshot(createSnapshot(4))).toBe(false);
    expect(isValidOverlaySnapshot(createSnapshot(13))).toBe(false);
    expect(isValidOverlaySnapshot(createSnapshot(6.5))).toBe(false);
  });

  it("validates supported local overlay shape records", () => {
    const graphProps = createGraphShapeProps("cosine");
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_rect",
          type: "geo",
          x: 24,
          y: 32,
          rotation: Math.PI / 6,
          props: {
            w: 120,
            h: 80,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_graph",
          type: "graph2dShape",
          x: 40,
          y: 48,
          props: {
            ...graphProps,
            axisLabelTextShapeIds: {
              x: "shape_x_label",
            },
            pointLabelTextShapeIdsByPointId: {
              point_1: "shape_point_label",
            },
            annotationTextShapeIdsByAnnotationId: {
              annotation_1: "shape_annotation_label",
            },
            spec: {
              ...graphProps.spec,
              graphViewBox: {
                xMin: "-1",
                xMax: "1",
                yMin: "-1",
                yMax: "1",
              },
              showFormulaLabels: false,
              curves: graphProps.spec.curves.map((curve) => ({
                ...curve,
                mode: "xOfY",
                expr: "y^2",
                label: "x = y^2",
                dash: "dotted",
                strokeWidth: 3.4,
                domain: {
                  min: "-1",
                  max: "1",
                },
              })),
              points: [
                {
                  id: "point_1",
                  x: "1",
                  y: "2",
                  label: "A",
                  showXProjection: true,
                  showYProjection: true,
                },
              ],
              annotations: [
                {
                  id: "annotation_1",
                  x: "0",
                  y: "0",
                  text: "F",
                },
              ],
              fills: [
                {
                  id: "fill_1",
                  x: "0.5",
                  y: "0.5",
                  color: "#9ca3af",
                  opacity: 0.28,
                  pattern: "diagonal",
                },
              ],
            },
          },
        },
        {
          id: "shape_block_arrow",
          type: "geo",
          x: 44,
          y: 72,
          rotation: Math.PI / 8,
          props: {
            w: 180,
            h: 56,
            geo: "blockArrow",
            headLengthRatio: 0.4,
            shaftRatio: 0.5,
            fill: "solid",
            color: "black",
            fillColor: "#bfdbfe",
            fillOpacity: 0.75,
            labelColor: "black",
            dash: "solid",
            size: "l",
          },
        },
        {
          id: "shape_x_label",
          type: "text",
          x: 360,
          y: 60,
          anchor: { type: "shape", shapeId: "shape_graph", rx: 1, ry: 0.5, dx: -20, dy: -12 },
          props: {
            w: 24,
            h: 22,
            blocks: [{ type: "paragraph", id: "p_axis", children: [{ type: "text", text: "x" }] }],
            color: "black",
            size: "s",
          },
        },
        {
          id: "shape_point_label",
          type: "text",
          x: 320,
          y: 96,
          anchor: { type: "shape", shapeId: "shape_graph", rx: 1, ry: 0.5, dx: -60, dy: 24 },
          props: {
            w: 24,
            h: 22,
            blocks: [{ type: "paragraph", id: "p_2", children: [{ type: "text", text: "A" }] }],
            color: "black",
            size: "s",
          },
        },
        {
          id: "shape_annotation_label",
          type: "text",
          x: 240,
          y: 110,
          anchor: { type: "shape", shapeId: "shape_graph", rx: 0.5, ry: 0.5, dx: 12, dy: -20 },
          props: {
            w: 24,
            h: 22,
            blocks: [{ type: "paragraph", id: "p_3", children: [{ type: "text", text: "F" }] }],
            color: "black",
            size: "s",
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toHaveLength(6);
  });

  it("removes shape-anchored children when the parent shape is removed", () => {
    const graphProps = createGraphShapeProps("blank");
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_graph",
          type: "graph2dShape",
          x: 40,
          y: 48,
          props: graphProps,
        },
        {
          id: "shape_label",
          type: "text",
          x: 120,
          y: 88,
          anchor: { type: "shape", shapeId: "shape_graph", dx: 80, dy: 40 },
          props: {
            w: 24,
            h: 22,
            blocks: [{ type: "paragraph", id: "p_axis", children: [{ type: "text", text: "x" }] }],
            color: "black",
            size: "s",
          },
        },
      ],
      assets: {},
    };

    expect(removeShapes(snapshot.shapes, ["shape_graph"]).map((shape) => shape.id)).toEqual([]);
  });

  it("validates group shapes with parentId child links", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "group_1",
          type: "group",
          x: 20,
          y: 30,
          props: {
            w: 100,
            h: 70,
            name: "補助線",
          },
        },
        {
          id: "shape_a",
          type: "geo",
          x: 20,
          y: 30,
          parentId: "group_1",
          props: {
            w: 40,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_b",
          type: "geo",
          x: 80,
          y: 70,
          parentId: "group_1",
          props: {
            w: 40,
            h: 30,
            geo: "ellipse",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(normalizeOverlaySnapshot(snapshot).shapes.map((shape) => shape.id)).toEqual(["group_1", "shape_a", "shape_b"]);
  });

  it("normalizes groupId markers into explicit group shapes", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_a",
          type: "geo",
          x: 20,
          y: 30,
          groupId: "input_group",
          props: {
            w: 40,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_b",
          type: "geo",
          x: 80,
          y: 70,
          groupId: "input_group",
          props: {
            w: 40,
            h: 30,
            geo: "ellipse",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    const normalized = normalizeOverlaySnapshot(snapshot).shapes;

    expect(normalized.map((shape) => shape.id)).toEqual(["input_group", "shape_a", "shape_b"]);
    expect(normalized[0]).toMatchObject({ type: "group", x: 20, y: 30, props: { w: 100, h: 70 } });
    expect(normalized[1]).toMatchObject({ parentId: "input_group" });
    expect(normalized[2]).toMatchObject({ parentId: "input_group" });
    expect(normalized.some((shape) => shape.groupId)).toBe(false);
  });

  it("accepts overlay metadata and extended style props", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_triangle",
          type: "geo",
          x: 24,
          y: 32,
          groupId: "overlay_group_1",
          stackLayer: "background",
          locked: true,
          hidden: false,
          opacity: 0.5,
          anchor: { type: "block", blockId: "paragraph_1", dy: 32, dx: 12, line: { index: 1, dy: 4 } },
          props: {
            w: 120,
            h: 80,
            geo: "triangle",
            apexX: 28,
            fill: "solid",
            color: "#2563eb",
            fillColor: "#bfdbfe",
            strokeOpacity: 0.7,
            fillOpacity: 0.35,
            labelColor: "#2563eb",
            dash: "dashed",
            size: "l",
            label: "A",
          },
        },
        {
          id: "shape_arc",
          type: "arc",
          x: 80,
          y: 120,
          props: {
            r: 50,
            startAngle: 0,
            endAngle: Math.PI,
            arrowheadStart: "dot",
            arrowheadEnd: "arrow",
            color: "#dc2626",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_arrow",
          type: "arrow",
          x: 40,
          y: 80,
          props: {
            start: { x: 0, y: 0 },
            end: { x: 140, y: 0 },
            arrowheadStart: "dot",
            arrowheadEnd: "bar",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "dotted",
            size: "xl",
            label: "t",
          },
        },
        {
          id: "shape_curve",
          type: "line",
          x: 12,
          y: 24,
          props: {
            kind: "curve",
            points: [
              { x: 0, y: 0 },
              { x: 40, y: -28 },
              { x: 92, y: 12 },
            ],
            closed: false,
            arrowheadStart: "bar",
            arrowheadEnd: "arrow",
            fill: "solid",
            fillColor: "#fde68a",
            fillOpacity: 0.42,
            color: "#111827",
            labelColor: "#111827",
            dash: "solid",
            size: "m",
          },
        },
        {
          id: "shape_callout",
          type: "callout",
          x: 180,
          y: 60,
          props: {
            w: 120,
            h: 58,
            radius: 18,
            tail: {
              baseStart: { x: 48, y: 58 },
              baseEnd: { x: 82, y: 58 },
              tip: { x: 72, y: 80 },
            },
            blocks: [{ type: "paragraph", id: "p_callout", children: [{ type: "text", text: "説明" }] }],
            color: "#111111",
            size: "m",
            dash: "solid",
            strokeWidth: "m",
          },
        },
        {
          id: "shape_sector",
          type: "arc",
          x: 260,
          y: 120,
          props: {
            kind: "sector",
            r: 44,
            startAngle: -Math.PI / 4,
            endAngle: Math.PI / 3,
            fill: "solid",
            fillColor: "#e5e7eb",
            fillOpacity: 0.35,
            color: "#111827",
            dash: "dashed",
            size: "l",
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toHaveLength(6);
    expect(normalizeOverlaySnapshot(snapshot).shapes[0]).toMatchObject({ stackLayer: "background" });
  });

  it("rejects non-numeric shape rotation values", () => {
    const snapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_bad_rotation",
          type: "geo",
          x: 0,
          y: 0,
          rotation: "90deg",
          props: {
            w: 120,
            h: 80,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toEqual([]);
  });

  it("rejects the previous callout format without an explicit corner radius", () => {
    const snapshot = {
      version: 1,
      shapes: [{
        id: "legacy_callout",
        type: "callout",
        x: 0,
        y: 0,
        props: {
          w: 120,
          h: 58,
          tail: {
            baseStart: { x: 48, y: 58 },
            baseEnd: { x: 82, y: 58 },
            tip: { x: 72, y: 80 },
          },
          blocks: [{ type: "paragraph", id: "p_4", children: [] }],
          color: "#111111",
          size: "m",
        },
      }],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toEqual([]);
  });

  it("drops malformed shapes during normalization", () => {
    const snapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_bad",
          type: "arc",
          x: 0,
          y: 0,
          props: { startAngle: 0, endAngle: Math.PI, color: "black", dash: "solid", size: "m" },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toEqual([]);
  });

  it("validates table shapes with inline math cell content", () => {
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table.grid.lineOverrides = [
      {
        axis: "vertical",
        beforeColumnId: tableProps.table.columns[1].id,
        style: {
          borderStyle: "dotted",
          borderWidth: 3,
        },
      },
      {
        axis: "horizontal",
        edge: "bottom",
        style: {
          visible: false,
        },
      },
    ];
    tableProps.table.cells[0] = {
      ...tableProps.table.cells[0],
      content: [
        {
          type: "paragraph",
          id: "table_p_math",
          children: [
            { type: "text", text: "f'(x)=" },
            {
              type: "mathInline",
              id: "table_math_1",
              tex: "\\frac{1-\\log x}{x^2}",
              display: "inline",
            },
          ],
          align: "center",
        },
      ],
    };
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_table",
          type: "tableShape",
          x: 24,
          y: 32,
          rotation: Math.PI / 3,
          props: tableProps,
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toHaveLength(1);
  });

  it("rejects malformed table line overrides", () => {
    const tableProps = createTableShapeProps("plain", 240, 120);
    tableProps.table.grid.lineOverrides = [
      {
        axis: "vertical",
        edge: "top",
        style: {
          borderStyle: "dotted",
        },
      },
    ] as unknown as typeof tableProps.table.grid.lineOverrides;
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_table",
          type: "tableShape",
          x: 24,
          y: 32,
          props: tableProps,
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toHaveLength(0);
  });

  it("validates image assets backed by provider-neutral remote references", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_image",
          type: "image",
          x: 24,
          y: 32,
          props: {
            assetId: "asset_image",
            w: 180,
            h: 120,
          },
        },
      ],
      assets: {
        asset_image: {
          id: "asset_image",
          type: "image",
          props: {
            w: 640,
            h: 426,
            name: "figure.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "sigma-doc-storage://asset_image",
            fileSize: 12345,
            storage: {
              kind: "remote-asset",
              storageKey: "workspace/file/asset_image.png",
              assetId: "asset_image",
            },
          },
        },
      },
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    expect(normalizeOverlaySnapshot(snapshot).assets.asset_image?.props.storage?.storageKey).toBe("workspace/file/asset_image.png");
  });

  it("validates normalized image crop data", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_image",
          type: "image",
          x: 24,
          y: 32,
          props: {
            assetId: "asset_image",
            w: 180,
            h: 120,
            crop: {
              topLeft: { x: 0.1, y: 0.2 },
              bottomRight: { x: 0.9, y: 0.8 },
            },
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
  });

  it("rejects image crop data outside normalized bounds", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_image",
          type: "image",
          x: 24,
          y: 32,
          props: {
            assetId: "asset_image",
            w: 180,
            h: 120,
            crop: {
              topLeft: { x: -0.1, y: 0 },
              bottomRight: { x: 0.9, y: 1 },
            },
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(false);
    expect(normalizeOverlaySnapshot(snapshot).shapes).toHaveLength(0);
  });

});
