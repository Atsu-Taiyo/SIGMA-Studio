import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  type LucideIcon,
} from "lucide-react";

import type {
  OverlayAlignAction,
  OverlayArrangeAction,
  OverlayDistributeAxis,
  OverlaySelectionSummary,
} from "@/components/editor/page-overlay-types";
import type { OverlayArrowhead, OverlayDash, OverlayTextSize } from "@/components/editor/overlay-canvas/types";
import {
  DEFAULT_BODY_FONT_FAMILY,
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  formatLineHeightLabel,
  LINE_HEIGHT_PRESETS,
  type BoxedVariant,
  type LineHeight,
  type TextAlign,
} from "@/features/document";

export {
  BlockArrowIcon,
  isLineToolCommand,
  isShapeMenuCommand,
  buildLineToolItems,
  buildShapeGallerySections,
  buildShapeTypeChangeSections,
  PolylineIcon,
  ThreePointArcIcon,
} from "@/components/editor/overlay-canvas/shape-gallery";
export type {
  ShapeGalleryItem,
  ShapeGallerySection,
} from "@/components/editor/overlay-canvas/shape-gallery";

export const REPORT_ISSUE_FORM_URL = "https://forms.gle/BAMWiZ1wC8PsUmX38";
export const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
export const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
export const TEXT_FORMAT_STATE_EVENT = "sigma-studio:text-format-state";
export const MATERIAL_EDITOR_FORMAT_TARGET = "material-editor";
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 800;
export const ZOOM_PRESETS = [10, 15, 25, 33, 50, 67, 75, 90, 100, 125, 150, 200, 300, 400, 600, 800] as const;
export const MAX_EXPORT_FILE_STEM_LENGTH = 80;
export const KEYBOARD_ZOOM_STEP = 10;
export const WHEEL_ZOOM_SENSITIVITY = 0.008;
export const SEARCH_QUERY_EVENT = "sigma-studio:search-query";
export const DEFAULT_OUTLINE_WIDTH = 288;
export const MIN_OUTLINE_WIDTH = 160;
export const MAX_OUTLINE_WIDTH = 520;
export const MIN_EDITOR_WIDTH_WHILE_RESIZING_OUTLINE = 560;
export const MAX_DOCUMENT_HISTORY = 100;
export const BASE_EDITOR_FONT_SIZE = 12;
/** Toolbar fallbacks for a selection that carries no explicit 文字色 / 行間. */
export const BASE_EDITOR_TEXT_COLOR = "#111111";
export const BASE_EDITOR_LINE_HEIGHT = "1.75";
export const PAGE_NAVIGATOR_PRINT_PAGE_WIDTH_PX = 794;
export const PAGE_NAVIGATOR_PRINT_PAGE_HEIGHT_PX = 1123;
export const PAGE_NAVIGATOR_SCALE_GUTTER_PX = 18;
export const PAGE_NAVIGATOR_MIN_SCALE = 0.18;
export const PAGE_NAVIGATOR_MAX_SCALE = 0.62;
export const PAGE_NAVIGATOR_SCROLL_PADDING_PX = 18;
export const MIN_BOXED_TEXT_PADDING_Y = 0;
export const MAX_BOXED_TEXT_PADDING_Y = 12;
// 表示ラベルは持たない (chrome namespace の `format.boxedText.variant.<variant>` /
// `format.align.<value>` が持つ)。ここは並びと値だけの SSoT。
export const BOXED_TEXT_STYLE_OPTIONS: Array<{ variant: BoxedVariant }> = [
  { variant: "frame" },
  { variant: "thick" },
  { variant: "double" },
  { variant: "oval" },
];
export const TEXT_ALIGN_OPTIONS: Array<{ value: TextAlign; icon: LucideIcon }> = [
  { value: "left", icon: AlignLeft },
  { value: "center", icon: AlignCenter },
  { value: "right", icon: AlignRight },
  { value: "justify", icon: AlignJustify },
];
export const LINE_HEIGHT_OPTIONS: Array<{ value: LineHeight; label: string }> = LINE_HEIGHT_PRESETS.map((value) => ({
  value,
  label: formatLineHeightLabel(value),
}));
/** ツールバーのフォントサイズ候補。表示は `15pt` のようにここで組み立てる。 */
export const TEXT_FONT_SIZE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10.5, 11, 12, 13.5, 15, 16.5, 18] as const;
/** 段落スタイルの並び。表示は `format.blockStyle.<value>`。 */
export const BLOCK_STYLE_OPTIONS = ["paragraph", "h1", "h2", "h3"] as const;
export type BlockStyleOptionValue = (typeof BLOCK_STYLE_OPTIONS)[number];
/** Re-exported so the toolbar keeps its own name for the shared document default. */
export const DEFAULT_FONT_FAMILY_VALUE = DEFAULT_BODY_FONT_FAMILY;

