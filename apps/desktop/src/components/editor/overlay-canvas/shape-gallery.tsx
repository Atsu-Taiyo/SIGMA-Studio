import {
  ArrowRight,
  Circle,
  createLucideIcon,
  Diamond,
  Image as ImageIcon,
  LineSquiggle,
  MessageSquare,
  Minus,
  PenLine,
  Radius,
  Rows3,
  Spline,
  Square,
  Triangle,
  Type,
  type LucideIcon,
} from "lucide-react";

import type { OverlayInsertCommand } from "@/features/drawing";
import type { OverlayCommand } from "@/components/editor/page-overlay-types";
import { getRegularPolygonPoints, REGULAR_POLYGON_SIDES } from "@/features/drawing";
import type { Translate } from "@/lib/i18n";

export const ThreePointArcIcon = createLucideIcon("three-point-arc", [
  ["path", { d: "M4 16.5A8.5 8.5 0 0 1 20 16.5", key: "three-point-arc-path" }],
  ["circle", { cx: "4", cy: "16.5", r: "1.4", fill: "currentColor", stroke: "none", key: "three-point-arc-start" }],
  ["circle", { cx: "12", cy: "7.5", r: "1.4", fill: "currentColor", stroke: "none", key: "three-point-arc-through" }],
  ["circle", { cx: "20", cy: "16.5", r: "1.4", fill: "currentColor", stroke: "none", key: "three-point-arc-end" }],
]);

export const BlockArrowIcon = createLucideIcon("block-arrow", [
  [
    "path",
    {
      d: "M3 9h10V5l8 7-8 7v-4H3z",
      fill: "currentColor",
      fillOpacity: "0.18",
      key: "block-arrow-body",
    },
  ],
  ["path", { d: "M3 9h10V5l8 7-8 7v-4H3z", key: "block-arrow-outline" }],
]);

export const PolylineIcon = createLucideIcon("polyline", [
  ["polyline", { points: "3 17 8.5 9.5 13.5 14 21 6", key: "polyline-path" }],
  ["circle", { cx: "3", cy: "17", r: "1.25", fill: "currentColor", stroke: "none", key: "polyline-start" }],
  ["circle", { cx: "8.5", cy: "9.5", r: "1.25", fill: "currentColor", stroke: "none", key: "polyline-bend-1" }],
  ["circle", { cx: "13.5", cy: "14", r: "1.25", fill: "currentColor", stroke: "none", key: "polyline-bend-2" }],
  ["circle", { cx: "21", cy: "6", r: "1.25", fill: "currentColor", stroke: "none", key: "polyline-end" }],
]);

const DIGIT_SEGMENTS: Record<string, readonly string[]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

function getPolygonNumberPath(value: number): string {
  const digits = String(value).split("");
  const digitWidth = 3.4;
  const gap = 1.2;
  const totalWidth = digits.length * digitWidth + (digits.length - 1) * gap;
  const originX = 12 - totalWidth / 2;
  const originY = 8;
  const segmentPaths: Record<string, (x: number) => string> = {
    a: (x) => `M${x} ${originY}h${digitWidth}`,
    b: (x) => `M${x + digitWidth} ${originY}v4`,
    c: (x) => `M${x + digitWidth} ${originY + 4}v4`,
    d: (x) => `M${x} ${originY + 8}h${digitWidth}`,
    e: (x) => `M${x} ${originY + 4}v4`,
    f: (x) => `M${x} ${originY}v4`,
    g: (x) => `M${x} ${originY + 4}h${digitWidth}`,
  };

  return digits.flatMap((digit, index) => {
    const x = originX + index * (digitWidth + gap);
    return (DIGIT_SEGMENTS[digit] ?? []).map((segment) => segmentPaths[segment](x));
  }).join(" ");
}

function createRegularPolygonIcon(sides: number): LucideIcon {
  const points = getRegularPolygonPoints(
    18,
    18,
    Math.min(12, Math.max(5, sides)) as 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
  )
    .map((point) => `${point.x + 3},${point.y + 3}`)
    .join(" ");
  const iconNode: Parameters<typeof createLucideIcon>[1] = [
    ["polygon", { points, key: `regular-polygon-${sides}-outline` }],
  ];
  if (sides >= 6) {
    iconNode.push(["path", {
      d: getPolygonNumberPath(sides),
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.35",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      key: `regular-polygon-${sides}-label`,
    }]);
  }
  return createLucideIcon(`regular-polygon-${sides}`, iconNode);
}

const REGULAR_POLYGON_ICONS = Object.fromEntries(
  REGULAR_POLYGON_SIDES.map((sides) => [sides, createRegularPolygonIcon(sides)]),
) as Record<(typeof REGULAR_POLYGON_SIDES)[number], LucideIcon>;

/**
 * 線ツールの一覧。**module 直下で文言を持たない** — 起動時の言語で焼き付くうえ、
 * このラベルはツールバーの `線ツール（現在: …）` へ補間されるので、ここが日本語だと
 * 英語 UI で混在した文になる。
 */
/**
 * 線ツールの並び。**ここが唯一の出典**で、一覧 (文言つき) も
 * {@link isLineToolCommand} の判定もここから導く。以前は
 * 「文言つきの配列」と「判定用のコマンド配列」を別々に持っていて、
 * 片方だけ増やすと新しい線ツールが黙って図形メニュー扱いになった。
 */
