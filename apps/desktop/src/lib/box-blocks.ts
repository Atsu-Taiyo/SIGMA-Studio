import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
import { createId } from "@/lib/id";
import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";
import {
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  resolveDocumentFontFamily,
  type BoxBlockNode,
  type BoxDecorationSpec,
  type BoxFrameSpec,
  type InlineNode,
  type RichBlock,
  type SigmaBlock,
} from "@/features/document";
import { isSafeCssDeclarationValue } from "@/features/document/css-safety";

const MINCHO_FONT_STACK = DEFAULT_SERIF_BODY_FONT_FAMILY;
const DEFAULT_CORNERBOX_TITLE_FONT_SIZE_PX = 32;
const DEFAULT_CORNERBOX_BODY_FONT_SIZE_PX = 21;
const DEFAULT_NOTEBOOK_FRAME_HEIGHT_PX = 57.35;
const DEFAULT_NOTEBOOK_RING_COUNT = 1;
export const CORNERBOX_FOLD_MIN_SIZE_PX = 9;
export const CORNERBOX_FOLD_MAX_SIZE_PX = 18;
export const CORNERBOX_FOLD_HEIGHT_RATIO = 0.15;
const CORNERBOX_FRAME_INSET_RATIO = 0.62;
const CORNERBOX_CORNER_SIZE_RATIO = 0.6;
const CORNERBOX_CORNER_OUTSET_RATIO = 0.25;
const CORNERBOX_CORNER_MIN_SIZE_PX = 4;
const CORNERBOX_CORNER_MAX_SIZE_PX = 8;

const BOX_DECORATION_RENDER_CLASSES: Partial<Record<BoxDecorationSpec["type"], string>> = {
  cornerSquares: "box-frame--corner-squares",
  doubleRule: "box-frame--double-rule",
  titleDoubleRule: "box-frame--title-double-rule",
  titleBand: "box-frame--title-band",
  titleTab: "box-frame--title-tab",
  titlePlate: "box-frame--title-plate",
  leftBar: "box-frame--left-bar",
  shadow: "box-frame--shadow",
  horizontalRules: "box-frame--horizontal-rules",
  notebookRules: "box-frame--notebook-rules",
};

const BOX_DECORATION_DATA_ATTRIBUTES: Partial<Record<BoxDecorationSpec["type"], string>> = {
  cornerSquares: "data-box-corner-squares",
  doubleRule: "data-box-double-rule",
  titleDoubleRule: "data-box-title-double-rule",
  titleBand: "data-box-title-band",
  titleTab: "data-box-title-tab",
  titlePlate: "data-box-title-plate",
  leftBar: "data-box-left-bar",
  shadow: "data-box-shadow",
  horizontalRules: "data-box-horizontal-rules",
  notebookRules: "data-box-notebook-rules",
};

export interface BoxStyleDefinition {
  id: string;
  commandName: string;
  displayName: string;

  frame: BoxFrameSpec;
}

const INK = "#1f2937";
const SOFT_BORDER = "#cbd5e1";
const BAND_FILL = "#e2e8f0";
const SHADE_FILL = "#f1f5f9";
const LEFTBAR_FILL = "#f8fafc";
const BAND_RULE = "#111111";
const TITLE_BAND_FILL = "#e5e7eb";
const DARK_BAND_FILL = "#1f2937";
const THEOREM_INK = "#1f3864";
const THEOREM_FILL = "#eef1f8";
const NOTEBOOK_FRAME = "#9ca3af";
const NOTEBOOK_BINDING = "#b9b3a1";
const NOTEBOOK_RING = "#706b5a";

