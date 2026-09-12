import type {
  OverlayPoint,
  OverlayRegularPolygonSides,
} from "@/features/document";

export const REGULAR_POLYGON_SIDES = [5, 6, 7, 8, 9, 10, 11, 12] as const satisfies readonly OverlayRegularPolygonSides[];

export function normalizeRegularPolygonSides(value: unknown): OverlayRegularPolygonSides {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  const rounded = Math.round(Number.isFinite(parsed) ? parsed : 5);
  return Math.min(12, Math.max(5, rounded)) as OverlayRegularPolygonSides;
}

/**
 * 正多角形の頂点を、頂点群の外接矩形が指定領域の四辺へ接するよう正規化する。
 * external canvas editors の polygon geometry と同じ操作上の考え方を SigmaDoc overlay 用に再実装している。
 */
export function getRegularPolygonPoints(
  width: number,
  height: number,
  sides: OverlayRegularPolygonSides,
  inset = 0,
): OverlayPoint[] {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const left = Math.min(Math.max(0, inset), safeWidth / 2);
  const top = Math.min(Math.max(0, inset), safeHeight / 2);
  const innerWidth = Math.max(0, safeWidth - left * 2);
  const innerHeight = Math.max(0, safeHeight - top * 2);
  const rawPoints = Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const xs = rawPoints.map((point) => point.x);
  const ys = rawPoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rawWidth = Math.max(Number.EPSILON, maxX - minX);
  const rawHeight = Math.max(Number.EPSILON, maxY - minY);

  return rawPoints.map((point) => ({
    x: left + ((point.x - minX) / rawWidth) * innerWidth,
    y: top + ((point.y - minY) / rawHeight) * innerHeight,
  }));
}

export function regularPolygonSidesFromCommand(command: string): OverlayRegularPolygonSides | null {
  switch (command) {
    case "pentagon": return 5;
    case "hexagon": return 6;
    case "heptagon": return 7;
    case "octagon": return 8;
    case "nonagon": return 9;
    case "decagon": return 10;
    case "hendecagon": return 11;
    case "dodecagon": return 12;
    default: return null;
  }
}
