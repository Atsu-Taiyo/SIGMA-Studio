import { normalizeColumnRule, type ColumnRule } from "../model/column-rule";
import type {
  BoxBlockChildBlock,
  InlineNode,
  PageBackground,
  PageLayout,
  PageOrientation,
  PageOverlay,
  PageRunningRegion,
  PageSizePreset,
  ProblemAreaBlock,
  RichBlock,
  SigmaBlock,
  SigmaDocument,
} from "../model";
import { listItemContinuationInlineNodes, normalizeOrderedListMarkerStyle } from "../model/blocks";
import { blockSpaceAfterPx } from "./block-space-after";
import { normalizeOverlaySnapshot } from "../overlay-snapshot";
import { normalizeLineHeight } from "./line-height";
import type { SigmaValidationCode } from "../validation-error";

type PageRunningRegionInput = Partial<PageRunningRegion>;

export const MM_TO_PX = 96 / 25.4;

export const PAGE_SIZE_PRESETS_MM: Record<Exclude<PageSizePreset, "custom" | "whiteboard">, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  B5: { widthMm: 182, heightMm: 257 },
  B4: { widthMm: 257, heightMm: 364 },
} as const;

export const A4_PAGE_MM = PAGE_SIZE_PRESETS_MM.A4;

export const DEFAULT_PAGE_MARGINS_MM = {
  top: 18,
  right: 17,
  bottom: 18,
  left: 17,
} as const;

export const DEFAULT_PAGE_FLOW = {
  type: "columns",
  columnCount: 1,
  columnGapMm: 8,
} as const;

export const MIN_PAGE_BODY_HEIGHT_MM = 30;

export const DEFAULT_PAGE_HEADER: PageRunningRegion = {
  enabled: false,
  heightMm: 8,
  offsetMm: 5,
  showOnFirstPage: true,
  blocks: [{
    type: "paragraph",
    id: "page_header_running_body",
    children: [{ type: "text", text: "{title}" }],
  }],
} as const;

export const DEFAULT_PAGE_FOOTER: PageRunningRegion = {
  enabled: false,
  heightMm: 8,
  offsetMm: 5,
  showOnFirstPage: true,
  blocks: [{
    type: "paragraph",
    id: "page_footer_running_body",
    children: [{ type: "text", text: "{page}" }],
    align: "center",
  }],
} as const;

export const A4_PAGE_PX = {
  width: mmToPx(A4_PAGE_MM.widthMm),
  height: mmToPx(A4_PAGE_MM.heightMm),
} as const;

export const A4_CONTENT_PX = {
  width: mmToPx(A4_PAGE_MM.widthMm - DEFAULT_PAGE_MARGINS_MM.left - DEFAULT_PAGE_MARGINS_MM.right),
  height: mmToPx(A4_PAGE_MM.heightMm - DEFAULT_PAGE_MARGINS_MM.top - DEFAULT_PAGE_MARGINS_MM.bottom),
} as const;

/** Visual gap between page sheets in the continuous canvas (unzoomed px). Shared by editor + print so overlay slices align. */
export const PAGE_GAP_PX = 36;

export interface PageMetrics {
  page: {
    widthMm: number;
    heightMm: number;
    widthPx: number;
    heightPx: number;
  };
  margins: {
    topPx: number;
    rightPx: number;
    bottomPx: number;
    leftPx: number;
  };
  content: {
    widthMm: number;
    heightMm: number;
    widthPx: number;
    heightPx: number;
  };
  flow: {
    columnCount: number;
    columnGapMm: number;
    columnGapPx: number;
    columnRule?: ColumnRule;
    columnWidthMm: number;
    columnWidthPx: number;
  };
}

export type PageLayoutInput = Partial<Omit<PageLayout, "pageSize" | "marginsMm" | "flow" | "header" | "footer">> & {
  pageSize?: Partial<PageLayout["pageSize"]>;
  marginsMm?: Partial<PageLayout["marginsMm"]>;
  flow?: Partial<PageLayout["flow"]>;
  header?: PageRunningRegionInput;
  footer?: PageRunningRegionInput;
  overlay?: PageOverlay;
};

export interface PaginatedPage {
  id: string;
  number: number;
  blocks: SigmaBlock[];
  columns: PaginatedColumn[];
  estimatedContentHeightPx: number;
  oversizedBlockIds: string[];
}

