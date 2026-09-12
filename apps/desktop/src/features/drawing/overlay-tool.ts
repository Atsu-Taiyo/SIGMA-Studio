import type {
  Graph2DPreset,
  Graph3DPreset,
  SigmaChartData,
  SigmaChartSpec,
  SigmaTableSpec,
} from "@/features/document";

export type OverlayInsertCommand =
  | "rectangle"
  | "circle"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "heptagon"
  | "octagon"
  | "nonagon"
  | "decagon"
  | "hendecagon"
  | "dodecagon"
  | "blockArrow"
  | "arc"
  | "sector"
  | "threePointArc"
  | "arrow"
  | "line"
  | "polyline"
  | "curve"
  | "freehand"
  | "highlight"
  | "text"
  | "callout"
  | "graph"
  | "graph3d"
  | "table"
  | "chart";

export type OverlayTool =
  | { kind: "select" }
  | {
      kind: "insert";
      command: OverlayInsertCommand;
      graphPreset?: Graph2DPreset;
      graph3dPreset?: Graph3DPreset;
      /** 直前に調整した吹き出しの角丸半径。挿入プレビューと確定形状で共有する。 */
      calloutRadius?: number;
      table?: SigmaTableSpec;
      tableSize?: { w: number; h: number };
      /** Seed for a chart built from an existing table; see `createChartShapeProps`. */
      chart?: {
        sourceTableShapeId?: string;
        spec: SigmaChartSpec;
        dataSnapshot: SigmaChartData;
      };
    };