export const BUILTIN_BOX_STYLES: BoxStyleDefinition[] = [
  {
    id: "fancybox",
    commandName: "fancybox",
    displayName: "fancybox",
    frame: {
      borderWidthPx: 1.4,
      borderColor: "#111111",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
    },
  },
  {
    id: "titlebox",
    commandName: "titlebox",
    displayName: "titlebox",
    frame: {
      borderWidthPx: 1.2,
      borderColor: "#111111",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: TITLE_BAND_FILL,
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 30, right: 14, bottom: 12, left: 14 },
      decorations: [{
        type: "titleBand",
        heightPx: 30,
        backgroundColor: TITLE_BAND_FILL,
        ruleWidthPx: 1.2,
        ruleColor: BAND_RULE,
      }],
    },
  },
  {
    id: "bandbox",
    commandName: "bandbox",
    displayName: "bandbox",
    frame: {
      borderWidthPx: 1.2,
      borderColor: "#111111",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: DARK_BAND_FILL,
      titleColor: "#ffffff",
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 30, right: 14, bottom: 12, left: 14 },
      decorations: [{ type: "titleBand", heightPx: 30, backgroundColor: DARK_BAND_FILL }],
    },
  },
  {
    id: "itembox",
    commandName: "itembox",
    displayName: "itembox",
    frame: {
      borderWidthPx: 1,
      borderColor: "#000000",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: "#ffffff",
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 16, right: 14, bottom: 12, left: 14 },
      decorations: [],
    },
  },
  {
    id: "theorembox",
    commandName: "theorembox",
    displayName: "theorembox",
    frame: {
      borderWidthPx: 0,
      borderColor: "transparent",
      borderStyle: "none",
      backgroundColor: THEOREM_FILL,
      titleColor: THEOREM_INK,
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 16, bottom: 12, left: 18 },
      decorations: [{ type: "leftBar", widthPx: 4, color: THEOREM_INK }],
    },
  },
  {
    id: "tabbox",
    commandName: "tabbox",
    displayName: "tabbox",
    frame: {
      borderWidthPx: 1.4,
      borderColor: THEOREM_INK,
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: THEOREM_INK,
      titleColor: "#ffffff",
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "round",
      radiusPx: 4,
      paddingPx: { top: 14, right: 16, bottom: 14, left: 16 },
      decorations: [{
        type: "titleTab",
        heightPx: 26,
        radiusPx: 4,
        offsetXPx: 0,
        paddingPx: { top: 0, right: 14, bottom: 0, left: 14 },
      }],
    },
  },
  {
    id: "tcolorbox",
    commandName: "tcolorbox",
    displayName: "tcolorbox",
    frame: {
      borderWidthPx: 1,
      borderColor: SOFT_BORDER,
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: BAND_FILL,
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 42, right: 14, bottom: 12, left: 14 },
      decorations: [{ type: "titleBand", heightPx: 32, backgroundColor: BAND_FILL }],
    },
  },
  {
    id: "tcolorbox-note",
    commandName: "tcolorbox-note",
    displayName: "tcolorbox-note",
    frame: {
      borderWidthPx: 1,
      borderColor: NOTEBOOK_FRAME,
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      bodyAlign: "justify",
      bodyFontSizePx: 15,
      bodyLineHeight: "23.35px",
      cornerStyle: "sharp",
      paddingPx: { top: 18, right: 18, bottom: 16, left: 56 },
      decorations: [{
        type: "notebookRules",
        baseBodyWidthPx: 660,
        frameLeftPx: 20,
        frameHeightPx: DEFAULT_NOTEBOOK_FRAME_HEIGHT_PX,
        frameStrokeOpacity: 0.85,
        bindingColor: NOTEBOOK_BINDING,
        bindingWidthPx: 1,
        bindingXPx: 20,
        bindingStrokeOpacity: 0.75,
        ringColor: NOTEBOOK_RING,
        ringWidthPx: 38,
        ringHeightPx: 12,
        ringStrokePx: 1.2,
        ringGapPx: 23.35,
        ringTopPx: 8,
        ringCount: DEFAULT_NOTEBOOK_RING_COUNT,
        ringLeftOverhangPx: 14,
        minHeightPx: DEFAULT_NOTEBOOK_FRAME_HEIGHT_PX,
      }],
    },
  },
  {
    id: "doublebox",
    commandName: "doublebox",
    displayName: "doublebox",
    frame: {
      borderWidthPx: 1.1,
      borderColor: "#111111",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      cornerStyle: "sharp",
      paddingPx: { top: 14, right: 16, bottom: 14, left: 16 },
      decorations: [{ type: "doubleRule", offsetPx: 4, widthPx: 1, color: "#111111" }],
    },
  },
  {
    id: "shadebox",
    commandName: "shadebox",
    displayName: "shadebox",
    frame: {
      borderWidthPx: 1,
      borderColor: "#000000",
      borderStyle: "solid",
      backgroundColor: SHADE_FILL,
      cornerStyle: "round",
      radiusPx: 3,
      paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
    },
  },
  {
    id: "leftbar",
    commandName: "leftbar",
    displayName: "leftbar",
    frame: {
      borderWidthPx: 1,
      borderColor: "#000000",
      borderStyle: "solid",
      backgroundColor: LEFTBAR_FILL,
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 14, bottom: 12, left: 18 },
      decorations: [{ type: "leftBar", widthPx: 5, color: INK }],
    },
  },
  {
    id: "dashedbox",
    commandName: "dashedbox",
    displayName: "dashedbox",
    frame: {
      borderWidthPx: 1.2,
      borderColor: "#475569",
      borderStyle: "dashed",
      backgroundColor: "#ffffff",
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
    },
  },
  {
    id: "ruledbox",
    commandName: "ruledbox",
    displayName: "ruledbox",
    frame: {
      borderWidthPx: 0,
      borderColor: "transparent",
      borderStyle: "none",
      backgroundColor: "#ffffff",
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 0, bottom: 12, left: 0 },
      decorations: [{ type: "horizontalRules", widthPx: 1.2, color: INK }],
    },
  },
  {
    id: "screenbox",
    commandName: "screenbox",
    displayName: "screenbox",
    frame: {
      borderWidthPx: 1,
      borderColor: "#000000",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      titleBackgroundColor: "#ffffff",
      titleAlign: "left",
      titleFontWeight: "bold",
      cornerStyle: "round",
      radiusPx: 3,
      paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
      decorations: [],
    },
  },
  {
    id: "ovalbox",
    commandName: "ovalbox",
    displayName: "ovalbox",
    frame: {
      borderWidthPx: 1.2,
      borderColor: INK,
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      cornerStyle: "round",
      radiusPx: 18,
      paddingPx: { top: 8, right: 16, bottom: 8, left: 16 },
    },
  },
  {
    id: "cornerbox",
    commandName: "cornerbox",
    displayName: "cornerbox",
    frame: {
      borderWidthPx: 0,
      borderColor: "transparent",
      borderStyle: "none",
      backgroundColor: "#ffffff",
      titleAlign: "left",
      titleFontFamily: MINCHO_FONT_STACK,
      titleFontWeight: "normal",
      titleLineHeight: "1",
      bodyAlign: "left",
      bodyFontFamily: MINCHO_FONT_STACK,
      bodyLineHeight: "1",
      cornerStyle: "sharp",
      paddingPx: { top: 24, right: 24, bottom: 24, left: 24 },
      decorations: [
        { type: "titleDoubleRule", ruleWidthPx: 1, ruleColor: "#111111", guideColor: "#b8b8b8" },
        { type: "cornerSquares", sizePx: 8, color: "#000000" },
      ],
    },
  },
];