export interface PaginatedColumn {
  id: string;
  number: number;
  blocks: SigmaBlock[];
  estimatedContentHeightPx: number;
  oversizedBlockIds: string[];
}

export function mmToPx(mm: number): number {
  return (mm * MM_TO_PX);
}

export function getPageSizeForPreset(
  preset: PageSizePreset,
  orientation: PageOrientation,
  customSize?: { widthMm?: number; heightMm?: number },
): { widthMm: number; heightMm: number } {
  if (preset === "custom" || preset === "whiteboard") {
    return {
      widthMm: positiveNumberOr(customSize?.widthMm, PAGE_SIZE_PRESETS_MM.A4.widthMm),
      heightMm: positiveNumberOr(customSize?.heightMm, PAGE_SIZE_PRESETS_MM.A4.heightMm),
    };
  }

  const base = PAGE_SIZE_PRESETS_MM[preset];

  if (orientation === "landscape") {
    return {
      widthMm: Math.max(base.widthMm, base.heightMm),
      heightMm: Math.min(base.widthMm, base.heightMm),
    };
  }

  return {
    widthMm: Math.min(base.widthMm, base.heightMm),
    heightMm: Math.max(base.widthMm, base.heightMm),
  };
}

const PAGE_BACKGROUNDS: readonly PageBackground[] = ["grid", "dots", "none"];

function normalizePageBackground(value: unknown): PageBackground | undefined {
  return PAGE_BACKGROUNDS.includes(value as PageBackground) ? value as PageBackground : undefined;
}

export function getDefaultPageLayout(preset: PageSizePreset = "A4"): PageLayout {
  const isWhiteboard = preset === "whiteboard";
  return {
    preset,
    orientation: "portrait",
    pageSize: getPageSizeForPreset(preset, "portrait"),
    marginsMm: isWhiteboard ? { top: 0, right: 0, bottom: 0, left: 0 } : { ...DEFAULT_PAGE_MARGINS_MM },
    flow: isWhiteboard ? { type: "columns", columnCount: 1, columnGapMm: 0 } : { ...DEFAULT_PAGE_FLOW },
    header: isWhiteboard ? undefined : clonePageRunningRegion(DEFAULT_PAGE_HEADER),
    footer: isWhiteboard ? undefined : clonePageRunningRegion(DEFAULT_PAGE_FOOTER),
    background: isWhiteboard ? "dots" : undefined,
  };
}

export function isWhiteboardPageLayout(layout: Pick<PageLayout, "preset"> | undefined): boolean {
  return layout?.preset === "whiteboard";
}

export function normalizePageLayout(input?: PageLayoutInput): PageLayout {
  const preset = isPageSizePreset(input?.preset) ? input.preset : "A4";
  const defaults = getDefaultPageLayout(preset);
  const orientation = isPageOrientation(input?.orientation) ? input.orientation : defaults.orientation;
  const customSize = preset === "custom" || preset === "whiteboard" ? input?.pageSize : undefined;
  const pageSize = getPageSizeForPreset(preset, orientation, customSize);
  const columnCount = clampInteger(input?.flow?.columnCount, 1, 4, defaults.flow.columnCount);
  const columnGapMm = nonnegativeNumberOr(input?.flow?.columnGapMm, defaults.flow.columnGapMm);

  if (preset === "whiteboard") {
    return {
      preset,
      orientation,
      pageSize,
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      overlay: normalizePageOverlay(input?.overlay),
      // 未知の値も、フィールドが無い既存の教材も「点」に倒す (現状の見た目を維持する)。
      background: normalizePageBackground(input?.background) ?? "dots",
    };
  }

  return {
    preset,
    orientation,
    pageSize,
    marginsMm: {
      top: nonnegativeNumberOr(input?.marginsMm?.top, defaults.marginsMm.top),
      right: nonnegativeNumberOr(input?.marginsMm?.right, defaults.marginsMm.right),
      bottom: nonnegativeNumberOr(input?.marginsMm?.bottom, defaults.marginsMm.bottom),
      left: nonnegativeNumberOr(input?.marginsMm?.left, defaults.marginsMm.left),
    },
    flow: {
      type: "columns",
      columnCount,
      columnGapMm,
      ...(normalizeColumnRule(input?.flow?.columnRule) ? { columnRule: normalizeColumnRule(input?.flow?.columnRule) } : {}),
    },
    header: normalizePageRunningRegion(input?.header, DEFAULT_PAGE_HEADER),
    footer: normalizePageRunningRegion(input?.footer, DEFAULT_PAGE_FOOTER),
    overlay: normalizePageOverlay(input?.overlay),
    // 用紙プリセットでも落とさない。印刷の切り出しは preset:"custom" の紙を返すので、
    // ここで捨てると画面で選んだ背景が印刷経路の再正規化で消える。
    background: normalizePageBackground(input?.background),
  };
}

