import { normalizeBlockSpaceAfterPx } from "@/features/document";
import type {
  BoxBlockNode,
  CodeBlockNode,
  DividerNode,
  HeadingNode,
  ListItemNode,
  ListNode,
  ParagraphNode,
  ProblemAreaBlock,
  ProblemAreaKind,
  ProblemNode,
  LayoutSectionNode,
  LayoutSectionChildBlock,
  QuoteBlockNode,
  SectionNode,
  SigmaBlock,
} from "@/features/document";

export const DEFAULT_PROBLEM_NUMBER_FONT_SIZE = 12;

/**
 * Canonical document blocks that participate in the body text-flow projection.
 *
 * `layoutSection` belongs to the editor projection, while a top-level
 * `layoutSection` is deliberately not considered a directly adjacent text-flow
 * block by `getNextTopLevelTextFlowBlockId`.
 */
export type BodyTextFlowBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode
  | ProblemNode
  | Extract<SigmaBlock, { type: "layoutSection" }>;

export type BodyEditableBlock = SigmaBlock | ProblemAreaBlock | ListItemNode;

export const LAYOUT_SECTION_WIDTH_TOTAL = 10_000;

function normalizeLayoutSectionColumnWidths(widths: readonly number[], count: number): number[] {
  const safeCount = Math.max(1, count);
  const usable = widths.length === safeCount && widths.every((value) => Number.isFinite(value) && value > 0)
    ? widths
    : Array.from({ length: safeCount }, () => 1);
  const total = usable.reduce((sum, value) => sum + value, 0);
  if (total === LAYOUT_SECTION_WIDTH_TOTAL && usable.every(Number.isInteger)) {
    return [...usable];
  }
  const distributable = LAYOUT_SECTION_WIDTH_TOTAL - safeCount;
  const normalized = usable.map((value) => 1 + Math.floor(value / total * distributable));
  normalized[normalized.length - 1] += LAYOUT_SECTION_WIDTH_TOTAL - normalized.reduce((sum, value) => sum + value, 0);
  return normalized;
}

/**
 * Resolve the persisted, independent columns. New sections always have `columnStartIds`; the
 * deterministic fallback is only for in-memory fixtures that have not yet been updated.
 */
export function getLayoutSectionColumns(section: LayoutSectionNode): LayoutSectionChildBlock[][] {
  const count = Math.min(4, Math.max(1, Math.floor(section.layout.columnCount)));
  if (count <= 1 || section.children.length <= 1) {
    return [section.children];
  }
  const actualCount = Math.min(count, section.children.length);
  const starts = section.layout.columnStartIds ?? [];
  const childIndexById = new Map(section.children.map((child, index) => [child.id, index]));
  const startIndexes = [0];
  for (let columnIndex = 1; columnIndex < actualCount; columnIndex += 1) {
    const persisted = childIndexById.get(starts[columnIndex] ?? "");
    const minimum = startIndexes[columnIndex - 1] + 1;
    const maximum = section.children.length - (actualCount - columnIndex);
    // A start belongs to its persisted column slot. In particular, a first-column id that
    // moved into the middle after Enter must not become an extra boundary. If a boundary owner
    // disappeared, keep as much of the surviving prefix in its former column as possible. An
    // even repartition would move unrelated survivors across columns (for example deleting c
    // from [a,b] [c,d] used to produce [a] [b,d]). Live editor mutations additionally carry
    // their pre-edit ownership through the Tiptap projection; this is only the deterministic
    // last resort for malformed/incomplete data.
    const conservativeFallback = maximum;
    startIndexes.push(
      persisted !== undefined && persisted >= minimum && persisted <= maximum
        ? persisted
        : Math.min(maximum, Math.max(minimum, conservativeFallback)),
    );
  }
  return startIndexes.map((start, index) => (
    section.children.slice(start, startIndexes[index + 1] ?? section.children.length)
  ));
}

export function getLayoutSectionColumnWidths(section: LayoutSectionNode, count = getLayoutSectionColumns(section).length): number[] {
  const widths = section.layout.columnWidths;
  if (widths?.length === count && widths.every((value) => Number.isFinite(value) && value > 0)) {
    return normalizeLayoutSectionColumnWidths(widths, count);
  }
  return normalizeLayoutSectionColumnWidths([], count);
}