export interface CreateBoxBlockOptions {
  id?: string;
  bodyId?: string;
  bodyText?: string;
}

/**
 * 箱を作る。既定タイトル (「ポイント」「定理」など) は**文書に焼き込まれる**ので、
 * 作った時点の UI 言語で解決する (あとから言語を変えても中身は変わらない = D3)。
 * `t` の既定が日本語なのは、既存の呼び出しとテストを無傷にするため。
 */
export function createBoxBlock(
  styleId = "fancybox",
  titleText = "",
  options: CreateBoxBlockOptions = {},
  t: Translate<"editor"> = createTranslator(DEFAULT_LOCALE, "editor"),
): BoxBlockNode {
  const style = getBoxStyleDefinition(styleId) ?? BUILTIN_BOX_STYLES[0];
  const title = titleText.trim() || t(`box.defaultTitle.${style.id}` as never, { defaultValue: "" }) as string;
  return {
    type: "boxBlock",
    id: options.id ?? createId("box"),
    styleId: style.id,
    ...(title ? { title: [{ type: "text", text: title }] } : {}),
    frame: style.frame,
    blocks: [createBoxBodyParagraph(options.bodyText ?? "", options.bodyId)],
  };
}

export function createBoxBodyParagraph(text = "", id = createId("p")): RichBlock {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

/** 表示用に文言を解決した箱スタイル。UI と `/` コマンドだけが受け取る。 */
export interface ResolvedBoxStyle extends BoxStyleDefinition {
  description: string;
  /** `/` コマンドの検索別名。表示はしない。 */
  aliases: string[];
}

export function resolveBoxStyles(
  t: Translate<"editor">,
  styles: readonly BoxStyleDefinition[] = BUILTIN_BOX_STYLES,
): ResolvedBoxStyle[] {
  return styles.map((style) => ({
    ...style,
    // 表示名は原則 TeX のコマンド名そのもの (訳さない)。飾りの付く一部だけ
    // 辞書に上書きを置ける。
    displayName: (t(`box.displayName.${style.id}` as never, { defaultValue: "" }) as string) || style.displayName,
    description: t(`box.description.${style.id}` as never) as string,
    aliases: (t(`box.aliases.${style.id}` as never, { defaultValue: "" }) as string)
      .split(" ")
      .filter(Boolean),
  }));
}

export function getBoxStyleDefinition(styleId: string): BoxStyleDefinition | undefined {
  return BUILTIN_BOX_STYLES.find((style) => style.id === styleId || style.commandName === styleId);
}

export function resolveBoxFrame(block: Pick<BoxBlockNode, "styleId" | "frame">): BoxFrameSpec {
  const frame = mergeBoxFrame(getBoxStyleDefinition(block.styleId)?.frame, block.frame);
  return block.styleId === "cornerbox" ? withoutDefaultCornerboxTextSizes(frame) : frame;
}

export function setBoxStyle<T extends SigmaBlock | RichBlock>(block: T, styleId: string): T {
  if (block.type !== "boxBlock") {
    return block;
  }
  const style = getBoxStyleDefinition(styleId) ?? BUILTIN_BOX_STYLES[0];
  return {
    ...block,
    styleId: style.id,
    frame: style.frame,
  } as T;
}

export function setBoxTitle<T extends SigmaBlock | RichBlock>(block: T, titleText: string): T {
  if (block.type !== "boxBlock") {
    return block;
  }
  const title = inlineTitleFromText(titleText);
  return {
    ...block,
    ...(title ? { title } : { title: undefined }),
  } as T;
}

export function patchBoxFrame<T extends SigmaBlock | RichBlock>(block: T, framePatch: Partial<BoxFrameSpec>): T {
  if (block.type !== "boxBlock") {
    return block;
  }
  return {
    ...block,
    frame: mergeBoxFrame(block.frame, framePatch),
  } as T;
}

function withoutDefaultCornerboxTextSizes(frame: BoxFrameSpec): BoxFrameSpec {
  const { titleFontSizePx, bodyFontSizePx, ...rest } = frame;
  return {
    ...rest,
    ...(titleFontSizePx === undefined || titleFontSizePx === DEFAULT_CORNERBOX_TITLE_FONT_SIZE_PX ? {} : { titleFontSizePx }),
    ...(bodyFontSizePx === undefined || bodyFontSizePx === DEFAULT_CORNERBOX_BODY_FONT_SIZE_PX ? {} : { bodyFontSizePx }),
  };
}

export function boxBlockTitleText(block: Pick<BoxBlockNode, "title">): string {
  return block.title ? inlineNodesToPlainText(block.title).trim() : "";
}

const DEFAULT_BOX_BODY_LINE_HEIGHT_PX = 22;

function parseBoxBodyLineHeightPx(frame: Pick<BoxFrameSpec, "bodyLineHeight" | "bodyFontSizePx">): number {
  const raw = frame.bodyLineHeight;
  if (raw) {
    const pxMatch = /(-?\d*\.?\d+)\s*px/.exec(raw);
    if (pxMatch) {
      return Math.max(12, Number.parseFloat(pxMatch[1] ?? "") || DEFAULT_BOX_BODY_LINE_HEIGHT_PX);
    }
    const numeric = Number.parseFloat(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.max(12, numeric * (frame.bodyFontSizePx ?? 15));
    }
  }
  return frame.bodyFontSizePx ? Math.max(12, frame.bodyFontSizePx * 1.45) : DEFAULT_BOX_BODY_LINE_HEIGHT_PX;
}

/**
 * The minimum height a box's first fragment needs before it is worth starting the
 * box on the current page/column. When less room than this remains, the box is
 * pushed to the next page/column and flows from there. This mirrors how body text
 * behaves: it keeps filling the current page until only a sliver of space is left.
 * Room for the top chrome plus roughly two body lines reads as "started cleanly".
 */
export function boxFragmentMinStartHeightPx(frame: BoxFrameSpec, hasTitle: boolean): number {
  const padding = frame.paddingPx ?? { top: 12, right: 14, bottom: 12, left: 14 };
  const lineHeight = parseBoxBodyLineHeightPx(frame);
  const titleHeight = hasTitle ? 24 : 0;
  return Math.round(padding.top + titleHeight + lineHeight * 2);
}

export function findBoxDecoration<T extends BoxDecorationSpec["type"]>(
  frame: Pick<BoxFrameSpec, "decorations"> | undefined,
  type: T,
): Extract<BoxDecorationSpec, { type: T }> | undefined {
  return frame?.decorations?.find((decoration): decoration is Extract<BoxDecorationSpec, { type: T }> => decoration.type === type);
}

export function hasBoxDecoration(frame: Pick<BoxFrameSpec, "decorations"> | undefined, type: BoxDecorationSpec["type"]): boolean {
  return frame?.decorations?.some((decoration) => decoration.type === type) ?? false;
}

export function boxFrameClassName(baseClass: string, frame: BoxFrameSpec, styleId?: string): string {
  const classes = [baseClass, "box-frame"];
  for (const decoration of frame.decorations ?? []) {
    const renderClass = BOX_DECORATION_RENDER_CLASSES[decoration.type];
    if (renderClass) {
      classes.push(renderClass);
    }
  }
  if (isCornerBoxFrame(styleId, frame)) {
    classes.push("box-frame--corner", "corner-frame");
  }
  if (styleId === "itembox" && !hasBoxDecoration(frame, "titlePlate")) {
    classes.push("box-frame--title-plate");
  }
  classes.push(`box-frame--title-position-${frame.titlePosition ?? "l"}`);
  return classes.join(" ");
}

export function boxFrameDecorationAttributes(frame: Pick<BoxFrameSpec, "decorations"> | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const decoration of frame?.decorations ?? []) {
    const attribute = BOX_DECORATION_DATA_ATTRIBUTES[decoration.type];
    if (attribute) {
      attributes[attribute] = "true";
    }
  }
  return attributes;
}