export function ensurePageLayout(document: SigmaDocument): SigmaDocument {
  const pageLayout = expandMarginsForRunningRegions(normalizePageLayout(document.pageLayout));
  return {
    ...document,
    version: "2.0",
    content: document.content,
    pageLayout,
  };
}

export function getPageMetrics(layout: PageLayout = getDefaultPageLayout()): PageMetrics {
  const normalized = normalizePageLayout(layout);
  const contentWidthMm = Math.max(0, normalized.pageSize.widthMm - normalized.marginsMm.left - normalized.marginsMm.right);
  const contentHeightMm = Math.max(0, normalized.pageSize.heightMm - normalized.marginsMm.top - normalized.marginsMm.bottom);
  const totalGapMm = normalized.flow.columnGapMm * Math.max(0, normalized.flow.columnCount - 1);
  const columnWidthMm = normalized.flow.columnCount > 0
    ? Math.max(0, (contentWidthMm - totalGapMm) / normalized.flow.columnCount)
    : contentWidthMm;

  return {
    page: {
      widthMm: normalized.pageSize.widthMm,
      heightMm: normalized.pageSize.heightMm,
      widthPx: mmToPx(normalized.pageSize.widthMm),
      heightPx: mmToPx(normalized.pageSize.heightMm),
    },
    margins: {
      topPx: mmToPx(normalized.marginsMm.top),
      rightPx: mmToPx(normalized.marginsMm.right),
      bottomPx: mmToPx(normalized.marginsMm.bottom),
      leftPx: mmToPx(normalized.marginsMm.left),
    },
    content: {
      widthMm: contentWidthMm,
      heightMm: contentHeightMm,
      widthPx: mmToPx(contentWidthMm),
      heightPx: mmToPx(contentHeightMm),
    },
    flow: {
      columnCount: normalized.flow.columnCount,
      columnGapMm: normalized.flow.columnGapMm,
      columnGapPx: mmToPx(normalized.flow.columnGapMm),
      ...(normalized.flow.columnRule ? { columnRule: normalized.flow.columnRule } : {}),
      columnWidthMm,
      columnWidthPx: mmToPx(columnWidthMm),
    },
  };
}

export function expandMarginsForRunningRegions(layout: PageLayout): PageLayout {
  const normalized = normalizePageLayout(layout);
  if (isWhiteboardPageLayout(normalized)) {
    return normalized;
  }
  const marginsMm = { ...normalized.marginsMm };

  if (normalized.header?.enabled) {
    marginsMm.top = Math.max(
      marginsMm.top,
      normalized.header.offsetMm + normalized.header.heightMm,
    );
  }

  if (normalized.footer?.enabled) {
    marginsMm.bottom = Math.max(
      marginsMm.bottom,
      normalized.footer.offsetMm + normalized.footer.heightMm,
    );
  }

  return {
    ...normalized,
    marginsMm,
  };
}

/**
 * 用紙設定の検証結果。**文言ではなくコードで返す** (表示は `shape.validation.<code>`)。
 * `features/document` は最下層で、表示のための文字列を抱えない。
 */