export function setLayoutSectionColumns(
  section: LayoutSectionNode,
  columns: readonly (readonly LayoutSectionChildBlock[])[],
  widths: readonly number[] = getLayoutSectionColumnWidths(section, columns.length),
): LayoutSectionNode {
  const populated = columns
    .map((column, index) => ({
      column: column.map((child) => {
        if (child.pagination?.break !== true) return child;
        const { break: _break, ...pagination } = child.pagination;
        void _break;
        if (Object.keys(pagination).length > 0) return { ...child, pagination };
        const { pagination: _pagination, ...rest } = child;
        void _pagination;
        return rest as LayoutSectionChildBlock;
      }),
      width: widths[index] ?? 1,
    }))
    .filter(({ column }) => column.length > 0);
  if (populated.length === 0) return section;
  const columnWidths = normalizeLayoutSectionColumnWidths(populated.map(({ width }) => width), populated.length);
  return {
    ...section,
    layout: {
      ...section.layout,
      columnCount: populated.length,
      columnStartIds: populated.map(({ column }) => column[0].id),
      columnWidths,
    },
    children: populated.flatMap(({ column }) => column),
  };
}

export function isProblemAreaKind(value: string | null): value is ProblemAreaKind {
  return value === "lead" || value === "prompt" || value === "hints" || value === "solution";
}

export function getProblemNumberFontSize(problem: Pick<ProblemNode, "numbering">): number {
  const fontSize = problem.numbering?.fontSize;
  return typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : DEFAULT_PROBLEM_NUMBER_FONT_SIZE;
}

export function getPageBreakBeforeIds(blocks: readonly BodyTextFlowBlock[]): string[] {
  return blocks
    .filter((block) => block.pagination?.break === true)
    .map((block) => block.id);
}

/** Manual break markers follow the surrounding page/column flow through containers. */
export function getNestedPageBreakBeforeIds(blocks: readonly BodyTextFlowBlock[]): string[] {
  return Object.keys(getNestedPageBreakBeforeKinds(blocks));
}

export type PageBreakMarkerKind = "columnBreak" | "pageBreak";

export function getNestedPageBreakBeforeKinds(
  blocks: readonly BodyTextFlowBlock[],
  outerKind: PageBreakMarkerKind = "pageBreak",
): Record<string, PageBreakMarkerKind> {
  const kinds: Record<string, PageBreakMarkerKind> = {};
  const visit = (children: readonly SigmaBlock[], kind: PageBreakMarkerKind, nested: boolean) => {
    children.forEach((child, index) => {
      if (nested && index > 0 && child.pagination?.break) kinds[child.id] = kind;
      if (child.type === "boxBlock" || child.type === "quote") visit(child.blocks, kind, true);
      else if (child.type === "layoutSection") visit(child.children, child.layout.columnCount > 1 ? "columnBreak" : kind, true);
      else if (child.type === "problem") {
        for (const area of [child.lead, child.prompt, child.hints, child.solution]) visit(area, kind, true);
      }
    });
  };
  visit(blocks, outerKind, false);
  return kinds;
}

export function isColumnWrapTargetBlock(
  block: BodyEditableBlock,
): block is SectionNode | HeadingNode | ParagraphNode | ListNode {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list";
}

export function isBodyContextMenuBlock(
  block: BodyEditableBlock,
): block is SigmaBlock | ProblemAreaBlock {
  return block.type !== "listItem";
}

export function bodyTextFlowBlockContainsId(
  block: BodyTextFlowBlock,
  selectedId: string | null,
): boolean {
  if (!selectedId) {
    return false;
  }
  if (block.id === selectedId) {
    return true;
  }
  if (block.type === "boxBlock") {
    return block.blocks.some((child) => bodyTextFlowBlockContainsId(child, selectedId));
  }
  if (block.type === "layoutSection") {
    return block.children.some((child) => bodyTextFlowBlockContainsId(child, selectedId));
  }
  if (block.type === "list") {
    return block.items.some((item) => (
      item.id === selectedId
      || (item.continuations ?? []).some((continuation) => continuation.id === selectedId)
      || (item.nested ?? []).some((nested) => bodyTextFlowBlockContainsId(nested, selectedId))
    ));
  }
  return false;
}