export function boxFrameStyleVars(frame: BoxFrameSpec): Record<string, string> {
  const padding = frame.paddingPx ?? { top: 12, right: 14, bottom: 12, left: 14 };
  const cornerSquares = findBoxDecoration(frame, "cornerSquares");
  const doubleRule = findBoxDecoration(frame, "doubleRule");
  const titleDoubleRule = findBoxDecoration(frame, "titleDoubleRule");
  const titleBand = findBoxDecoration(frame, "titleBand");
  const titleTab = findBoxDecoration(frame, "titleTab");
  const titlePlate = findBoxDecoration(frame, "titlePlate");
  const leftBar = findBoxDecoration(frame, "leftBar");
  const shadow = findBoxDecoration(frame, "shadow");
  const horizontalRules = findBoxDecoration(frame, "horizontalRules");
  const notebookRules = findBoxDecoration(frame, "notebookRules");
  const titlePlatePadding = titlePlate?.paddingPx ?? { top: 2, right: 10, bottom: 2, left: 10 };
  const titleTabPadding = titleTab?.paddingPx ?? { top: 0, right: 12, bottom: 0, left: 12 };
  const notebookFrameHeight = notebookRules?.frameHeightPx ?? notebookRules?.minHeightPx ?? DEFAULT_NOTEBOOK_FRAME_HEIGHT_PX;
  const notebookRingLeftOverhang = notebookRules?.ringLeftOverhangPx ?? 14;
  const titlePosition = frame.titlePosition ?? "l";
  const titlePositionAlign = titlePosition === "c" ? "center" : titlePosition === "r" ? "right" : "left";
  const titleFontFamily = resolveDocumentFontFamily(frame.titleFontFamily);
  const bodyFontFamily = resolveDocumentFontFamily(frame.bodyFontFamily);

  return {
    "--sigma-doc-box-border-width": `${frame.borderWidthPx ?? 1.2}px`,
    "--sigma-doc-box-border-color": frame.borderColor ?? "#111111",
    "--sigma-doc-box-border-style": frame.borderStyle ?? "solid",
    "--sigma-doc-box-background": frame.backgroundColor ?? "#ffffff",
    "--sigma-doc-box-title-background": frame.titleBackgroundColor ?? titleBand?.backgroundColor ?? titleTab?.backgroundColor ?? frame.backgroundColor ?? "#ffffff",
    ...(frame.titleColor ? { "--sigma-doc-box-title-color": frame.titleColor } : {}),
    "--sigma-doc-box-title-align": frame.titlePosition ? titlePositionAlign : frame.titleAlign ?? titlePositionAlign,
    ...(frame.titleFontWeight ? { "--sigma-doc-box-title-weight": frame.titleFontWeight === "bold" ? "700" : "400" } : {}),
    ...(titleFontFamily ? { "--sigma-doc-box-title-font-family": titleFontFamily } : {}),
    ...(frame.titleFontSizePx ? { "--sigma-doc-box-title-font-size": `${frame.titleFontSizePx}px` } : {}),
    ...(frame.titleLineHeight ? { "--sigma-doc-box-title-line-height": frame.titleLineHeight } : {}),
    ...(frame.bodyColor ? { "--sigma-doc-box-body-color": frame.bodyColor } : {}),
    ...(frame.bodyAlign ? { "--sigma-doc-box-body-align": frame.bodyAlign } : {}),
    ...(bodyFontFamily ? { "--sigma-doc-box-body-font-family": bodyFontFamily } : {}),
    ...(frame.bodyFontSizePx ? { "--sigma-doc-box-body-font-size": `${frame.bodyFontSizePx}px` } : {}),
    ...(frame.bodyLineHeight ? { "--sigma-doc-box-body-line-height": frame.bodyLineHeight } : {}),
    "--sigma-doc-box-radius": `${frame.cornerStyle === "round" ? frame.radiusPx ?? 8 : 0}px`,
    "--sigma-doc-box-padding-top": `${padding.top}px`,
    "--sigma-doc-box-padding-right": `${padding.right}px`,
    "--sigma-doc-box-padding-bottom": `${padding.bottom}px`,
    "--sigma-doc-box-padding-left": `${padding.left}px`,
    "--sigma-doc-box-corner-size": `${cornerSquares?.sizePx ?? 0}px`,
    "--sigma-doc-box-corner-color": cornerSquares?.color ?? "#000000",
    "--sigma-doc-box-double-offset": `${doubleRule?.offsetPx ?? 0}px`,
    "--sigma-doc-box-double-width": `${doubleRule?.widthPx ?? 1}px`,
    "--sigma-doc-box-double-color": doubleRule?.color ?? frame.borderColor ?? "#111111",
    "--sigma-doc-box-title-rule-width": `${titleDoubleRule?.ruleWidthPx ?? 1}px`,
    "--sigma-doc-box-title-rule-color": titleDoubleRule?.ruleColor ?? "#111111",
    "--sigma-doc-box-title-guide-color": titleDoubleRule?.guideColor ?? "#b8b8b8",
    "--sigma-doc-box-title-band-height": `${titleBand?.heightPx ?? 32}px`,
    "--sigma-doc-box-title-band-rule-width": `${titleBand?.ruleWidthPx ?? 0}px`,
    "--sigma-doc-box-title-band-rule-color": titleBand?.ruleColor ?? frame.borderColor ?? "#111111",
    "--sigma-doc-box-title-tab-height": `${titleTab?.heightPx ?? 26}px`,
    "--sigma-doc-box-title-tab-radius": `${titleTab?.radiusPx ?? 4}px`,
    "--sigma-doc-box-title-tab-offset-x": `${titleTab?.offsetXPx ?? 0}px`,
    "--sigma-doc-box-title-tab-padding-right": `${titleTabPadding.right}px`,
    "--sigma-doc-box-title-tab-padding-left": `${titleTabPadding.left}px`,
    "--sigma-doc-box-title-plate-border-color": titlePlate?.borderColor ?? frame.borderColor ?? "#111111",
    "--sigma-doc-box-title-plate-radius": `${titlePlate?.radiusPx ?? 3}px`,
    "--sigma-doc-box-title-plate-padding-top": `${titlePlatePadding.top}px`,
    "--sigma-doc-box-title-plate-padding-right": `${titlePlatePadding.right}px`,
    "--sigma-doc-box-title-plate-padding-bottom": `${titlePlatePadding.bottom}px`,
    "--sigma-doc-box-title-plate-padding-left": `${titlePlatePadding.left}px`,
    "--sigma-doc-box-left-bar-width": `${leftBar?.widthPx ?? 0}px`,
    "--sigma-doc-box-left-bar-color": leftBar?.color ?? "#111111",
    "--sigma-doc-box-shadow": shadow ? `${shadow.offsetXPx}px ${shadow.offsetYPx}px ${shadow.blurPx ?? 0}px ${shadow.spreadPx ?? 0}px ${shadow.color}` : "none",
    "--sigma-doc-box-horizontal-rule-width": `${horizontalRules?.widthPx ?? 1}px`,
    "--sigma-doc-box-horizontal-rule-color": horizontalRules?.color ?? frame.borderColor ?? "#111111",
    "--sigma-doc-box-notebook-base-body-width": `${notebookRules?.baseBodyWidthPx ?? 660}px`,
    "--sigma-doc-box-notebook-frame-left": `${notebookRules?.frameLeftPx ?? notebookRules?.bindingXPx ?? 20}px`,
    "--sigma-doc-box-notebook-frame-height": `${notebookFrameHeight}px`,
    "--sigma-doc-box-notebook-frame-border-color": colorWithOpacity(frame.borderColor ?? "#9ca3af", notebookRules?.frameStrokeOpacity),
    "--sigma-doc-box-notebook-binding-color": colorWithOpacity(notebookRules?.bindingColor ?? "#b9b3a1", notebookRules?.bindingStrokeOpacity),
    "--sigma-doc-box-notebook-binding-width": `${notebookRules?.bindingWidthPx ?? 1}px`,
    "--sigma-doc-box-notebook-binding-x": `${notebookRules?.bindingXPx ?? 20}px`,
    "--sigma-doc-box-notebook-ring-color": notebookRules?.ringColor ?? "#706b5a",
    "--sigma-doc-box-notebook-ring-width": `${notebookRules?.ringWidthPx ?? 38}px`,
    "--sigma-doc-box-notebook-ring-height": `${notebookRules?.ringHeightPx ?? 12}px`,
    "--sigma-doc-box-notebook-ring-left-overhang": `${notebookRingLeftOverhang}px`,
    "--sigma-doc-box-notebook-ring-stroke": `${notebookRules?.ringStrokePx ?? 1.2}px`,
    "--sigma-doc-box-notebook-ring-gap": `${notebookRules?.ringGapPx ?? 23.35}px`,
    "--sigma-doc-box-notebook-ring-top": `${notebookRules?.ringTopPx ?? 8}px`,
    "--sigma-doc-box-notebook-ring-count": String(notebookRules?.ringCount ?? DEFAULT_NOTEBOOK_RING_COUNT),
    "--sigma-doc-box-notebook-min-height": `${notebookRules?.minHeightPx ?? notebookFrameHeight}px`,
    "--sigma-doc-box-title-position": titlePosition,
  };
}