export function getPageLayoutIssues(layout: PageLayout): SigmaValidationCode[] {
  const issues: SigmaValidationCode[] = [];

  if (
    !Number.isFinite(layout.pageSize.widthMm) ||
    !Number.isFinite(layout.pageSize.heightMm) ||
    layout.pageSize.widthMm <= 0 ||
    layout.pageSize.heightMm <= 0
  ) {
    issues.push("pageSizeRange");
  }

  if (isWhiteboardPageLayout(layout)) {
    return issues;
  }

  const metrics = getPageMetrics(layout);

  if (
    !Number.isFinite(layout.marginsMm.top) ||
    !Number.isFinite(layout.marginsMm.right) ||
    !Number.isFinite(layout.marginsMm.bottom) ||
    !Number.isFinite(layout.marginsMm.left) ||
    layout.marginsMm.top < 0 ||
    layout.marginsMm.right < 0 ||
    layout.marginsMm.bottom < 0 ||
    layout.marginsMm.left < 0
  ) {
    issues.push("pageMarginRange");
  }

  if (layout.marginsMm.left + layout.marginsMm.right >= layout.pageSize.widthMm) {
    issues.push("pageMarginTooWide");
  }

  if (layout.marginsMm.top + layout.marginsMm.bottom > layout.pageSize.heightMm - MIN_PAGE_BODY_HEIGHT_MM) {
    issues.push("pageMarginTooTall");
  }

  if (!Number.isInteger(layout.flow.columnCount) || layout.flow.columnCount < 1 || layout.flow.columnCount > 4) {
    issues.push("pageColumnCountRange");
  }

  if (!Number.isFinite(layout.flow.columnGapMm) || layout.flow.columnGapMm < 0) {
    issues.push("pageColumnGapRange");
  }

  if (layout.flow.columnGapMm * Math.max(0, layout.flow.columnCount - 1) >= metrics.content.widthMm) {
    issues.push("pageColumnGapTooWide");
  }

  return issues;
}

export function pageRunningRegionHasContent(region: PageRunningRegion | undefined): boolean {
  return Boolean(
    region?.blocks.some(richBlockHasContent) ||
    pageOverlayHasContent(region?.overlay),
  );
}

export function paginateBlocks(content: SigmaBlock[], layout: PageLayout = getDefaultPageLayout()): PaginatedPage[] {
  return paginateBlocksIntoColumns(content, layout);
}

export function paginateBlocksIntoColumns(content: SigmaBlock[], layout: PageLayout = getDefaultPageLayout()): PaginatedPage[] {
  const metrics = getPageMetrics(layout);
  const columnCount = metrics.flow.columnCount;
  const columnHeightPx = metrics.content.heightPx;
  const charsPerLine = Math.max(16, Math.round(metrics.flow.columnWidthPx / 12.3));
  const pages: PaginatedPage[] = [];
  let columns = createEmptyColumns(columnCount);
  let columnIndex = 0;
  let pageNumber = 1;

  const currentColumn = () => columns[columnIndex];
  const pageHasContent = () => columns.some((column) => column.blocks.length > 0);

  const flushPage = (force = false) => {
    if (!force && !pageHasContent()) {
      return;
    }

    const blocks = columns.flatMap((column) => column.blocks);
    pages.push({
      id: `page_${pageNumber}`,
      number: pageNumber,
      blocks,
      columns,
      estimatedContentHeightPx: columns.reduce((height, column) => height + column.estimatedContentHeightPx, 0),
      oversizedBlockIds: columns.flatMap((column) => column.oversizedBlockIds),
    });
    pageNumber += 1;
    columns = createEmptyColumns(columnCount);
    columnIndex = 0;
  };

  const advanceColumn = () => {
    if (columnIndex < columnCount - 1) {
      columnIndex += 1;
      return;
    }

    flushPage();
  };

  const advanceForExplicitBreak = () => {
    advanceColumn();
  };

  for (const block of content) {
    const blockHeight = estimateBlockHeightPx(block, charsPerLine);
    const shouldBreakBefore =
      pageHasContent() &&
      block.pagination?.break === true;

    if (shouldBreakBefore) {
      advanceForExplicitBreak();
    }

    if (
      currentColumn().blocks.length > 0 &&
      currentColumn().estimatedContentHeightPx + blockHeight > columnHeightPx
    ) {
      advanceColumn();
    }

    const targetColumn = currentColumn();
    targetColumn.blocks.push(block);
    targetColumn.estimatedContentHeightPx += blockHeight;
    if (blockHeight > columnHeightPx) {
      targetColumn.oversizedBlockIds.push(block.id);
    }

  }

  flushPage();

  if (pages.length === 0) {
    pages.push({
      id: "page_1",
      number: 1,
      blocks: [],
      columns: createEmptyColumns(columnCount),
      estimatedContentHeightPx: 0,
      oversizedBlockIds: [],
    });
  }

  return pages;
}

function createEmptyColumns(columnCount: number): PaginatedColumn[] {
  return Array.from({ length: Math.max(1, columnCount) }, (_, index) => ({
    id: `column_${index + 1}`,
    number: index + 1,
    blocks: [],
    estimatedContentHeightPx: 0,
    oversizedBlockIds: [],
  }));
}