export interface FontFamilyOption {
  label: string;
  value: string;
}

/** グループ見出しの翻訳キー。`label` は検索用の既定表記で、表示は chrome namespace が持つ。 */
export type FontFamilyGroupId = "basic" | "windows" | "mac" | "macLatin" | "monospace";

export interface FontFamilyGroup {
  id: FontFamilyGroupId;
  /** 既定 (日本語) の見出し。表示は `format.font.group.<id>` を引くこと。 */
  label: string;
  options: FontFamilyOption[];
}

export const FONT_FAMILY_GROUPS: FontFamilyGroup[] = [
  {
    id: "basic",
    label: "基本",
    options: [
      { label: "M PLUS 1p", value: DEFAULT_FONT_FAMILY_VALUE },
      { label: "Noto Sans JP", value: '"Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "Hiragino Sans", Meiryo, sans-serif' },
      { label: "Noto Serif JP", value: DEFAULT_SERIF_BODY_FONT_FAMILY },
      { label: "游ゴシック", value: '"Yu Gothic", YuGothic, "Hiragino Sans", Meiryo, sans-serif' },
      { label: "游明朝", value: '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", serif' },
      { label: "Hiragino Mincho ProN", value: '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, serif' },
      { label: "Hiragino Maru Gothic ProN", value: '"Hiragino Maru Gothic ProN", "Tsukushi A Round Gothic", "Yu Gothic", sans-serif' },
    ],
  },
  {
    id: "windows",
    label: "Windows 日本語",
    options: [
      { label: "メイリオ", value: 'Meiryo, "Yu Gothic", "Hiragino Sans", sans-serif' },
      { label: "BIZ UDPゴシック", value: '"BIZ UDPGothic", "Yu Gothic", Meiryo, "Hiragino Sans", sans-serif' },
      { label: "BIZ UDP明朝", value: '"BIZ UDPMincho", "Yu Mincho", "Hiragino Mincho ProN", serif' },
      { label: "UD デジタル 教科書体", value: '"UD Digi Kyokasho NP-R", "UD Digi Kyokasho N-R", "BIZ UDPGothic", "Yu Gothic", sans-serif' },
      { label: "MS Pゴシック", value: '"MS PGothic", "Yu Gothic", Meiryo, "Hiragino Sans", sans-serif' },
      { label: "MS P明朝", value: '"MS PMincho", "Yu Mincho", "Hiragino Mincho ProN", serif' },
      { label: "HG創英角ポップ体", value: '"HG創英角ﾎﾟｯﾌﾟ体", "HGSoeiKakupoptai", Meiryo, "Yu Gothic", "Hiragino Sans", sans-serif' },
      { label: "HG丸ゴシックM-PRO", value: '"HG丸ｺﾞｼｯｸM-PRO", "HGMaruGothicMPRO", Meiryo, "Yu Gothic", "Hiragino Sans", sans-serif' },
      { label: "HG正楷書体PRO", value: '"HG正楷書体-PRO", "HGSeikaishotaiPRO", "Yu Mincho", "MS PMincho", "Hiragino Mincho ProN", serif' },
    ],
  },
  {
    id: "mac",
    label: "Mac 日本語",
    options: [
      { label: "ヒラギノ角ゴ", value: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif' },
      { label: "ヒラギノ角ゴ ProN", value: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif' },
      { label: "ヒラギノ明朝 ProN", value: '"Hiragino Mincho ProN", serif' },
      { label: "ヒラギノ丸ゴ ProN", value: '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif' },
      { label: "筑紫A丸ゴシック", value: '"Tsukushi A Round Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
      { label: "筑紫B丸ゴシック", value: '"Tsukushi B Round Gothic", "Hiragino Maru Gothic ProN", sans-serif' },
      { label: "筑紫明朝", value: '"Tsukushi Mincho", "Hiragino Mincho ProN", serif' },
      { label: "クレー", value: 'Klee, "Hiragino Maru Gothic ProN", cursive' },
      { label: "Osaka", value: 'Osaka, "Hiragino Sans", sans-serif' },
    ],
  },
  {
    id: "macLatin",
    label: "Mac 欧文",
    options: [
      { label: "システム (SF)", value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif' },
      { label: "New York", value: '"New York", ui-serif, Georgia, serif' },
      { label: "Helvetica Neue", value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
      { label: "Avenir Next", value: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif' },
      { label: "Avenir", value: 'Avenir, "Helvetica Neue", sans-serif' },
      { label: "Futura", value: 'Futura, "Trebuchet MS", sans-serif' },
      { label: "Gill Sans", value: '"Gill Sans", "Helvetica Neue", sans-serif' },
      { label: "Optima", value: 'Optima, Candara, sans-serif' },
      { label: "Palatino", value: 'Palatino, "Palatino Linotype", serif' },
      { label: "Baskerville", value: 'Baskerville, Georgia, serif' },
      { label: "Didot", value: 'Didot, "Bodoni 72", serif' },
      { label: "Hoefler Text", value: '"Hoefler Text", Georgia, serif' },
      { label: "Chalkboard SE", value: '"Chalkboard SE", "Comic Sans MS", cursive' },
      { label: "Marker Felt", value: '"Marker Felt", "Chalkboard SE", cursive' },
    ],
  },
  {
    id: "monospace",
    label: "等幅",
    options: [
      { label: "SF Mono / Menlo", value: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace' },
      { label: "Menlo", value: 'Menlo, Monaco, Consolas, monospace' },
      { label: "Monaco", value: 'Monaco, Menlo, Consolas, monospace' },
      { label: "Courier New", value: '"Courier New", Courier, monospace' },
    ],
  },
];
export const FONT_FAMILY_OPTIONS = FONT_FAMILY_GROUPS.flatMap((group) => group.options);
export const FONT_FAMILY_OPTION_VALUES = new Set(FONT_FAMILY_OPTIONS.map((option) => option.value));

/**
 * @param resolveGroupLabel 表示中の見出し。英語UIで "Basic" と打っても「基本」の
 *   グループに当たるよう、検索は **表示されている見出し** に対して行う。
 */
export function filterFontFamilyGroups(
  query: string,
  resolveGroupLabel: (group: FontFamilyGroup) => string = (group) => group.label,
): FontFamilyGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("ja");
  if (!normalizedQuery) {
    return FONT_FAMILY_GROUPS;
  }
  return FONT_FAMILY_GROUPS.flatMap((group) => {
    const groupMatches = resolveGroupLabel(group).toLocaleLowerCase("ja").includes(normalizedQuery);
    const options = groupMatches
      ? group.options
      : group.options.filter((option) => option.label.toLocaleLowerCase("ja").includes(normalizedQuery));
    return options.length > 0 ? [{ ...group, options }] : [];
  });
}
export const SHORTCUT_FONT_FAMILIES: Record<string, string> = {
  "format.font.default": "",
  "format.font.mPlus1p": DEFAULT_FONT_FAMILY_VALUE,
  "format.font.hiraginoSans": '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif',
  "format.font.hiraginoMincho": '"Hiragino Mincho ProN", serif',
  "format.font.hiraginoMaru": '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif',
  "format.font.yuGothic": '"Yu Gothic", YuGothic, "Hiragino Sans", Meiryo, sans-serif',
  "format.font.yuMincho": '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", serif',
  "format.font.tsukushiARound": '"Tsukushi A Round Gothic", "Hiragino Maru Gothic ProN", sans-serif',
  "format.font.tsukushiBRound": '"Tsukushi B Round Gothic", "Hiragino Maru Gothic ProN", sans-serif',
  "format.font.tsukushiMincho": '"Tsukushi Mincho", "Hiragino Mincho ProN", serif',
  "format.font.klee": 'Klee, "Hiragino Maru Gothic ProN", cursive',
  "format.font.monospace": 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
};
export const SHORTCUT_FONT_SIZES: Record<string, number> = {
  "format.fontSize.13": 10,
  "format.fontSize.14": 10.5,
  "format.fontSize.15": 11,
  "format.fontSize.16": 12,
  "format.fontSize.18": 13.5,
  "format.fontSize.20": 15,
  "format.fontSize.22": 16.5,
  "format.fontSize.24": 18,
};
export const SHORTCUT_LINE_HEIGHTS: Record<string, LineHeight> = {
  "format.lineHeight.1": "1",
  "format.lineHeight.1.15": "1.15",
  "format.lineHeight.1.35": "1.35",
  "format.lineHeight.1.5": "1.5",
  "format.lineHeight.1.75": "1.75",
  "format.lineHeight.2": "2",
};
export const SHORTCUT_BLOCK_STYLES: Record<string, "paragraph" | "h1" | "h2" | "h3"> = {
  "format.block.paragraph": "paragraph",
  "format.block.h1": "h1",
  "format.block.h2": "h2",
  "format.block.h3": "h3",
};
export const SHORTCUT_TEXT_ALIGNS: Record<string, TextAlign> = {
  "format.align.left": "left",
  "format.align.center": "center",
  "format.align.right": "right",
  "format.align.justify": "justify",
};
export const SHORTCUT_OVERLAY_ARRANGE_ACTIONS: Record<string, OverlayArrangeAction> = {
  "overlay.arrange.front": "front",
  "overlay.arrange.back": "back",
  "overlay.arrange.forward": "forward",
  "overlay.arrange.backward": "backward",
};
export const SHORTCUT_OVERLAY_ALIGN_ACTIONS: Record<string, OverlayAlignAction> = {
  "overlay.align.left": "left",
  "overlay.align.center": "center",
  "overlay.align.right": "right",
  "overlay.align.top": "top",
  "overlay.align.middle": "middle",
  "overlay.align.bottom": "bottom",
};
export const SHORTCUT_OVERLAY_DISTRIBUTE_ACTIONS: Record<string, OverlayDistributeAxis> = {
  "overlay.distribute.horizontal": "horizontal",
  "overlay.distribute.vertical": "vertical",
};
export const SHORTCUT_STROKE_COLORS: Record<string, string | null> = {
  "overlay.stroke.black": "#111827",
  "overlay.stroke.red": "#dc2626",
  "overlay.stroke.blue": "#2563eb",
  "overlay.stroke.green": "#16a34a",
  "overlay.stroke.none": null,
};
export const SHORTCUT_FILL_COLORS: Record<string, string | null> = {
  "overlay.fill.none": null,
  "overlay.fill.white": "#ffffff",
  "overlay.fill.yellow": "#facc15",
  "overlay.fill.blue": "#dbeafe",
  "overlay.fill.red": "#fee2e2",
  "overlay.fill.green": "#dcfce7",
};
export const SHORTCUT_LINE_DASHES: Record<string, OverlayDash> = {
  "overlay.line.solid": "solid",
  "overlay.line.dashed": "dashed",
  "overlay.line.dotted": "dotted",
};
export const SHORTCUT_LINE_WIDTHS: Record<string, OverlayTextSize> = {
  "overlay.line.width.s": "s",
  "overlay.line.width.m": "m",
  "overlay.line.width.l": "l",
  "overlay.line.width.xl": "xl",
};
/** The picker's columns: the same shape at two sizes. */
export const LINE_ENDPOINT_SIZES = [
  { size: "normal" },
  { size: "small" },
] as const;

export type LineEndpointSize = (typeof LINE_ENDPOINT_SIZES)[number]["size"];

/**
 * The picker's rows, in order. Derived from nothing else on purpose: the labels are editorial.
 *
 * A row is one shape and the sizes it can be drawn at, so the menu can be read as a grid — the
 * shapes down the side, the sizes across the top — instead of as fourteen names that only differ
 * by a suffix.
 */
export const LINE_ENDPOINT_SHAPES: Array<{
  values: Record<LineEndpointSize, OverlayArrowhead>;
}> = [
  { values: { normal: "arrow", small: "arrowSmall" } },
  { values: { normal: "triangle", small: "triangleSmall" } },
  { values: { normal: "openArrow", small: "openArrowSmall" } },
  { values: { normal: "thinArrow", small: "thinArrowSmall" } },
  { values: { normal: "diamond", small: "diamondSmall" } },
  { values: { normal: "dot", small: "dotSmall" } },
  { values: { normal: "bar", small: "barSmall" } },
];

/** The head drawn at no endpoint at all. It has no size, so it sits outside the grid. */
export const LINE_ENDPOINT_NONE: { value: OverlayArrowhead } = {
  value: "none",
};

/**
 * Every head with the name the picker gives it.
 *
 * Built from the grid so a label cannot drift between the menu and the command palette.
 * `features/rendering/adapters/arrowhead-parity.test.ts` pins that this covers `OVERLAY_ARROWHEADS`
 * exactly, so a head can neither hide from the menu nor appear in it without existing in the model.
 */
export const LINE_ENDPOINT_OPTIONS: Array<{
  value: OverlayArrowhead;
}> = [
  LINE_ENDPOINT_NONE,
  ...LINE_ENDPOINT_SHAPES.flatMap((shape) => LINE_ENDPOINT_SIZES.map(({ size }) => ({
    value: shape.values[size],
  }))),
];

/** Command id → head, for both endpoints. Derived from the menu so the two cannot drift. */
export const SHORTCUT_ARROWHEAD_VALUES: Record<string, OverlayArrowhead> = Object.fromEntries(
  (["start", "end"] as const).flatMap((endpoint) => LINE_ENDPOINT_OPTIONS.map((option) => (
    [`overlay.arrowhead.${endpoint}.${option.value}`, option.value] as const
  ))),
);

export const EMPTY_OVERLAY_SELECTION: OverlaySelectionSummary = {
  selectedCount: 0,
  selectedShapeIds: [],
  selectedShapes: [],
  selectedAssets: {},
  locked: false,
  hidden: false,
  grouped: false,
  canAlign: false,
  canDistribute: false,
  canStyleStroke: false,
  canStyleFill: false,
  canStyleLine: false,
  canStyleLineEndpoints: false,
  arrowheadStart: null,
  arrowheadEnd: null,
  fill: { kind: "unavailable" },
};