/**
 * ProseMirror assigns the returned string to `dom.style.cssText` (`BoxBlockExtension.renderHTML`),
 * which parses it as a whole declaration list — unlike React's `setProperty`, a `;` inside one of
 * these values really does start another declaration. Box frame fields are plain
 * `z.string().optional()` in the schema, so several of the values below come straight from the
 * document. Every value is a color or a length; none legitimately contains `;{}<>` or `url(`.
 */
export function boxFrameStyleAttribute(frame: BoxFrameSpec): string {
  return Object.entries(boxFrameStyleVars(frame))
    .filter(([, value]) => isSafeCssDeclarationValue(value))
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

export function cornerBoxFoldSizePx(referenceHeightPx: number): number {
  const referenceHeight = Number.isFinite(referenceHeightPx) ? Math.max(0, referenceHeightPx) : 0;
  return Math.min(
    CORNERBOX_FOLD_MAX_SIZE_PX,
    Math.max(CORNERBOX_FOLD_MIN_SIZE_PX, referenceHeight * CORNERBOX_FOLD_HEIGHT_RATIO),
  );
}

export function cornerBoxReferenceHeightStyleVars(referenceHeightPx: number | undefined): Record<string, string> {
  if (typeof referenceHeightPx !== "number" || !Number.isFinite(referenceHeightPx) || referenceHeightPx <= 0) {
    return {};
  }
  const referenceHeight = roundCssPx(referenceHeightPx);
  const foldSize = roundCssPx(cornerBoxFoldSizePx(referenceHeight));
  const cornerSize = roundCssPx(Math.min(
    CORNERBOX_CORNER_MAX_SIZE_PX,
    Math.max(CORNERBOX_CORNER_MIN_SIZE_PX, foldSize * CORNERBOX_CORNER_SIZE_RATIO),
  ));
  const frameInset = roundCssPx(Math.max(cornerSize, foldSize * CORNERBOX_FRAME_INSET_RATIO));
  const cornerOutset = roundCssPx(cornerSize * CORNERBOX_CORNER_OUTSET_RATIO);
  const cornerOffset = roundCssPx(Math.max(0, frameInset - cornerSize / 2 - cornerOutset));
  return {
    "--corner-frame-reference-height": `${referenceHeight}px`,
    "--corner-frame-fold-size": `${foldSize}px`,
    "--corner-frame-corner-size": `${cornerSize}px`,
    "--corner-frame-guide-inset-x": `${foldSize}px`,
    "--corner-frame-guide-side-y": `${foldSize}px`,
    "--corner-frame-rule-x": `${frameInset}px`,
    "--corner-frame-rule-side-x": `${frameInset}px`,
    "--corner-frame-rule-y": `${frameInset}px`,
    "--corner-frame-rule-side-y": `${frameInset}px`,
    "--corner-frame-corner-x": `${cornerOffset}px`,
    "--corner-frame-corner-y": `${cornerOffset}px`,
  };
}

export function applyCornerBoxReferenceHeightStyle(element: HTMLElement, referenceHeightPx = element.getBoundingClientRect().height): void {
  const vars = cornerBoxReferenceHeightStyleVars(referenceHeightPx);
  for (const [property, value] of Object.entries(vars)) {
    if (element.style.getPropertyValue(property) !== value) {
      element.style.setProperty(property, value);
    }
  }
}

export function observeCornerBoxReferenceHeights(root: ParentNode, selector: string): () => void {
  const observed = new Set<HTMLElement>();
  const rules = new Map<string, string>();
  const ownerDocument = root instanceof Document ? root : root.ownerDocument;
  if (!ownerDocument?.head) {
    return () => undefined;
  }
  const styleElement = ownerDocument.createElement("style");
  styleElement.setAttribute("data-cornerbox-reference-heights", "true");
  ownerDocument.head.appendChild(styleElement);
  const writeRules = () => {
    styleElement.textContent = Array.from(rules, ([targetSelector, declarations]) => `${targetSelector}{${declarations}}`).join("\n");
  };
  const updateRule = (element: HTMLElement) => {
    const targetSelector = cornerBoxReferenceSelector(element);
    if (!targetSelector) {
      return;
    }
    const declarations = Object.entries(cornerBoxReferenceHeightStyleVars(element.getBoundingClientRect().height))
      .map(([property, value]) => `${property}:${value}`)
      .join(";");
    if (!declarations || rules.get(targetSelector) === declarations) {
      return;
    }
    rules.set(targetSelector, declarations);
    writeRules();
  };
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target instanceof HTMLElement && entry.target.getAttribute("data-corner-reference-height") !== "explicit") {
            updateRule(entry.target);
          }
        }
      });

  const scan = () => {
    for (const element of Array.from(observed)) {
      if (!ownerDocument.contains(element)) {
        resizeObserver?.unobserve(element);
        observed.delete(element);
      }
    }

    root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      if (element.getAttribute("data-corner-reference-height") === "explicit" || observed.has(element)) {
        return;
      }
      observed.add(element);
      updateRule(element);
      resizeObserver?.observe(element);
    });
  };

  scan();
  const mutationObserver = typeof MutationObserver === "undefined"
    ? null
    : new MutationObserver(scan);
  mutationObserver?.observe(root, { childList: true, subtree: true });

  return () => {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    styleElement.remove();
    observed.clear();
    rules.clear();
  };
}