/**
 * DOM を持たない経路 (AI 挿入位置の推定・サムネイル・印刷の推定フォールバック) の高さ推定。
 *
 * 実測は `getBoundingClientRect` なのでブロック下余白 (`spaceAfterPx` = padding) を含む。
 * 推定側でも足さないと、余白付きの段落が並ぶほど推定が実測より短くなる。
 * 下余白を描かない種別は 0 なので、触っていない文書の推定は 1px も変わらない。
 */
export function estimateBlockHeightPx(block: SigmaBlock | ProblemAreaBlock, charsPerLine = 54): number {
  return estimateBlockContentHeightPx(block, charsPerLine) + blockSpaceAfterPx(block);
}

function estimateBlockContentHeightPx(block: SigmaBlock | ProblemAreaBlock, charsPerLine: number): number {
  if (block.type === "section") {
    return 64;
  }

  if (block.type === "heading") {
    return 48 + Math.max(0, block.level - 1) * 4 + estimateInlineLines(block.children, charsPerLine) * 10;
  }

  if (block.type === "paragraph") {
    return 18 + estimateInlineLines(block.children, charsPerLine) * lineHeightPx(block.lineHeight);
  }

  if (block.type === "list") {
    return 12 + estimateListHeightPx(block, charsPerLine);
  }

  // 区切り線。`document-surface.css` の margin 10px × 2 + 罫線 1px。
  if (block.type === "divider") {
    return 21;
  }

  // コードは 1 ブロックに全行が入る。`.print-code` の縦 padding 8px × 2 + 枠線 1px × 2 +
  // margin 6px × 2 に、行数ぶんの行送り (line-height 1.6) を足す。
  if (block.type === "codeBlock") {
    return 30 + estimateInlineLines(block.children, charsPerLine) * 19;
  }

  // 引用は入れ物。中身の高さに縦 padding 2px × 2 + margin 6px × 2 を足す。
  if (block.type === "quote") {
    return 16 + block.blocks.reduce(
      (height, child) => height + estimateBlockHeightPx(child, Math.max(12, charsPerLine - 3)),
      0,
    );
  }

  if (block.type === "boxBlock") {
    const padding = block.frame?.paddingPx;
    const verticalPadding = (padding?.top ?? 12) + (padding?.bottom ?? 12);
    return verticalPadding
      + estimateBoxBlockTitleHeightPx(block, charsPerLine)
      + Math.max(24, sumBoxBlockChildHeights(block.blocks, boxBlockChildCharsPerLine(charsPerLine)));
  }

  if (block.type === "layoutSection") {
    const columnCount = Number.isInteger(block.layout.columnCount)
      ? Math.min(4, Math.max(1, block.layout.columnCount))
      : 2;
    const columnCharsPerLine = Math.max(12, Math.floor(charsPerLine / columnCount));
    const childHeight = block.children.reduce((height, child) => height + estimateBlockHeightPx(child, columnCharsPerLine), 0);
    return Math.max(32, Math.ceil(childHeight / columnCount));
  }

  if (block.type === "problem") {
    return PROBLEM_AREA_ORDER.reduce(
      (height, area) => height + estimateProblemAreaHeightPx(block, area, charsPerLine),
      0,
    );
  }

  return 48;
}

/** 枠ブロックのタイトル行が占める推定高さ (タイトル無しは 0)。 */
export function estimateBoxBlockTitleHeightPx(
  block: Extract<SigmaBlock, { type: "boxBlock" }>,
  charsPerLine: number,
): number {
  return block.title && block.title.length > 0
    ? estimateInlineLines(block.title, charsPerLine) * 18
    : 0;
}

/** 枠ブロックの子ブロックに適用する1行あたり文字数。 */
export function boxBlockChildCharsPerLine(charsPerLine: number): number {
  return Math.max(12, charsPerLine - 4);
}

/** 問題ブロック内でエリアが積まれる順序 (高さ推定・矩形推定で共有する)。 */
export const PROBLEM_AREA_ORDER = ["lead", "prompt", "solution", "hints"] as const;

export type ProblemAreaName = typeof PROBLEM_AREA_ORDER[number];

/** 問題エリア1つ分の推定高さ。中身の合計と `areaLayout` の最小高さの大きい方。 */
export function estimateProblemAreaHeightPx(
  block: Extract<SigmaBlock, { type: "problem" }>,
  area: ProblemAreaName,
  charsPerLine: number,
): number {
  return Math.max(
    sumRichBlockHeights(block[area], charsPerLine),
    mmToPx(block.areaLayout?.[area]?.minHeightMm ?? 0),
  );
}