export function setLayoutSectionColumnCount<T extends SigmaBlock | ProblemAreaBlock>(
  block: T,
  columnCount: number,
  createEmptyBlock?: () => ParagraphNode,
): T {
  if (block.type !== "layoutSection") {
    return block;
  }

  const nextColumnCount = Math.min(4, Math.max(1, Math.floor(columnCount)));
  const children = [...block.children];
  while (children.length < nextColumnCount && createEmptyBlock) children.push(createEmptyBlock());
  const actualColumnCount = Math.min(children.length, nextColumnCount);
  const columns = Array.from({ length: actualColumnCount }, (_, index) => {
    const start = Math.floor(index * children.length / actualColumnCount);
    const end = Math.floor((index + 1) * children.length / actualColumnCount);
    return children.slice(start, end);
  });
  return setLayoutSectionColumns(block, columns) as T;
}

export function setBlockBreakBefore<T extends SigmaBlock | ProblemAreaBlock>(
  block: T,
  enabled: boolean,
): T {
  const pagination = { ...(block.pagination ?? {}) };
  if (enabled) {
    pagination.break = true;
  } else {
    delete pagination.break;
  }

  const nextPagination = Object.keys(pagination).length > 0 ? pagination : undefined;
  return {
    ...block,
    ...(nextPagination ? { pagination: nextPagination } : { pagination: undefined }),
  };
}

/**
 * ブロック下余白を設定する。`0` は保存しない (フィールドごと落とす) ので、リセットした結果が
 * 「一度も触っていないブロック」と同じ JSON になる。
 *
 * 値が変わらないときは **同一参照** を返す — 呼び出し側 (`updateBlockInDocument`) が identity で
 * 「変わっていない」を見て、ドラッグ中の無駄な文書更新と再描画を止められるように。
 */
export function setBlockSpaceAfter<T extends SigmaBlock | ProblemAreaBlock | ListItemNode>(
  block: T,
  spaceAfterPx: number,
): T {
  const next = normalizeBlockSpaceAfterPx(spaceAfterPx);
  if (next === block.spaceAfterPx) {
    return block;
  }
  if (next === undefined) {
    const cleared = { ...block };
    delete cleared.spaceAfterPx;
    return cleared;
  }
  return { ...block, spaceAfterPx: next };
}

export function findTopLevelBlock(
  content: readonly SigmaBlock[],
  blockId: string,
): SigmaBlock | null {
  return content.find((block) => block.id === blockId) ?? null;
}

export function collectBoxBlocksById(
  content: readonly SigmaBlock[],
): Map<string, BoxBlockNode> {
  const boxes = new Map<string, BoxBlockNode>();

  const visitTextBlock = (block: BodyTextFlowBlock) => {
    if (block.type === "boxBlock") {
      boxes.set(block.id, block);
      for (const child of block.blocks) {
        visitTextBlock(child);
      }
      return;
    }

    if (block.type === "layoutSection") {
      for (const child of block.children) {
        visitTextBlock(child);
      }
      return;
    }

    if (block.type === "list") {
      for (const item of block.items) {
        for (const continuation of item.continuations ?? []) {
          visitTextBlock(continuation);
        }
        for (const nested of item.nested ?? []) {
          visitTextBlock(nested);
        }
      }
    }
  };

  for (const block of content) {
    if (isTopLevelTextFlowBlock(block)) {
      visitTextBlock(block);
    } else if (block.type === "problem") {
      for (const child of [...block.lead, ...block.prompt, ...block.hints, ...block.solution]) {
        visitTextBlock(child);
      }
    } else if (block.type === "layoutSection") {
      for (const child of block.children) {
        visitTextBlock(child);
      }
    }
  }

  return boxes;
}

export function getNextTopLevelTextFlowBlockId(
  content: readonly SigmaBlock[],
  blockId: string,
): string | null {
  const blockIndex = content.findIndex((block) => block.id === blockId);
  if (blockIndex < 0 || !isTopLevelTextFlowBlock(content[blockIndex])) {
    return null;
  }

  const nextBlock = content[blockIndex + 1];
  return nextBlock && isTopLevelTextFlowBlock(nextBlock) ? nextBlock.id : null;
}

function isTopLevelTextFlowBlock(
  block: SigmaBlock,
): block is SectionNode | HeadingNode | ParagraphNode | ListNode | BoxBlockNode {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "boxBlock";
}