export function inlineTitleFromText(value: string): InlineNode[] | undefined {
  const text = value.trim();
  return text ? [{ type: "text", text }] : undefined;
}

function isCornerBoxFrame(styleId: string | undefined, frame: Pick<BoxFrameSpec, "decorations">): boolean {
  return styleId === "cornerbox" && hasBoxDecoration(frame, "titleDoubleRule");
}

/**
 * Does this frame's font actually reach the glyphs?
 *
 * The corner frame declares `font-family: inherit` on its title and body
 * (`document-surface.css`, specificity 0-2-0), which beats the
 * `--sigma-doc-box-*-font-family` custom properties the frame spec feeds in. So a cornerbox stores
 * 明朝 but draws the document default, and anything reporting "the font here" has to say so too —
 * the toolbar's caret-font display (`resolveEffectiveFontFamily`) reads this.
 *
 * **This is a claim about the stylesheet, so the two are pinned together.** `document-surface.test.ts`
 * ("cornerbox の font-family 打ち消しと boxFrameAppliesFontFamily は対で決まる") asserts both the CSS
 * rule and this predicate; `box-blocks.test.ts` covers the predicate on its own. Change the CSS and
 * this function has to change with it — either side moving alone turns one of those blocks red.
 */
export function boxFrameAppliesFontFamily(
  styleId: string | undefined,
  frame: Pick<BoxFrameSpec, "decorations">,
): boolean {
  return !isCornerBoxFrame(styleId, frame);
}