function sumRichBlockHeights(blocks: ProblemAreaBlock[], charsPerLine: number): number {
  return blocks.reduce((height, block) => height + estimateBlockHeightPx(block, charsPerLine), 0);
}

function sumBoxBlockChildHeights(blocks: BoxBlockChildBlock[], charsPerLine: number): number {
  return blocks.reduce((height, block) => height + estimateBlockHeightPx(block, charsPerLine), 0);
}

/** 箇条書き1項目の推定高さ (ネストした子リストは含まない)。 */
export function estimateListItemHeightPx(
  item: Extract<RichBlock, { type: "list" }>["items"][number],
  charsPerLine: number,
  depth = 0,
): number {
  const itemCharsPerLine = listItemCharsPerLine(charsPerLine, depth);
  const leadHeight = estimateInlineLines(item.children, itemCharsPerLine) * lineHeightPx(undefined);
  const continuationHeight = (item.continuations ?? []).reduce((sum, continuation) => (
    continuation.type === "divider"
      // `document-surface.css` の margin 10px × 2 + 罫線 1px。
      ? sum + 21
      : sum + estimateInlineLines(continuation.children, itemCharsPerLine) * lineHeightPx(continuation.lineHeight)
  ), 0);
  return leadHeight + continuationHeight;
}

/** 箇条書きの入れ子段数に応じた1行あたり文字数 (行頭記号とインデントの分を引く)。 */
function listItemCharsPerLine(charsPerLine: number, depth = 0): number {
  return Math.max(8, charsPerLine - depth * 4 - 3);
}

function estimateListHeightPx(block: Extract<RichBlock, { type: "list" }>, charsPerLine: number, depth = 0): number {
  return block.items.reduce((height, item) => {
    const nestedHeight = (item.nested ?? []).reduce((sum, nested) => sum + estimateListHeightPx(nested, charsPerLine, depth + 1), 0);
    return height + estimateListItemHeightPx(item, charsPerLine, depth) + nestedHeight;
  }, 0);
}

function estimateInlineLines(children: InlineNode[], charsPerLine: number): number {
  const textLength = children.reduce((length, child) => {
    if (child.type === "text") {
      return length + child.text.length;
    }
    return length + Math.max(4, child.tex.length);
  }, 0);

  return Math.max(1, Math.ceil(textLength / charsPerLine));
}

function lineHeightPx(lineHeight: string | undefined): number {
  const multiplier = Number(lineHeight ?? "1.75");
  return 16 * (Number.isFinite(multiplier) ? multiplier : 1.75);
}

function isPageSizePreset(value: unknown): value is PageSizePreset {
  return value === "A4" || value === "A3" || value === "B5" || value === "B4" || value === "custom" || value === "whiteboard";
}

function isPageOrientation(value: unknown): value is PageOrientation {
  return value === "portrait" || value === "landscape";
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegativeNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizePageRunningRegion(
  input: PageLayoutInput["header"],
  fallback: PageRunningRegion,
): PageRunningRegion {
  const normalizedBlocks = normalizePageRunningBlocks(input?.blocks);
  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : fallback.enabled,
    heightMm: positiveNumberOr(input?.heightMm, fallback.heightMm),
    offsetMm: nonnegativeNumberOr(input?.offsetMm, fallback.offsetMm),
    showOnFirstPage: typeof input?.showOnFirstPage === "boolean" ? input.showOnFirstPage : fallback.showOnFirstPage,
    blocks: normalizedBlocks ?? fallback.blocks.map(cloneRichBlock),
    overlay: normalizePageOverlay(input?.overlay),
  };
}