const LINE_TOOLS = [
  { command: "line", labelKey: "tool.line", icon: Minus },
  { command: "polyline", labelKey: "tool.polyline", icon: PolylineIcon },
  { command: "curve", labelKey: "tool.curve", icon: LineSquiggle },
  { command: "freehand", labelKey: "tool.freehand", icon: PenLine },
  { command: "arrow", labelKey: "tool.arrow", icon: ArrowRight },
  { command: "blockArrow", labelKey: "tool.blockArrow", icon: BlockArrowIcon },
] as const satisfies readonly { command: OverlayCommand; labelKey: string; icon: LucideIcon }[];

/**
 * 線ツールの一覧。**module 直下で文言を持たない** — 起動時の言語で焼き付くうえ、
 * このラベルはツールバーの `線ツール（現在: …）` へ補間されるので、ここが日本語だと
 * 英語 UI で混在した文になる。
 */
export function buildLineToolItems(
  t: Translate<"shape">,
): Array<{ command: OverlayCommand; label: string; icon: LucideIcon }> {
  return LINE_TOOLS.map(({ command, labelKey, icon }) => ({ command, label: t(labelKey), icon }));
}

/**
 * Accepts the wider `OverlayInsertCommand` because the active tool is typed that way, and it
 * carries commands the toolbar never offers (`chart` is created from a table's own menu). Those
 * simply answer `false` here rather than needing a cast at every call site.
 */
export function isLineToolCommand(command: OverlayCommand | OverlayInsertCommand): boolean {
  return LINE_TOOLS.some((tool) => tool.command === command);
}

export function isShapeMenuCommand(command: OverlayCommand | OverlayInsertCommand): boolean {
  return command !== "text" && command !== "graph" && command !== "chart" && !isLineToolCommand(command);
}

/** Google Slides風の「図形」ギャラリー1マス。command系は runOverlayCommand、image系は画像選択ダイアログを開く。 */
export interface ShapeGalleryItem {
  action: "command" | "image";
  command?: OverlayCommand;
  label: string;
  icon: LucideIcon;
}

export interface ShapeGallerySection {
  /** React の key と `data-*` 用。**翻訳文をキーに使わない**ため区分に id を持たせる。 */
  id: "basic" | "arcs" | "other" | "lines";
  label: string;
  items: ShapeGalleryItem[];
}

export function buildShapeGallerySections(t: Translate<"shape">): ShapeGallerySection[] {
  return [
    {
      id: "basic",
      label: t("gallery.basic"),
      items: [
        { action: "command", command: "rectangle", label: t("tool.rectangle"), icon: Square },
        { action: "command", command: "circle", label: t("tool.circle"), icon: Circle },
        { action: "command", command: "triangle", label: t("tool.triangle"), icon: Triangle },
        { action: "command", command: "diamond", label: t("tool.diamond"), icon: Diamond },
        { action: "command", command: "pentagon", label: t("tool.pentagon"), icon: REGULAR_POLYGON_ICONS[5] },
        { action: "command", command: "hexagon", label: t("tool.hexagon"), icon: REGULAR_POLYGON_ICONS[6] },
        { action: "command", command: "heptagon", label: t("tool.heptagon"), icon: REGULAR_POLYGON_ICONS[7] },
        { action: "command", command: "octagon", label: t("tool.octagon"), icon: REGULAR_POLYGON_ICONS[8] },
        { action: "command", command: "nonagon", label: t("tool.nonagon"), icon: REGULAR_POLYGON_ICONS[9] },
        { action: "command", command: "decagon", label: t("tool.decagon"), icon: REGULAR_POLYGON_ICONS[10] },
        { action: "command", command: "hendecagon", label: t("tool.hendecagon"), icon: REGULAR_POLYGON_ICONS[11] },
        { action: "command", command: "dodecagon", label: t("tool.dodecagon"), icon: REGULAR_POLYGON_ICONS[12] },
      ],
    },
    {
      id: "arcs",
      label: t("gallery.arcs"),
      items: [
        { action: "command", command: "arc", label: t("tool.arc"), icon: Spline },
        { action: "command", command: "sector", label: t("tool.sector"), icon: Radius },
        { action: "command", command: "threePointArc", label: t("tool.threePointArc"), icon: ThreePointArcIcon },
      ],
    },
    {
      id: "other",
      label: t("gallery.other"),
      items: [
        { action: "command", command: "text", label: t("tool.text"), icon: Type },
        { action: "command", command: "callout", label: t("tool.callout"), icon: MessageSquare },
        { action: "command", command: "table", label: t("tool.table"), icon: Rows3 },
        { action: "image", label: t("tool.image"), icon: ImageIcon },
      ],
    },
  ];
}

export function buildShapeTypeChangeSections(t: Translate<"shape">): ShapeGallerySection[] {
  return [
    ...buildShapeGallerySections(t).map((section) => ({
      ...section,
      items: section.items.filter((item) => (
        item.action === "command"
        && item.command !== "text"
        && item.command !== "table"
        && item.command !== "threePointArc"
      )),
    })).filter((section) => section.items.length > 0),
    {
      id: "lines",
      label: t("gallery.lines"),
      items: buildLineToolItems(t).map((item) => ({ action: "command" as const, ...item })),
    },
  ];
}