/**
 * 枠仕様を重ねる。`decorations` は**配列ごと**上書きする (片方だけ足すと、同じ種類の装飾が
 * 二重に載って描画が壊れる)。設定ダイアログの patch と、スタイルごとに覚えた既定の適用が
 * 同じ規約で動くよう、外へも出している。
 */
export function mergeBoxFrame(base: BoxFrameSpec | undefined, override: BoxFrameSpec | undefined): BoxFrameSpec {
  const paddingPx = override?.paddingPx
    ? { ...(base?.paddingPx ?? override.paddingPx), ...override.paddingPx }
    : base?.paddingPx;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
    ...(paddingPx ? { paddingPx } : {}),
    decorations: override?.decorations ?? base?.decorations,
  };
}

function colorWithOpacity(color: string, opacity: number | undefined): string {
  if (opacity === undefined) {
    return color;
  }
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  const rgb = hexToRgb(color);
  return rgb ? `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${normalizedOpacity})` : color;
}

function roundCssPx(value: number): number {
  return Math.round(value * 100) / 100;
}

function cornerBoxReferenceSelector(element: HTMLElement): string | null {
  const sigmaDocId = element.getAttribute("data-sigma-doc-id");
  if (sigmaDocId) {
    return `[data-sigma-doc-id="${escapeCssString(sigmaDocId)}"]`;
  }
  const sourceId = element.getAttribute("data-box-source-id");
  return sourceId ? `[data-box-source-id="${escapeCssString(sourceId)}"]` : null;
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = color.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(hex);
  if (shortMatch) {
    const value = shortMatch[1] ?? "";
    return {
      r: Number.parseInt(`${value[0]}${value[0]}`, 16),
      g: Number.parseInt(`${value[1]}${value[1]}`, 16),
      b: Number.parseInt(`${value[2]}${value[2]}`, 16),
    };
  }

  const longMatch = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!longMatch) {
    return null;
  }
  const value = longMatch[1] ?? "";
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}