function normalizePageRunningBlocks(input: unknown): RichBlock[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const blocks = input.flatMap((block): RichBlock[] => {
    if (!block || typeof block !== "object" || !("type" in block)) {
      return [];
    }

    if (block.type === "heading" && Array.isArray(block.children)) {
      const level = block.level === 1 || block.level === 2 || block.level === 3 ? block.level : 2;
      return [{
        type: "heading",
        id: typeof block.id === "string" && block.id ? block.id : "running_heading",
        level,
        children: normalizeInlineNodes(block.children),
        align: normalizeTextAlign(block.align),
        lineHeight: normalizeLineHeight(block.lineHeight),
      }];
    }

    if (block.type === "paragraph" && Array.isArray(block.children)) {
      return [{
        type: "paragraph",
        id: typeof block.id === "string" && block.id ? block.id : "running_paragraph",
        children: normalizeInlineNodes(block.children),
        align: normalizeTextAlign(block.align),
        lineHeight: normalizeLineHeight(block.lineHeight),
      }];
    }

    if (block.type === "list" && (block.listType === "bullet" || block.listType === "ordered") && Array.isArray(block.items)) {
      const items = normalizeListItems(block.items);
      if (items.length === 0) {
        return [];
      }
      return [{
        type: "list",
        id: typeof block.id === "string" && block.id ? block.id : "running_list",
        listType: block.listType,
        start: positiveNumberOr(block.start, 0) || undefined,
        markerStyle: block.listType === "ordered"
          ? normalizeOrderedListMarkerStyle(block.markerStyle)
          : undefined,
        items,
      }];
    }

    return [];
  });

  return blocks;
}

