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
import {
  getRegularPolygonPoints,
  getSolidPreset,
  getSolidTopology,
  REGULAR_POLYGON_SIDES,
  SOLID_BASE_SIDES,
} from "@/features/drawing";
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

/**
 * 数字を 7 セグメント風の線で描く。`origin` は数字列の左上、`digitWidth` と `digitHeight` は 1 桁の大きさ。
 * 図形の中央へ置く正多角形と、隅へ小さく置く立体で、同じ字形を共有する。
 */
function getNumeralPath(
  value: number,
  origin: { x: number; y: number },
  digit: { width: number; height: number; gap: number },
): string {
  const digits = String(value).split("");
  const half = digit.height / 2;
  const segmentPaths: Record<string, (x: number) => string> = {
    a: (x) => `M${x} ${origin.y}h${digit.width}`,
    b: (x) => `M${x + digit.width} ${origin.y}v${half}`,
    c: (x) => `M${x + digit.width} ${origin.y + half}v${half}`,
    d: (x) => `M${x} ${origin.y + digit.height}h${digit.width}`,
    e: (x) => `M${x} ${origin.y + half}v${half}`,
    f: (x) => `M${x} ${origin.y}v${half}`,
    g: (x) => `M${x} ${origin.y + half}h${digit.width}`,
  };

  return digits.flatMap((character, index) => {
    const x = origin.x + index * (digit.width + digit.gap);
    return (DIGIT_SEGMENTS[character] ?? []).map((segment) => segmentPaths[segment](x));
  }).join(" ");
}

function getPolygonNumberPath(value: number): string {
  const digitWidth = 3.4;
  const gap = 1.2;
  const digitCount = String(value).length;
  const totalWidth = digitCount * digitWidth + (digitCount - 1) * gap;
  return getNumeralPath(value, { x: 12 - totalWidth / 2, y: 8 }, { width: digitWidth, height: 8, gap });
}

/** 立体のアイコンの右下に置く、底面の辺の数。 */
const SOLID_NUMERAL_DIGIT = { width: 3, height: 6.4, gap: 0.9 } as const;

function getSolidNumeralPath(value: number): string {
  const digitCount = String(value).length;
  const totalWidth = digitCount * SOLID_NUMERAL_DIGIT.width + (digitCount - 1) * SOLID_NUMERAL_DIGIT.gap;
  return getNumeralPath(
    value,
    { x: 22.5 - totalWidth, y: 22.5 - SOLID_NUMERAL_DIGIT.height },
    SOLID_NUMERAL_DIGIT,
  );
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

/** 数字を添える立体 (底面が六角形以上) は、右下に数字の場所を空けて図を少し小さく描く。 */
const SOLID_ICON_BOX = 18;
const SOLID_ICON_BOX_WITH_NUMERAL = 15;
const SOLID_ICON_ORIGIN = 3;
const SOLID_NUMERAL_MIN_SIDES = 6;
/** 見えない辺を描く破線。小さい図でも点にならない程度の細かさ。 */
const SOLID_ICON_HIDDEN_DASH = "1.8 1.6";

/**
 * 角錐・角柱のアイコン。既定の見え方 (`getSolidPreset`) をそのまま縮めて、見えない辺は破線にする。
 * 図の縦横比は立体ごとに違うので、18px の枠に収まるよう縮めて中央に置く。
 */
function createSolidIcon(geo: "pyramid" | "prism", sides: (typeof SOLID_BASE_SIDES)[number]): LucideIcon {
  const preset = getSolidPreset(geo, sides);
  const numeral = sides >= SOLID_NUMERAL_MIN_SIDES;
  const box = numeral ? SOLID_ICON_BOX_WITH_NUMERAL : SOLID_ICON_BOX;
  const width = preset.aspect > 1 ? box / preset.aspect : box;
  const height = preset.aspect > 1 ? box : box * preset.aspect;
  const left = SOLID_ICON_ORIGIN - (numeral ? 0.5 : 0) + (box - width) / 2;
  const top = SOLID_ICON_ORIGIN - (numeral ? 0.5 : 0) + (box - height) / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  const points = preset.unitPoints.map((point) => ({
    x: round(left + point.x * width),
    y: round(top + point.y * height),
  }));
  const iconNode: Parameters<typeof createLucideIcon>[1] = getSolidTopology(geo, sides).edges.map(([from, to], index) => [
    "path",
    {
      d: `M${points[from].x} ${points[from].y}L${points[to].x} ${points[to].y}`,
      strokeWidth: "1.5",
      ...(preset.hiddenEdges[index] ? { strokeDasharray: SOLID_ICON_HIDDEN_DASH } : {}),
      key: `${geo}-${sides}-edge-${index}`,
    },
  ]);
  if (numeral) {
    iconNode.push(["path", {
      d: getSolidNumeralPath(sides),
      strokeWidth: "1.1",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      key: `${geo}-${sides}-numeral`,
    }]);
  }
  return createLucideIcon(`${geo}-${sides}`, iconNode);
}

/** 球: 輪郭の円と、手前が実線・奥が破線の赤道。 */
export const SphereIcon = createLucideIcon("sphere", [
  ["circle", { cx: "12", cy: "12", r: "9", key: "sphere-outline" }],
  ["path", { d: "M3 12a9 2.8 0 0 0 18 0", key: "sphere-equator-front" }],
  ["path", { d: "M3 12a9 2.8 0 0 1 18 0", strokeDasharray: "2 2", key: "sphere-equator-back" }],
]);

const PYRAMID_ICONS = Object.fromEntries(
  SOLID_BASE_SIDES.map((sides) => [sides, createSolidIcon("pyramid", sides)]),
) as Record<(typeof SOLID_BASE_SIDES)[number], LucideIcon>;

const PRISM_ICONS = Object.fromEntries(
  SOLID_BASE_SIDES.map((sides) => [sides, createSolidIcon("prism", sides)]),
) as Record<(typeof SOLID_BASE_SIDES)[number], LucideIcon>;

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
  id: "basic" | "pyramids" | "prisms" | "arcs" | "other" | "lines";
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
      id: "pyramids",
      label: t("gallery.pyramids"),
      items: [
        { action: "command", command: "sphere", label: t("tool.sphere"), icon: SphereIcon },
        ...SOLID_BASE_SIDES.map((sides): ShapeGalleryItem => ({
          action: "command",
          command: `pyramid${sides}`,
          label: t(`tool.pyramid${sides}`),
          icon: PYRAMID_ICONS[sides],
        })),
      ],
    },
    {
      id: "prisms",
      label: t("gallery.prisms"),
      items: SOLID_BASE_SIDES.map((sides): ShapeGalleryItem => ({
        action: "command",
        command: `prism${sides}`,
        label: t(`tool.prism${sides}`),
        icon: PRISM_ICONS[sides],
      })),
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