function normalizeListItems(input: unknown[]): Extract<RichBlock, { type: "list" }>["items"] {
  return input.flatMap((item) => {
    if (!isRecord(item) || item.type !== "listItem" || !Array.isArray(item.children)) {
      return [];
    }

    const nested = Array.isArray(item.nested)
      ? normalizePageRunningBlocks(item.nested)?.filter((block): block is Extract<RichBlock, { type: "list" }> => block.type === "list")
      : undefined;
    const continuations = Array.isArray(item.continuations)
      ? normalizePageRunningBlocks(item.continuations)?.filter((block): block is Extract<RichBlock, { type: "paragraph" | "heading" }> => block.type === "paragraph" || block.type === "heading")
      : undefined;

    return [{
      type: "listItem" as const,
      id: typeof item.id === "string" && item.id ? item.id : "running_list_item",
      children: normalizeInlineNodes(item.children),
      align: normalizeTextAlign(item.align),
      ...(continuations && continuations.length > 0 ? { continuations } : {}),
      ...(nested && nested.length > 0 ? { nested } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePageOverlay(input: unknown): PageOverlay | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const raw = input as Partial<PageOverlay>;
  const overlaySnapshot = raw.overlaySnapshot ? normalizeOverlaySnapshot(raw.overlaySnapshot) : undefined;
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : undefined;

  // The snapshot is the only source. Any serialized SVG carried by hand-written or
  // third-party JSON is dropped here — it is never stored and never rendered.
  if (!overlaySnapshot) {
    return undefined;
  }

  return {
    overlaySnapshot,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function pageOverlayHasContent(overlay: PageOverlay | undefined): boolean {
  if (!overlay?.overlaySnapshot) {
    return false;
  }

  return normalizeOverlaySnapshot(overlay.overlaySnapshot).shapes.some((shape) => !shape.hidden);
}

function normalizeInlineNodes(input: unknown[]): InlineNode[] {
  return input.flatMap((node): InlineNode[] => {
    if (!node || typeof node !== "object" || !("type" in node)) {
      return [];
    }

    const raw = node as Record<string, unknown>;
    if (node.type === "text") {
      const boxedVariant = normalizeBoxedVariant(raw.boxedVariant);
      const boxedTone = normalizeBoxedTone(raw.boxedTone);
      return [{
        type: "text",
        text: typeof raw.text === "string" ? raw.text : "",
        marks: normalizeTextMarks(raw.marks),
        color: typeof raw.color === "string" ? raw.color : undefined,
        backgroundColor: typeof raw.backgroundColor === "string" ? raw.backgroundColor : undefined,
        fontFamily: typeof raw.fontFamily === "string" ? raw.fontFamily : undefined,
        fontSize: positiveNumberOr(raw.fontSize, 0) || undefined,
        boxedPaddingY: nonnegativeNumberOr(raw.boxedPaddingY, -1) >= 0 ? nonnegativeNumberOr(raw.boxedPaddingY, 0) : undefined,
        ...(boxedVariant ? { boxedVariant } : {}),
        ...(boxedTone ? { boxedTone } : {}),
      }];
    }

    if (node.type === "mathInline") {
      const marks = normalizeMathInlineMarks(raw.marks);
      const boxedVariant = normalizeBoxedVariant(raw.boxedVariant);
      const boxedTone = normalizeBoxedTone(raw.boxedTone);
      return [{
        type: "mathInline",
        id: typeof raw.id === "string" && raw.id ? raw.id : "running_math",
        tex: typeof raw.tex === "string" ? raw.tex : "",
        display: "inline",
        ...(marks ? { marks } : {}),
        ...(marks?.includes("boxed") && nonnegativeNumberOr(raw.boxedPaddingY, -1) >= 0 ? {
          boxedPaddingY: nonnegativeNumberOr(raw.boxedPaddingY, 0),
        } : {}),
        ...(boxedVariant ? { boxedVariant } : {}),
        ...(boxedTone ? { boxedTone } : {}),
        semanticRole: raw.semanticRole === "equation" || raw.semanticRole === "variable" ? raw.semanticRole : "expression",
      }];
    }

    return [];
  });
}

function normalizeTextMarks(input: unknown): Array<"bold" | "italic" | "underline" | "boxed"> | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const marks = input.filter((mark): mark is "bold" | "italic" | "underline" | "boxed" =>
    mark === "bold" || mark === "italic" || mark === "underline" || mark === "boxed");
  return marks.length > 0 ? Array.from(new Set(marks)) : undefined;
}

function normalizeMathInlineMarks(input: unknown): Array<"underline" | "boxed"> | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const marks = input.filter((mark): mark is "underline" | "boxed" => mark === "underline" || mark === "boxed");
  return marks.length > 0 ? Array.from(new Set(marks)) : undefined;
}

function normalizeBoxedVariant(input: unknown): "frame" | "thick" | "double" | "oval" | "shade" | undefined {
  return input === "frame" || input === "thick" || input === "double" || input === "oval" || input === "shade"
    ? input
    : undefined;
}

function normalizeBoxedTone(input: unknown): "gray" | "blue" | "green" | "red" | "yellow" | undefined {
  return input === "gray" || input === "blue" || input === "green" || input === "red" || input === "yellow"
    ? input
    : undefined;
}

function clonePageRunningRegion(region: PageRunningRegion): PageRunningRegion {
  return {
    ...region,
    blocks: region.blocks?.map(cloneRichBlock),
    overlay: clonePageOverlay(region.overlay),
  };
}

function clonePageOverlay(overlay: PageOverlay | undefined): PageOverlay | undefined {
  if (!overlay) {
    return undefined;
  }

  return {
    ...overlay,
    overlaySnapshot: overlay.overlaySnapshot ? normalizeOverlaySnapshot(overlay.overlaySnapshot) : undefined,
  };
}

function cloneRichBlock(block: RichBlock): RichBlock {
  if (block.type === "heading") {
    return {
      ...block,
      children: block.children.map(cloneInlineNode),
    };
  }

  if (block.type === "paragraph") {
    return {
      ...block,
      children: block.children.map(cloneInlineNode),
    };
  }

  return cloneListBlock(block);
}

function cloneListBlock(block: Extract<RichBlock, { type: "list" }>): Extract<RichBlock, { type: "list" }> {
  return {
    ...block,
    items: block.items.map((item) => ({
      ...item,
      children: item.children.map(cloneInlineNode),
      continuations: item.continuations?.map((paragraph) => ({
        ...paragraph,
        children: listItemContinuationInlineNodes(paragraph).map(cloneInlineNode),
      })),
      nested: item.nested?.map(cloneListBlock),
    })),
  };
}

function cloneInlineNode(node: InlineNode): InlineNode {
  if (node.type === "mathInline") {
    return {
      ...node,
      ...(node.marks ? { marks: [...node.marks] } : {}),
    };
  }

  return {
    ...node,
    marks: node.marks ? [...node.marks] : undefined,
  };
}

function richBlockHasContent(block: RichBlock): boolean {
  if (block.type === "list") {
    return block.items.some((item) =>
      item.children.some((child) => child.type === "mathInline" ? child.tex.trim() : child.text.trim()) ||
      (item.continuations ?? []).some((continuation) => (
        // 区切り線は文章を持たないが、あれば項目は空ではない。
        continuation.type === "divider" || richBlockHasContent(continuation)
      )) ||
      (item.nested ?? []).some(richBlockHasContent),
    );
  }
  return block.children.some((child) => child.type === "mathInline" ? child.tex.trim() : child.text.trim());
}

function normalizeTextAlign(value: unknown): "left" | "center" | "right" | "justify" | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify" ? value : undefined;
}
