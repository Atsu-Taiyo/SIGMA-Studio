import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
import { createId } from "@/lib/id";
import { createBoxBlock } from "@/lib/box-blocks";
import { inlineNodesToPlainText, overlayTextBlocksToInlineNodes } from "@/lib/tiptap-adapter";
import {
  getTableCellDisplayNodes,
  listItemContinuationInlineNodes,
  normalizeOverlaySnapshot,
  PROBLEM_AREA_ORDER,
  type OverlayShape,
  type OverlayTableShape,
  type SigmaTableSpec,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type SigmaBlock,
  type SigmaDocument,
  type HeadingNode,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListItemNode,
  type ListNode,
  type PaginationHints,
  type ParagraphNode,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
  type QuoteBlockNode,
  type QuoteChildBlock,
  type RichBlock,
  type SectionNode,
} from "@/features/document";
import {
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  setLayoutSectionColumns,
} from "@/features/text-editing";

export type TopLevelTextFlowBlock = SectionNode | HeadingNode | ParagraphNode | ListNode | BoxBlockNode;
export type EditableBlock = SigmaBlock | ProblemAreaBlock | ListItemNode;

export interface ProblemAreaBlockLocation {
  problemId: string;
  area: ProblemAreaKind;
  blockId: string;
}

export interface EnsureBodyBlockAfterProblemResult {
  document: SigmaDocument;
  bodyBlock: ParagraphNode | null;
}

export interface EnsureEditableBodyResult {
  document: SigmaDocument;
  /** 本文が空だったので補った段落。補う必要が無ければ null。 */
  bodyBlock: ParagraphNode | null;
}

/**
 * ブロックの新規作成。ここで入る既定文言は**文書に焼き込まれる**ので、
 * 作った時点の UI 言語で解決する (あとで言語を変えても中身は変わらない = D3)。
 * `t` の既定が日本語なのは、既存の呼び出しとテストを無傷にするため。
 */
export function createBlock(
  type: SigmaBlock["type"],
  t: Translate<"editor"> = createTranslator(DEFAULT_LOCALE, "editor"),
): SigmaBlock {
  switch (type) {
    case "section":
      return {
        type: "section",
        id: createId("section"),
        title: t("newBlock.section"),
      };
    case "heading":
      return {
        type: "heading",
        id: createId("heading"),
        level: 2,
        children: [{ type: "text", text: t("newBlock.heading") }],
      };
    case "paragraph":
      // Empty on purpose. "本文を入力" is the empty-document CSS placeholder, not baked-in text.
      return createParagraph("");
    case "list":
      return {
        type: "list",
        id: createId("list"),
        listType: "bullet",
        items: [{
          type: "listItem",
          id: createId("li"),
          children: [{ type: "text", text: t("newBlock.listItem") }],
        }],
      };
    case "problem":
      return {
        type: "problem",
        id: createId("problem"),
        tags: [],
        lead: [],
        prompt: [createParagraph(t("newBlock.problemPrompt"))],
        answer: {
          type: "math",
          expected: "",
        },
        solution: [createParagraph(t("newBlock.problemSolution"))],
        hints: [],
      };
    case "layoutSection":
      return createLayoutSection([createParagraph("")]);
    case "boxBlock":
      return createBoxBlock("fancybox", "", {}, t);
    case "divider":
      return { type: "divider", id: createId("divider") };
    case "quote":
      return { type: "quote", id: createId("quote"), blocks: [createParagraph(t("newBlock.quote"))] };
    case "codeBlock":
      return { type: "codeBlock", id: createId("code"), children: [{ type: "text", text: "" }] };
  }
}

export function createParagraph(text: string): ParagraphNode {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [{ type: "text", text }],
  };
}

export function createLayoutSection(
  children: LayoutSectionChildBlock[],
  columnCount = 2,
  columnGapMm = 8,
): LayoutSectionNode {
  const count = Math.min(4, Math.max(1, Math.floor(columnCount)));
  const content = children.length > 0 ? [...children] : [createParagraph("")];
  while (content.length < count) content.push(createParagraph(""));
  const columnStartIds = Array.from({ length: count }, (_, index) => (
    content[Math.floor(index * content.length / count)].id
  ));
  return {
    type: "layoutSection",
    id: createId("layout_section"),
    layout: {
      columnCount: count,
      columnGapMm: Math.max(0, columnGapMm),
      columnStartIds,
      columnWidths: Array.from({ length: count }, () => 1),
    },
    children: content,
  };
}

export function updateBlockInDocument(
  document: SigmaDocument,
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): SigmaDocument {
  const content = updateBlocks(document.content, blockId, updater);
  if (content === document.content) {
    return document;
  }

  return {
    ...document,
    content,
    updatedAt: new Date().toISOString(),
  };
}

export function findBlock(document: SigmaDocument, blockId: string): EditableBlock | null {
  for (const block of walkBlocksDeep(document.content)) {
    if (block.id === blockId) {
      return block;
    }
  }
  return null;
}

/**
 * Maps every block id anywhere in the tree — top-level content, problem.lead/prompt/hints/solution,
 * layoutSection.children, boxBlock.blocks and list items — to its block. Shares `walkBlocksDeep` with
 * `findBlock` so both follow the exact same recursion rules; unlike a plain top-level
 * `Map(document.content.map(...))`, this also resolves blocks nested inside problem areas/layout
 * sections/box blocks, which is required to look up manual page-break hints on those blocks.
 */
export function collectBlocksById(blocks: readonly SigmaBlock[]): Map<string, EditableBlock> {
  const map = new Map<string, EditableBlock>();
  for (const block of walkBlocksDeep(blocks)) {
    map.set(block.id, block);
  }
  return map;
}

export function findContainingProblem(document: SigmaDocument, blockId: string | null): ProblemNode | null {
  if (!blockId) return null;
  let containing: ProblemNode | null = null;
  for (const block of walkBlocksDeep(document.content)) {
    if (block.type === "problem" && (block.id === blockId || problemContainsRichBlock(block, blockId))) containing = block;
  }
  return containing;
}

export function findContainingLayoutSection(document: SigmaDocument, blockId: string | null): LayoutSectionNode | null {
  if (!blockId) {
    return null;
  }

  for (const block of document.content) {
    const section = findContainingLayoutSectionInBlock(block, blockId);
    if (section) {
      return section;
    }
  }

  return null;
}

export function findContainingBoxBlock(document: SigmaDocument, blockId: string | null): BoxBlockNode | null {
  if (!blockId) {
    return null;
  }

  for (const block of document.content) {
    const box = findContainingBoxBlockInBlock(block, blockId, null);
    if (box) {
      return box;
    }
  }

  return null;
}

function findContainingBoxBlockInBlock(
  block: SigmaBlock | ProblemAreaBlock | LayoutSectionChildBlock | BoxBlockChildBlock,
  blockId: string,
  containingBox: BoxBlockNode | null,
): BoxBlockNode | null {
  if (block.id === blockId) {
    return containingBox;
  }

  if (block.type === "boxBlock") {
    for (const child of block.blocks) {
      const nested = findContainingBoxBlockInBlock(child, blockId, block);
      if (nested) {
        return nested;
      }
    }
  }

  if (block.type === "layoutSection") {
    for (const child of block.children) {
      const nested = findContainingBoxBlockInBlock(child, blockId, containingBox);
      if (nested) {
        return nested;
      }
    }
  }

  if ((block.type === "quote" || block.type === "list") && blockSubtreeContainsId(block, blockId)) {
    return containingBox;
  }

  if (block.type === "problem") {
    for (const area of PROBLEM_AREA_ORDER) {
      for (const child of block[area]) {
        const nested = findContainingBoxBlockInBlock(child, blockId, containingBox);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return null;
}

function findContainingLayoutSectionInBlock(block: SigmaBlock | ProblemAreaBlock | LayoutSectionChildBlock | BoxBlockChildBlock, blockId: string): LayoutSectionNode | null {
  if (block.type === "layoutSection") {
    if (block.id === blockId) {
      return block;
    }
    for (const child of block.children) {
      const nested = findContainingLayoutSectionInBlock(child, blockId);
      if (nested) {
        return nested;
      }
    }
    return layoutSectionContainsBlock(block, blockId) ? block : null;
  }

  if (block.type === "boxBlock") {
    for (const child of block.blocks) {
      const nested = findContainingLayoutSectionInBlock(child, blockId);
      if (nested) {
        return nested;
      }
    }
  }

  if (block.type === "problem") {
    for (const area of PROBLEM_AREA_ORDER) {
      for (const child of block[area]) {
        const nested = findContainingLayoutSectionInBlock(child, blockId);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return null;
}

export function findProblemAreaBlockLocation(
  document: SigmaDocument,
  blockId: string | null,
): ProblemAreaBlockLocation | null {
  const problem = findContainingProblem(document, blockId);
  if (!problem || !blockId) return null;
  const area = getProblemAreaContainingRichBlock(problem, blockId);
  return area ? { problemId: problem.id, area, blockId } : null;
}

export function collectProblemAreaBlockLocations(
  document: SigmaDocument,
): Map<string, ProblemAreaBlockLocation> {
  const locations = new Map<string, ProblemAreaBlockLocation>();
  for (const block of walkBlocksDeep(document.content)) {
    if (block.type !== "problem") {
      continue;
    }

    for (const area of PROBLEM_AREA_ORDER) {
      for (const richBlock of block[area]) {
        collectRichBlockLocations(locations, richBlock, block.id, area);
      }
    }
  }
  return locations;
}

function collectRichBlockLocations(
  locations: Map<string, ProblemAreaBlockLocation>,
  richBlock: ProblemAreaBlock,
  problemId: string,
  area: ProblemAreaKind,
): void {
  locations.set(richBlock.id, {
    problemId,
    area,
    blockId: richBlock.id,
  });

  if (richBlock.type !== "list") {
    if (richBlock.type === "layoutSection") {
      richBlock.children.forEach((child) => collectProblemAreaChildLocations(locations, child, problemId, area));
    } else if (richBlock.type === "quote") {
      richBlock.blocks.forEach((child) => {
        collectProblemAreaChildLocations(locations, child, problemId, area);
      });
    } else if (richBlock.type === "boxBlock") {
      richBlock.blocks.forEach((child) => {
        if (child.type === "layoutSection") {
          collectRichBlockLocations(locations, child, problemId, area);
        } else {
          collectProblemAreaChildLocations(locations, child, problemId, area);
        }
      });
    }
    return;
  }

  for (const item of richBlock.items) {
    locations.set(item.id, {
      problemId,
      area,
      blockId: richBlock.id,
    });
    item.continuations?.forEach((continuation) => locations.set(continuation.id, {
      problemId,
      area,
      blockId: continuation.id,
    }));
    item.nested?.forEach((nested) => collectRichBlockLocations(locations, nested, problemId, area));
  }
}

function collectProblemAreaChildLocations(
  locations: Map<string, ProblemAreaBlockLocation>,
  block: BoxBlockChildBlock,
  problemId: string,
  area: ProblemAreaKind,
): void {
  if (block.type === "problem") {
    for (const nestedArea of PROBLEM_AREA_ORDER) {
      block[nestedArea].forEach((child) => collectRichBlockLocations(locations, child, block.id, nestedArea));
    }
    return;
  }
  locations.set(block.id, {
    problemId,
    area,
    blockId: block.id,
  });
  if (block.type === "quote") {
    block.blocks.forEach((child) => {
      collectProblemAreaChildLocations(locations, child, problemId, area);
    });
  }
  if (block.type === "boxBlock") {
    block.blocks.forEach((child) => {
      if (child.type === "layoutSection") {
        collectRichBlockLocations(locations, child, problemId, area);
      } else {
        collectProblemAreaChildLocations(locations, child, problemId, area);
      }
    });
  }
  if (block.type === "list") {
    block.items.forEach((item) => {
      locations.set(item.id, { problemId, area, blockId: block.id });
      item.continuations?.forEach((continuation) => {
        locations.set(continuation.id, { problemId, area, blockId: continuation.id });
      });
      item.nested?.forEach((nested) => collectRichBlockLocations(locations, nested, problemId, area));
    });
  }
}

export function createEmptyProblemAreaAnchorBlock(area: ProblemAreaKind): RichBlock {
  return {
    type: "paragraph",
    id: createId(area === "hints" ? "comment" : area === "solution" ? "answer" : area),
    children: [],
  };
}

export function insertTopLevelBlock(
  document: SigmaDocument,
  block: SigmaBlock,
  afterBlockId: string | null,
): SigmaDocument {
  const nextContent = [...document.content];
  const insertIndex = getTopLevelInsertIndex(nextContent, afterBlockId);
  nextContent.splice(insertIndex, 0, block);

  return {
    ...document,
    content: nextContent,
    updatedAt: new Date().toISOString(),
  };
}

export function insertTopLevelBlockReplacingEmptySelection(
  document: SigmaDocument,
  block: SigmaBlock,
  selectedId: string | null,
): SigmaDocument {
  const replaceIndex = selectedId
    ? document.content.findIndex((item) => item.id === selectedId && isEmptyTopLevelTextFlowBlock(item))
    : -1;
  if (replaceIndex < 0) {
    return insertTopLevelBlock(document, block, selectedId);
  }

  const nextContent = [...document.content];
  nextContent.splice(replaceIndex, 1, block);

  return {
    ...document,
    content: nextContent,
    updatedAt: new Date().toISOString(),
  };
}

/** Insert menus share the innermost box selected by its text surface. */
export function insertBlockAtSelection(
  document: SigmaDocument,
  block: SigmaBlock,
  selectedId: string | null,
  options: { replaceEmpty?: boolean } = {},
): SigmaDocument {
  const box = findContainingBoxBlock(document, selectedId);
  if (!box || !selectedId) {
    return options.replaceEmpty
      ? insertTopLevelBlockReplacingEmptySelection(document, block, selectedId)
      : insertTopLevelBlock(document, block, selectedId);
  }
  const index = box.blocks.findIndex(child => blockSubtreeContainsId(child, selectedId));
  if (index < 0) return document;
  const selected = box.blocks[index];
  const replace = options.replaceEmpty && selected.id === selectedId && isEmptyTopLevelTextFlowBlock(selected);
  const blocks = [...box.blocks];
  blocks.splice(replace ? index : index + 1, replace ? 1 : 0, block);
  return updateBlockInDocument(document, box.id, current => current.type === "boxBlock" ? { ...current, blocks } : current);
}

/**
 * 空になった本文へ補う段落の id。**毎回必ず同じ値**にするのが要で、`createId` で新しい id を
 * 振ってはいけない: 同じ空文書を直した結果どうしが値として一致しなくなり、「直す → 外へ出す →
 * 空のまま返ってくる → また直す」の往復が止まらないループの種になる (埋め込みホストのエコー・
 * 外部ファイル同期)。本文が空のときしか作らないので、他ブロックと id がぶつかることも無い。
 */
export const BODY_FALLBACK_PARAGRAPH_ID = "p_body_fallback";

/**
 * 本文ブロックが 1 つも無い文書には、キャレットを置ける本文エディタが 1 つも生まれない
 * (`buildRenderUnits` がユニット 0 件を返す)。ページは白いまま、クリックしても打鍵しても
 * 何も起きない行き止まりになるので、全消去のあとも Word と同じく空段落を 1 つ残す。
 *
 * 呼ぶのは編集の書き込み口 (`commitDocumentChange`) と、文書を丸ごと差し替える経路
 * — 既にこの状態で保存されたファイルを開き直したときも、そこで直る。同じ文書に何度呼んでも
 * 同じ結果になる (冪等) ことが、上の id 固定と合わせてループを断つ条件。
 */
export function ensureEditableBody(document: SigmaDocument): EnsureEditableBodyResult {
  // ホワイトボードは overlay だけを持ち、本文ブロックを持たないことがスキーマ契約。
  // 紙面文書向けの空段落を補うと、作成直後から不正な SigmaDoc になってしまう。
  if (document.pageLayout?.preset === "whiteboard" || document.content.length > 0) {
    return { document, bodyBlock: null };
  }

  const bodyBlock: ParagraphNode = {
    type: "paragraph",
    id: BODY_FALLBACK_PARAGRAPH_ID,
    children: [{ type: "text", text: "" }],
  };
  return {
    document: { ...document, content: [bodyBlock] },
    bodyBlock,
  };
}

export function ensureBodyBlockAfterProblem(
  document: SigmaDocument,
  problemId: string,
): EnsureBodyBlockAfterProblemResult {
  const box = findContainingBoxBlock(document, problemId);
  if (box) {
    const index = box.blocks.findIndex(block => block.id === problemId && block.type === "problem");
    if (index < 0 || (box.blocks[index + 1] && isTopLevelTextFlowBlock(box.blocks[index + 1]))) {
      return { document, bodyBlock: null };
    }
    const bodyBlock = createParagraph("");
    return { document: insertBlockAtSelection(document, bodyBlock, problemId), bodyBlock };
  }
  const problemIndex = document.content.findIndex((item) => item.type === "problem" && item.id === problemId);
  if (problemIndex < 0) {
    return { document, bodyBlock: null };
  }

  const nextBlock = document.content[problemIndex + 1];
  if (nextBlock && isTopLevelTextFlowBlock(nextBlock)) {
    return { document, bodyBlock: null };
  }

  const bodyBlock = createParagraph("");
  const nextContent = [...document.content];
  nextContent.splice(problemIndex + 1, 0, bodyBlock);

  return {
    document: {
      ...document,
      content: nextContent,
      updatedAt: new Date().toISOString(),
    },
    bodyBlock,
  };
}

export function wrapTextFlowBlockInLayoutSection(
  document: SigmaDocument,
  blockId: string,
  columnCount = 2,
): SigmaDocument {
  return wrapTextFlowBlocksInLayoutSection(document, [blockId], columnCount);
}

export function wrapTextFlowBlocksInLayoutSection(
  document: SigmaDocument,
  blockIds: readonly string[],
  columnCount = 2,
  columnGapMm = document.pageLayout?.flow.columnGapMm ?? 8,
): SigmaDocument {
  const result = wrapBlocksInLayoutSectionInContent(document.content, blockIds, columnCount, columnGapMm);
  if (!result.changed) {
    return document;
  }

  return {
    ...document,
    content: result.blocks,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 部分段組みの提案を現在のSigmaDocへ再適用するとき、提案作成時の先頭・末尾IDを
 * アンカーとして、現在その間にある本文ブロックIDを取り直す。初回作成時の厳密な
 * blockIds検証は wrapTextFlowBlocksInLayoutSection が担当し、この関数は承認/rebase時に
 * 範囲内へ追加された段落を含めるためだけに使う。
 */
export function resolveTextFlowBlockRangeIds(
  document: SigmaDocument,
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  return resolveTextFlowBlockRangeIdsInContent(document.content, startBlockId, endBlockId);
}

function resolveSiblingTextFlowBlockRangeIds<T extends SigmaBlock | ProblemAreaBlock | BoxBlockChildBlock>(
  blocks: readonly T[],
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  const start = blocks.findIndex((block) => block.id === startBlockId);
  const end = blocks.findIndex((block) => block.id === endBlockId);
  if (start < 0 || end < start) {
    return null;
  }

  const range = blocks.slice(start, end + 1);
  if (!range.every(isLayoutSectionChildBlock)) {
    return null;
  }
  return range.map((block) => block.id);
}

function resolveTextFlowBlockRangeIdsInContent(
  blocks: readonly SigmaBlock[],
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  const direct = resolveSiblingTextFlowBlockRangeIds(blocks, startBlockId, endBlockId);
  if (direct) {
    return direct;
  }

  for (const block of blocks) {
    if (block.type === "problem") {
      const nested = resolveTextFlowBlockRangeIdsInProblemArea(block.solution, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    } else if (block.type === "boxBlock") {
      const nested = resolveTextFlowBlockRangeIdsInBoxChildren(block.blocks, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    } else if (block.type === "layoutSection") {
      const nested = resolveTextFlowBlockRangeIdsInLayoutChildren(block.children, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function resolveTextFlowBlockRangeIdsInProblemArea(
  blocks: readonly ProblemAreaBlock[],
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  const direct = resolveSiblingTextFlowBlockRangeIds(blocks, startBlockId, endBlockId);
  if (direct) {
    return direct;
  }

  for (const block of blocks) {
    if (block.type === "layoutSection") {
      const nested = resolveTextFlowBlockRangeIdsInLayoutChildren(block.children, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function resolveTextFlowBlockRangeIdsInBoxChildren(
  blocks: readonly BoxBlockChildBlock[],
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  const direct = resolveSiblingTextFlowBlockRangeIds(blocks, startBlockId, endBlockId);
  if (direct) {
    return direct;
  }

  for (const block of blocks) {
    if (block.type === "boxBlock") {
      const nested = resolveTextFlowBlockRangeIdsInBoxChildren(block.blocks, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    } else if (block.type === "layoutSection") {
      const nested = resolveTextFlowBlockRangeIdsInLayoutChildren(block.children, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function resolveTextFlowBlockRangeIdsInLayoutChildren(
  blocks: readonly LayoutSectionChildBlock[],
  startBlockId: string,
  endBlockId: string,
): string[] | null {
  // 既存layoutSectionの直下をさらに段組みにはしない。そこに含まれるboxBlock内だけは
  // wrapTextFlowBlocksInLayoutSectionの既存探索規則と同じように対象にできる。
  for (const block of blocks) {
    if (block.type === "boxBlock") {
      const nested = resolveTextFlowBlockRangeIdsInBoxChildren(block.blocks, startBlockId, endBlockId);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function wrapBlocksInLayoutSectionInContent(
  blocks: SigmaBlock[],
  blockIds: readonly string[],
  columnCount: number,
  columnGapMm: number,
): { blocks: SigmaBlock[]; changed: boolean } {
  const blockIdSet = new Set(blockIds);
  const contiguous = findContiguousLayoutSectionChildSelection(blocks, blockIdSet);
  if (contiguous) {
    return {
      blocks: [
        ...blocks.slice(0, contiguous.start),
        createLayoutSection(contiguous.children, columnCount, columnGapMm),
        ...blocks.slice(contiguous.end),
      ],
      changed: true,
    };
  }

  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!changed && block.type === "problem") {
      const result = wrapBlocksInLayoutSectionInProblemAreaBlocks(block.solution, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, solution: result.blocks };
      }
    }

    if (!changed && block.type === "boxBlock") {
      const result = wrapBlocksInLayoutSectionInBoxChildren(block.blocks, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, blocks: result.blocks };
      }
    }

    if (!changed && block.type === "layoutSection") {
      const result = wrapBlocksInLayoutSectionInLayoutChildren(block.children, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, children: result.blocks };
      }
    }

    return block;
  });

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function wrapBlocksInLayoutSectionInProblemAreaBlocks(
  blocks: ProblemAreaBlock[],
  blockIds: readonly string[],
  columnCount: number,
  columnGapMm: number,
): { blocks: ProblemAreaBlock[]; changed: boolean } {
  const blockIdSet = new Set(blockIds);
  const contiguous = findContiguousLayoutSectionChildSelection(blocks, blockIdSet);
  if (contiguous) {
    return {
      blocks: [
        ...blocks.slice(0, contiguous.start),
        createLayoutSection(contiguous.children, columnCount, columnGapMm),
        ...blocks.slice(contiguous.end),
      ],
      changed: true,
    };
  }

  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!changed && block.type === "layoutSection") {
      const result = wrapBlocksInLayoutSectionInLayoutChildren(block.children, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, children: result.blocks };
      }
    }
    return block;
  });

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function wrapBlocksInLayoutSectionInBoxChildren(
  blocks: BoxBlockChildBlock[],
  blockIds: readonly string[],
  columnCount: number,
  columnGapMm: number,
): { blocks: BoxBlockChildBlock[]; changed: boolean } {
  const blockIdSet = new Set(blockIds);
  const contiguous = findContiguousLayoutSectionChildSelection(blocks, blockIdSet);
  if (contiguous) {
    return {
      blocks: [
        ...blocks.slice(0, contiguous.start),
        createLayoutSection(contiguous.children, columnCount, columnGapMm),
        ...blocks.slice(contiguous.end),
      ],
      changed: true,
    };
  }

  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!changed && block.type === "layoutSection") {
      const result = wrapBlocksInLayoutSectionInLayoutChildren(block.children, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, children: result.blocks };
      }
    }

    if (!changed && block.type === "boxBlock") {
      const result = wrapBlocksInLayoutSectionInBoxChildren(block.blocks, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, blocks: result.blocks };
      }
    }

    return block;
  });

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function wrapBlocksInLayoutSectionInLayoutChildren(
  blocks: LayoutSectionChildBlock[],
  blockIds: readonly string[],
  columnCount: number,
  columnGapMm: number,
): { blocks: LayoutSectionChildBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!changed && block.type === "boxBlock") {
      const result = wrapBlocksInLayoutSectionInBoxChildren(block.blocks, blockIds, columnCount, columnGapMm);
      if (result.changed) {
        changed = true;
        return { ...block, blocks: result.blocks };
      }
    }
    return block;
  });

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function findContiguousLayoutSectionChildSelection<T extends SigmaBlock | ProblemAreaBlock | BoxBlockChildBlock>(
  blocks: readonly T[],
  blockIds: ReadonlySet<string>,
): { start: number; end: number; children: LayoutSectionChildBlock[] } | null {
  if (blockIds.size === 0) {
    return null;
  }

  const indexes = blocks
    .map((block, index) => blockIds.has(block.id) && isLayoutSectionChildBlock(block) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length === 0 || indexes.length !== blockIds.size) {
    return null;
  }

  const start = Math.min(...indexes);
  const end = Math.max(...indexes) + 1;
  if (end - start !== indexes.length) {
    return null;
  }

  const children: LayoutSectionChildBlock[] = [];
  for (const block of blocks.slice(start, end)) {
    if (!isLayoutSectionChildBlock(block)) {
      return null;
    }
    children.push(block);
  }

  return { start, end, children };
}

export function unwrapLayoutSection(document: SigmaDocument, sectionId: string): SigmaDocument {
  const result = unwrapLayoutSectionInContent(document.content, sectionId);
  if (!result.changed) {
    return document;
  }

  return {
    ...document,
    content: result.blocks,
    updatedAt: new Date().toISOString(),
  };
}

function layoutSectionChildrenForUnwrap(section: LayoutSectionNode): LayoutSectionNode["children"] {
  const nonEmpty = section.children.filter((child) => !(
    child.type === "paragraph"
    && child.children.every((inline) => inline.type === "text" && inline.text.length === 0)
  ));
  return nonEmpty.length > 0 ? nonEmpty : section.children.slice(0, 1);
}

function unwrapLayoutSectionInContent(
  blocks: SigmaBlock[],
  sectionId: string,
): { blocks: SigmaBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks: SigmaBlock[] = [];

  for (const block of blocks) {
    if (!changed && block.type === "problem") {
      const result = unwrapLayoutSectionInProblemAreaBlocks(block.solution, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, solution: result.blocks });
        changed = true;
        continue;
      }
    }

    if (!changed && block.type === "layoutSection" && block.id === sectionId) {
      nextBlocks.push(...layoutSectionChildrenForUnwrap(block) as ProblemAreaBlock[]);
      changed = true;
      continue;
    }

    if (!changed && block.type === "boxBlock") {
      const result = unwrapLayoutSectionInBoxChildren(block.blocks, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, blocks: result.blocks });
        changed = true;
        continue;
      }
    }

    if (!changed && block.type === "layoutSection") {
      const result = unwrapLayoutSectionInLayoutChildren(block.children, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, children: result.blocks });
        changed = true;
        continue;
      }
    }

    nextBlocks.push(block);
  }

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function unwrapLayoutSectionInProblemAreaBlocks(
  blocks: ProblemAreaBlock[],
  sectionId: string,
): { blocks: ProblemAreaBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks: ProblemAreaBlock[] = [];

  for (const block of blocks) {
    if (!changed && block.type === "layoutSection" && block.id === sectionId) {
      nextBlocks.push(...(layoutSectionChildrenForUnwrap(block) as ProblemAreaBlock[]));
      changed = true;
      continue;
    }

    if (!changed && block.type === "layoutSection") {
      const result = unwrapLayoutSectionInLayoutChildren(block.children, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, children: result.blocks });
        changed = true;
        continue;
      }
    }

    nextBlocks.push(block);
  }

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function unwrapLayoutSectionInBoxChildren(
  blocks: BoxBlockChildBlock[],
  sectionId: string,
): { blocks: BoxBlockChildBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks: BoxBlockChildBlock[] = [];

  for (const block of blocks) {
    if (!changed && block.type === "layoutSection" && block.id === sectionId) {
      nextBlocks.push(...layoutSectionChildrenForUnwrap(block));
      changed = true;
      continue;
    }

    if (!changed && block.type === "layoutSection") {
      const result = unwrapLayoutSectionInLayoutChildren(block.children, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, children: result.blocks });
        changed = true;
        continue;
      }
    }

    if (!changed && block.type === "boxBlock") {
      const result = unwrapLayoutSectionInBoxChildren(block.blocks, sectionId);
      if (result.changed) {
        nextBlocks.push({ ...block, blocks: result.blocks });
        changed = true;
        continue;
      }
    }

    nextBlocks.push(block);
  }

  return { blocks: changed ? nextBlocks : blocks, changed };
}

function unwrapLayoutSectionInLayoutChildren(
  blocks: LayoutSectionChildBlock[],
  sectionId: string,
): { blocks: LayoutSectionChildBlock[]; changed: boolean } {
  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!changed && block.type === "boxBlock") {
      const result = unwrapLayoutSectionInBoxChildren(block.blocks, sectionId);
      if (result.changed) {
        changed = true;
        return { ...block, blocks: result.blocks };
      }
    }
    return block;
  });

  return { blocks: changed ? nextBlocks : blocks, changed };
}

export function isTopLevelTextFlowBlock(block: SigmaBlock): block is TopLevelTextFlowBlock {
  return block.type === "section" || block.type === "heading" || block.type === "paragraph" || block.type === "list" || block.type === "boxBlock";
}

function getTopLevelInsertIndex(content: SigmaBlock[], afterBlockId: string | null): number {
  if (!afterBlockId) {
    return content.length;
  }

  const directIndex = content.findIndex((item) => item.id === afterBlockId);
  if (directIndex >= 0) {
    return directIndex + 1;
  }

  const ownerIndex = content.findIndex((item) => (
    (item.type === "problem" && problemContainsRichBlock(item, afterBlockId)) ||
    (item.type === "layoutSection" && layoutSectionContainsBlock(item, afterBlockId))
  ));
  return ownerIndex >= 0 ? ownerIndex + 1 : content.length;
}

export function isEmptyTopLevelTextFlowBlock(block: SigmaBlock): boolean {
  if (block.type === "section") {
    return block.title.trim().length === 0;
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return areInlineNodesEmpty(block.children);
  }
  if (block.type === "list") {
    return !listHasContent(block);
  }
  if (block.type === "boxBlock") {
    return block.blocks.every(isEmptyBoxBlockChild) && areInlineNodesEmpty(block.title ?? []);
  }
  if (block.type === "quote") {
    return block.blocks.every(isEmptyRichBlock);
  }
  return false;
}

function areInlineNodesEmpty(children: InlineNode[]): boolean {
  return children.every((child) => child.type === "text"
    ? child.text.trim().length === 0
    : child.tex.trim().length === 0);
}

function problemContainsRichBlock(problem: ProblemNode, blockId: string): boolean {
  return getProblemAreaContainingRichBlock(problem, blockId) !== null;
}

function getProblemAreaContainingRichBlock(problem: ProblemNode, blockId: string): ProblemAreaKind | null {
  for (const area of PROBLEM_AREA_ORDER) {
    if (problem[area].some((block) => richBlockContainsId(block, blockId))) {
      return area;
    }
  }
  return null;
}

export function addRichBlockToProblem(
  document: SigmaDocument,
  problemId: string,
  area: ProblemAreaKind,
  block: RichBlock,
): SigmaDocument {
  return updateBlockInDocument(document, problemId, (node) => {
    if (node.type !== "problem") {
      return node;
    }

    return {
      ...node,
      [area]: [...node[area], block],
    };
  });
}

export function insertRichBlockNearSelection(
  document: SigmaDocument,
  selectedId: string | null,
  block: ProblemAreaBlock,
): SigmaDocument | null {
  if (!selectedId) {
    return null;
  }

  let inserted = false;
  const content = document.content.map((item) => {
    if (item.type === "problem") {
      if (item.id === selectedId) {
        inserted = true;
        return {
          ...item,
          prompt: [...item.prompt, block],
        };
      }

      const lead = insertAfterRichBlock(item.lead, selectedId, block);
      if (lead) {
        inserted = true;
        return { ...item, lead };
      }

      const prompt = insertAfterRichBlock(item.prompt, selectedId, block);
      if (prompt) {
        inserted = true;
        return { ...item, prompt };
      }

      const solution = insertAfterRichBlock(item.solution, selectedId, block);
      if (solution) {
        inserted = true;
        return { ...item, solution };
      }

      const hints = insertAfterRichBlock(item.hints, selectedId, block);
      if (hints) {
        inserted = true;
        return { ...item, hints };
      }
    }

    return item;
  });

  return inserted
    ? {
        ...document,
        content,
        updatedAt: new Date().toISOString(),
      }
    : null;
}

function insertAfterRichBlock<T extends ProblemAreaBlock>(blocks: T[], selectedId: string, block: ProblemAreaBlock): T[] | null {
  const index = blocks.findIndex((item) => richBlockContainsId(item, selectedId));
  if (index < 0) {
    return null;
  }

  const next = [...blocks];
  next.splice(index + 1, 0, block as T);
  return next;
}

export interface RemoveBlockFromDocumentOptions {
  /** 純削除では break-before を次の兄弟へ渡す。移動の取り出しでは false にする。 */
  transferBreak?: boolean;
}

export function removeBlockFromDocument(
  document: SigmaDocument,
  blockId: string,
  options: RemoveBlockFromDocumentOptions = {},
): SigmaDocument {
  return {
    ...document,
    content: removeFromBlocks(document.content, blockId, options.transferBreak ?? true),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Removes any number of blocks from anywhere in the tree (top-level content, problem areas,
 * layoutSection/boxBlock children). Does not touch overlay shapes: shapes anchored to a deleted
 * block simply fall back per the existing anchor rules, they are never cascade-deleted here.
 * List items are out of scope; pass the owning list's id instead.
 */
export function deleteBlocksFromDocument(document: SigmaDocument, blockIds: string[]): SigmaDocument {
  const uniqueIds = Array.from(new Set(blockIds));

  for (const id of uniqueIds) {
    const block = findBlock(document, id);
    if (!block) {
      if (isOverlayShapeId(document, id)) {
        throw new Error(
          `AI編集: 削除対象ブロックが見つかりません(${id})。これは本文ブロックではなくoverlay図形/表のIDです。delete_shapes を使ってください。`,
        );
      }
      throw new Error(`AI編集: 削除対象ブロックが見つかりません(${id})。`);
    }
    if (block.type === "listItem") {
      throw new Error("AI編集: リスト項目単位の削除には対応していません。ブロック単位で指定してください。");
    }
  }

  let current = document;
  for (const id of uniqueIds) {
    if (!findBlock(current, id)) {
      // Already removed as a descendant of another block deleted earlier in this same batch.
      continue;
    }
    current = removeBlockFromDocument(current, id);
  }

  return current;
}

/**
 * Moves one or more blocks (need not be contiguous or share a parent) to sit immediately
 * before/after `targetId`. Supports moving between top-level content, problem areas, and
 * layoutSection/boxBlock children. Throws if the move is structurally invalid: target is one of
 * the moved blocks, target is nested inside a moved block, or a moved block's type is not allowed
 * in the target's container (e.g. moving a `problem` into a problem's `solution` area).
 */
export function moveBlocksInDocument(
  document: SigmaDocument,
  blockIds: string[],
  targetId: string,
  position: "before" | "after",
): SigmaDocument {
  const uniqueIds = Array.from(new Set(blockIds));

  if (uniqueIds.includes(targetId)) {
    throw new Error("AI編集: 移動先のtargetIdが移動対象blockIdsに含まれています。");
  }

  const movedBlocks: SigmaBlock[] = [];
  for (const id of uniqueIds) {
    const block = findBlock(document, id);
    if (!block) {
      throw new Error(`AI編集: 移動対象ブロックが見つかりません(${id})。`);
    }
    if (block.type === "listItem") {
      throw new Error("AI編集: リスト項目単位の移動には対応していません。ブロック単位で指定してください。");
    }
    movedBlocks.push(block);
  }

  if (!findBlock(document, targetId)) {
    throw new Error("AI編集: 移動先のブロックが見つかりません。");
  }

  for (const block of movedBlocks) {
    if (blockSubtreeContainsId(block, targetId)) {
      throw new Error("AI編集: 移動先が移動対象ブロックの内部にあります。");
    }
  }

  let working = document;
  const extracted: SigmaBlock[] = [];
  for (const id of uniqueIds) {
    const block = findBlock(working, id);
    if (!block || block.type === "listItem") {
      throw new Error(`AI編集: 移動対象ブロックが見つかりません(${id})。`);
    }
    extracted.push(block);
    working = removeBlockFromDocument(working, id, { transferBreak: false });
  }

  const nextContent = insertBlocksNearTarget(working.content, targetId, extracted, position);
  if (!nextContent) {
    throw new Error("AI編集: 移動先のブロックが見つかりません。");
  }

  const moved = {
    ...working,
    content: nextContent,
    updatedAt: new Date().toISOString(),
  };
  return dropInvalidMovedBreaks(moved, extracted.map((block) => block.id));
}

/** 移動先で表示できない break-before だけを落とす。移動した subtree 内部の区切りは触らない。 */
function dropInvalidMovedBreaks(document: SigmaDocument, movedBlockIds: readonly string[]): SigmaDocument {
  let next = document;
  for (const blockId of movedBlockIds) {
    const block = findBlock(next, blockId);
    if (!block || block.type === "listItem" || block.pagination?.break !== true) {
      continue;
    }
    const layoutSection = findContainingLayoutSection(next, blockId);
    const containingBox = findContainingBoxBlock(next, blockId);
    const isFirstLayoutChild = layoutSection?.children[0]?.id === blockId;
    const isAllowedBoxColumnBreak = !!layoutSection
      && layoutSection.layout.columnCount > 1
      && findContainingBoxBlock(next, layoutSection.id)?.id === containingBox?.id;
    if (isFirstLayoutChild || (containingBox && !isAllowedBoxColumnBreak)) {
      next = updateBlockInDocument(next, blockId, (current) => {
        if (current.type === "listItem") {
          return current;
        }
        const pagination = { ...(current.pagination ?? {}) };
        delete pagination.break;
        return {
          ...current,
          pagination: Object.keys(pagination).length > 0 ? pagination : undefined,
        };
      });
    }
  }
  return next;
}

function blockSubtreeContainsId(block: SigmaBlock, id: string): boolean {
  if (block.id === id) {
    return true;
  }
  if (block.type === "list") {
    return block.items.some((item) => listItemSubtreeContainsId(item, id));
  }
  if (block.type === "problem") {
    return PROBLEM_AREA_ORDER
      .some((area) => block[area].some((rich) => blockSubtreeContainsId(rich, id)));
  }
  if (block.type === "layoutSection") {
    return block.children.some((child) => blockSubtreeContainsId(child, id));
  }
  if (block.type === "boxBlock" || block.type === "quote") {
    return block.blocks.some((child) => blockSubtreeContainsId(child, id));
  }
  return false;
}

function listItemSubtreeContainsId(item: ListItemNode, id: string): boolean {
  if (item.id === id) {
    return true;
  }
  return (item.nested ?? []).some((nested) => blockSubtreeContainsId(nested, id));
}

type MoveContainerContext = "content" | "richArea" | "layoutChildren" | "boxChildren";

function isBlockAllowedInContainer(block: SigmaBlock, context: MoveContainerContext): boolean {
  if (context === "content") {
    return true;
  }
  if (context === "richArea") {
    return block.type === "heading" || block.type === "paragraph" || block.type === "list";
  }
  if (context === "layoutChildren") {
    return block.type === "section" || block.type === "heading" || block.type === "paragraph" || block.type === "list" || block.type === "boxBlock";
  }
  return true; // Box children share SigmaDoc's full block union.
}

function assertBlocksAllowedInContainer(blocks: SigmaBlock[], context: MoveContainerContext): void {
  for (const block of blocks) {
    if (!isBlockAllowedInContainer(block, context)) {
      throw new Error(`AI編集: ${getMoveContainerLabel(context)}には${block.type}を配置できません。`);
    }
  }
}

function getMoveContainerLabel(context: MoveContainerContext): string {
  if (context === "richArea") {
    return "問題エリア";
  }
  if (context === "layoutChildren") {
    return "段組";
  }
  if (context === "boxChildren") {
    return "ボックス";
  }
  return "本文";
}

function spliceBlocksAtTarget<T extends { id: string }>(
  list: T[],
  targetId: string,
  newBlocks: T[],
  position: "before" | "after",
): T[] | null {
  const index = list.findIndex((item) => item.id === targetId);
  if (index < 0) {
    return null;
  }

  const next = [...list];
  next.splice(position === "before" ? index : index + 1, 0, ...newBlocks);
  return next;
}

function insertBlocksNearTarget(
  content: SigmaBlock[],
  targetId: string,
  newBlocks: SigmaBlock[],
  position: "before" | "after",
): SigmaBlock[] | null {
  const direct = spliceBlocksAtTarget(content, targetId, newBlocks, position);
  if (direct) {
    return direct;
  }

  let found = false;
  const next = content.map((block) => {
    if (found) {
      return block;
    }

    if (block.type === "problem") {
      for (const area of PROBLEM_AREA_ORDER) {
        const result = spliceBlocksAtTarget(block[area], targetId, newBlocks as RichBlock[], position);
        if (result) {
          assertBlocksAllowedInContainer(newBlocks, "richArea");
          found = true;
          return { ...block, [area]: result };
        }
      }
      return block;
    }

    if (block.type === "layoutSection") {
      const directTarget = block.children.some((child) => child.id === targetId);
      const result = insertBlocksNearTargetInLayoutChildren(block.children, targetId, newBlocks, position);
      if (result) {
        found = true;
        return {
          ...block,
          layout: directTarget && position === "before" && block.layout.columnStartIds?.includes(targetId)
            ? { ...block.layout, columnStartIds: block.layout.columnStartIds.map((id) => id === targetId ? newBlocks[0].id : id) }
            : block.layout,
          children: result,
        };
      }
      return block;
    }

    if (block.type === "boxBlock") {
      const result = insertBlocksNearTargetInBoxChildren(block.blocks, targetId, newBlocks, position);
      if (result) {
        found = true;
        return { ...block, blocks: result };
      }
      return block;
    }

    return block;
  });

  return found ? next : null;
}

function insertBlocksNearTargetInLayoutChildren(
  children: LayoutSectionChildBlock[],
  targetId: string,
  newBlocks: SigmaBlock[],
  position: "before" | "after",
): LayoutSectionChildBlock[] | null {
  const direct = spliceBlocksAtTarget(children, targetId, newBlocks as LayoutSectionChildBlock[], position);
  if (direct) {
    assertBlocksAllowedInContainer(newBlocks, "layoutChildren");
    return direct;
  }

  let found = false;
  const next = children.map((block) => {
    if (found || block.type !== "boxBlock") {
      return block;
    }
    const result = insertBlocksNearTargetInBoxChildren(block.blocks, targetId, newBlocks, position);
    if (result) {
      found = true;
      return { ...block, blocks: result };
    }
    return block;
  });

  return found ? next : null;
}

function insertBlocksNearTargetInBoxChildren(
  blocks: BoxBlockChildBlock[],
  targetId: string,
  newBlocks: SigmaBlock[],
  position: "before" | "after",
): BoxBlockChildBlock[] | null {
  const direct = spliceBlocksAtTarget(blocks, targetId, newBlocks as BoxBlockChildBlock[], position);
  if (direct) {
    assertBlocksAllowedInContainer(newBlocks, "boxChildren");
    return direct;
  }

  let found = false;
  const next = blocks.map((block) => {
    if (found) {
      return block;
    }
    if (block.type === "layoutSection") {
      const directTarget = block.children.some((child) => child.id === targetId);
      const result = insertBlocksNearTargetInLayoutChildren(block.children, targetId, newBlocks, position);
      if (result) {
        found = true;
        return {
          ...block,
          layout: directTarget && position === "before" && block.layout.columnStartIds?.includes(targetId)
            ? { ...block.layout, columnStartIds: block.layout.columnStartIds.map((id) => id === targetId ? newBlocks[0].id : id) }
            : block.layout,
          children: result,
        };
      }
    }
    if (block.type === "boxBlock") {
      const result = insertBlocksNearTargetInBoxChildren(block.blocks, targetId, newBlocks, position);
      if (result) {
        found = true;
        return { ...block, blocks: result };
      }
    }
    return block;
  });

  return found ? next : null;
}

export function duplicateTopLevelBlock(document: SigmaDocument, blockId: string): SigmaDocument {
  const index = document.content.findIndex((block) => block.id === blockId);
  if (index < 0) {
    return document;
  }

  const copy = regenerateIds(document.content[index]) as SigmaBlock;
  const content = [...document.content];
  content.splice(index + 1, 0, copy);

  return {
    ...document,
    content,
    updatedAt: new Date().toISOString(),
  };
}

export function moveTopLevelBlock(
  document: SigmaDocument,
  blockId: string,
  direction: "up" | "down",
): SigmaDocument {
  const index = document.content.findIndex((block) => block.id === blockId);
  const nextIndex = direction === "up" ? index - 1 : index + 1;

  if (index < 0 || nextIndex < 0 || nextIndex >= document.content.length) {
    return document;
  }

  const content = [...document.content];
  const [block] = content.splice(index, 1);
  content.splice(nextIndex, 0, block);

  return {
    ...document,
    content,
    updatedAt: new Date().toISOString(),
  };
}

export interface SigmaDocOutlineEntry {
  id: string;
  title: string;
  type: SigmaBlock["type"];
  /** Short plain-text excerpt (≤60 chars, math rendered as its TeX). Only set for body-content entries. */
  excerpt?: string;
  /** Id of the nearest enclosing problem/layoutSection/boxBlock, when this entry is not top-level. */
  parentId?: string;
}

export interface CollectOutlineOptions {
  /**
   * ブロック種別の表示名を引く翻訳関数。省略時は日本語。
   * **AI / MCP の呼び出しは省略する**のが正しい (モデルへ渡す構造の安定を優先する)。
   */
  t?: Translate<"editor">;
  /**
   * When true, also emit entries for paragraph/list/boxBlock blocks (top-level and nested inside
   * problem lead/prompt/hints/solution and layoutSection/boxBlock children) so AI tooling can
   * address body content by id. Defaults to false to keep the human-facing outline UI unchanged
   * (it only expects section/heading/layoutSection/problem entries).
   */
  includeBodyBlocks?: boolean;
  /** Human outline only: include section headings that live directly in a layout section. */
  includeLayoutHeadings?: boolean;
}

const OUTLINE_EXCERPT_MAX_LENGTH = 60;

export function collectOutline(document: SigmaDocument, options?: CollectOutlineOptions): SigmaDocOutlineEntry[] {
  const includeBodyBlocks = options?.includeBodyBlocks ?? false;
  const includeLayoutHeadings = options?.includeLayoutHeadings ?? false;
  const t = options?.t ?? createTranslator(DEFAULT_LOCALE, "editor");
  let problemCount = 0;
  const outline: SigmaDocOutlineEntry[] = [];

  for (const block of document.content) {
    if (block.type === "section") {
      outline.push({ id: block.id, title: block.title || t("block.section"), type: block.type });
      continue;
    }

    if (block.type === "heading") {
      outline.push({
        id: block.id,
        title: block.children.map((child) => ("text" in child ? child.text : "")).join("") || t("block.heading"),
        type: block.type,
      });
      continue;
    }

    if (block.type === "layoutSection") {
      outline.push({
        id: block.id,
        title: t("block.columns", { columns: block.layout.columnCount }),
        type: block.type,
      });
      if (includeBodyBlocks) {
        collectBodyOutlineEntries(block.children, block.id, outline, t);
      } else if (includeLayoutHeadings) {
        for (const child of block.children) {
          if (child.type === "heading") {
            outline.push({
              id: child.id,
              title: child.children.map((node) => ("text" in node ? node.text : "")).join("") || t("block.heading"),
              type: child.type,
            });
          }
        }
      }
      continue;
    }

    if (block.type === "problem") {
      problemCount += 1;
      outline.push({ id: block.id, title: t("outline.problem", { number: problemCount }), type: block.type });
      if (includeBodyBlocks) {
        collectProblemBodyOutlineEntries(block, outline, t);
      }
      continue;
    }

    if (includeBodyBlocks && (block.type === "paragraph" || block.type === "list" || block.type === "boxBlock")) {
      outline.push(createBodyOutlineEntry(block, t));
      if (block.type === "boxBlock") {
        collectBodyOutlineEntries(block.blocks, block.id, outline, t);
      }
    }
  }

  return outline;
}

function collectProblemBodyOutlineEntries(
  problem: ProblemNode,
  outline: SigmaDocOutlineEntry[],
  t: Translate<"editor">,
): void {
  for (const area of PROBLEM_AREA_ORDER) {
    for (const richBlock of problem[area]) {
      if (richBlock.type === "paragraph" || richBlock.type === "list") {
        outline.push(createBodyOutlineEntry(richBlock, t, problem.id));
      }
    }
  }
}

function collectBodyOutlineEntries(
  blocks: BoxBlockChildBlock[],
  parentId: string,
  outline: SigmaDocOutlineEntry[],
  t: Translate<"editor">,
): void {
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "list") {
      outline.push(createBodyOutlineEntry(block, t, parentId));
      continue;
    }

    if (block.type === "boxBlock") {
      outline.push(createBodyOutlineEntry(block, t, parentId));
      collectBodyOutlineEntries(block.blocks, block.id, outline, t);
      continue;
    }

    if (block.type === "layoutSection") {
      outline.push({
        id: block.id,
        title: t("block.columns", { columns: block.layout.columnCount }),
        type: block.type,
        parentId,
      });
      collectBodyOutlineEntries(block.children, block.id, outline, t);
    }
  }
}

function createBodyOutlineEntry(
  block: ParagraphNode | ListNode | BoxBlockNode,
  t: Translate<"editor">,
  parentId?: string,
): SigmaDocOutlineEntry {
  const excerpt = truncateOutlineExcerpt(bodyOutlineBlockText(block));
  const title = block.type === "paragraph"
    ? t("outline.paragraph")
    : block.type === "list"
      ? t("outline.list")
      : (inlineNodesToPlainText(block.title ?? []).trim() || t("outline.box"));

  return {
    id: block.id,
    title,
    type: block.type,
    ...(excerpt ? { excerpt } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function bodyOutlineBlockText(block: ParagraphNode | ListNode | BoxBlockNode): string {
  if (block.type === "paragraph") {
    return inlineNodesToPlainText(block.children);
  }
  if (block.type === "list") {
    return block.items.map((item) => [
      inlineNodesToPlainText(item.children),
      ...(item.continuations ?? []).map((continuation) => inlineNodesToPlainText(listItemContinuationInlineNodes(continuation))),
    ].filter(Boolean).join(" ")).join(" / ");
  }
  return inlineNodesToPlainText(block.title ?? []);
}

function truncateOutlineExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= OUTLINE_EXCERPT_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, OUTLINE_EXCERPT_MAX_LENGTH - 1)}…`;
}

export interface SigmaDocOverlayShapeOutlineEntry {
  id: string;
  type: OverlayShape["type"];
  /** Short human-readable description (text content, table dimensions, graph title, etc). Truncated. */
  description: string;
  /** Id of the block this shape is anchored to, when anchor.type === "block". */
  anchorBlockId?: string;
  /** Id of the enclosing group shape, for grouped children. */
  parentId?: string;
  /**
   * 保存済みの絶対ページ座標 (図形左上)。insert_shape / update_shape の x/y と同じ
   * 座標系なので、AIが既存図形を基準に新しい図形の座標を決められる。
   */
  x: number;
  y: number;
}

/** 図形種別の辞書キー。文言は `shape.shapeKind.*` が持つ。 */
const OVERLAY_GEO_KEYS = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "pentagon",
  "regularPolygon",
  "blockArrow",
] as const;

/** Whether `id` matches an overlay shape (図形/表/グラフ) rather than a body block. */
export function isOverlayShapeId(document: SigmaDocument, id: string): boolean {
  const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  return snapshot.shapes.some((shape) => shape.id === id);
}

/**
 * Enumerates every overlay shape (図形・表・グラフ) with its id, type, short description, and
 * anchor/group relationships. This is the only place shape/table ids are surfaced to AI tooling
 * for targeting delete_shapes / update_shape / align_shapes — get_document_outline exposes this
 * via `overlayShapes`. Kept compact (truncated descriptions) since outlines are read often.
 */
/**
 * 図形の一覧。**現状の呼び出し元は MCP (AI) だけ**なので `t` の既定は日本語にしてある
 * (`collectOutline` と同じ規約 — モデルへ渡す構造を言語で揺らさない)。画面に出す面が
 * できたら、そこは表示言語の `t` を渡すこと。
 */
export function collectOverlayShapeOutline(
  document: SigmaDocument,
  t: Translate<"shape"> = createTranslator(DEFAULT_LOCALE, "shape"),
): SigmaDocOverlayShapeOutlineEntry[] {
  const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  return snapshot.shapes.map((shape) => ({
    id: shape.id,
    type: shape.type,
    description: describeOverlayShape(shape, t),
    ...(shape.anchor?.type === "block" ? { anchorBlockId: shape.anchor.blockId } : {}),
    ...(shape.parentId ? { parentId: shape.parentId } : {}),
    x: shape.x,
    y: shape.y,
  }));
}

function describeOverlayShape(shape: OverlayShape, t: Translate<"shape">): string {
  switch (shape.type) {
    case "tableShape":
      return describeTableShape(shape, t);
    case "graph2dShape": {
      const title = shape.props.spec.title?.trim();
      return title
        ? t("shapeKind.graphTitled", { title: truncateOutlineExcerpt(title), kind: shape.props.spec.kind })
        : t("shapeKind.graph", { kind: shape.props.spec.kind });
    }
    case "graph3dShape":
      return `3D教材 (${shape.props.spec.objects.length}オブジェクト)`;
    case "chartShape": {
      const title = shape.props.spec.title?.trim();
      return title
        ? t("shapeKind.chartTitled", { title: truncateOutlineExcerpt(title) })
        : t("shapeKind.chart");
    }
    case "text": {
      const text = inlineNodesToPlainText(overlayTextBlocksToInlineNodes(shape.props.blocks));
      return truncateOutlineExcerpt(text) || t("shapeKind.emptyText");
    }
    case "group":
      return shape.props.name?.trim() || t("shapeKind.group");
    case "geo":
      return describeLabeledShapeKind(
        shape.props.geo === "regularPolygon"
          ? t("shapeKind.regularPolygonSides", { sides: shape.props.polygonSides ?? 5 })
          : (OVERLAY_GEO_KEYS as readonly string[]).includes(shape.props.geo)
            ? t(`shapeKind.${shape.props.geo}` as never) as string
            : shape.props.geo,
        shape.props.label,
        t,
      );
    case "arrow":
      return describeLabeledShapeKind(t("shapeKind.arrow"), shape.props.label, t);
    case "line":
      return describeLabeledShapeKind(
        shape.props.kind === "curve"
          ? t("shapeKind.curve")
          : shape.props.kind === "freehand" ? t("shapeKind.freehand") : t("shapeKind.polyline"),
        shape.props.label,
        t,
      );
    case "arc":
      return shape.props.kind === "sector" ? t("shapeKind.sector") : t("shapeKind.arc");
    case "image":
      return t("shapeKind.image");
    case "callout":
      return t("shapeKind.callout");
  }
}

function describeLabeledShapeKind(
  kindLabel: string,
  label: string | undefined,
  t: Translate<"shape">,
): string {
  const trimmed = label?.trim();
  return trimmed
    ? t("shapeKind.labelled", { kind: kindLabel, label: truncateOutlineExcerpt(trimmed) })
    : kindLabel;
}

function describeTableShape(shape: OverlayTableShape, t: Translate<"shape">): string {
  const table = shape.props.table;
  const rows = table.rows.length;
  const columns = table.columns.length;
  const snippet = firstNonEmptyTableCellText(table);
  return snippet
    ? t("shapeKind.tableWithText", { rows, columns, text: truncateOutlineExcerpt(snippet) })
    : t("shapeKind.table", { rows, columns });
}

function firstNonEmptyTableCellText(table: SigmaTableSpec): string {
  const rowOrder = new Map(table.rows.map((row, index) => [row.id, index]));
  const columnOrder = new Map(table.columns.map((column, index) => [column.id, index]));
  const orderedCells = [...table.cells].sort((a, b) => {
    const rowDelta = (rowOrder.get(a.rowId) ?? 0) - (rowOrder.get(b.rowId) ?? 0);
    if (rowDelta !== 0) {
      return rowDelta;
    }
    return (columnOrder.get(a.columnId) ?? 0) - (columnOrder.get(b.columnId) ?? 0);
  });

  for (const cell of orderedCells) {
    for (const content of cell.content) {
      // The projection, not `content.children`: this snippet names the table in the outline, and a
      // label reading `=SUM(B2:B3)` where every drawing surface shows `30` describes a table the
      // user cannot see. (Search, AI and import deliberately keep reading the source instead.)
      const text = content.type === "trend"
        ? inlineNodesToPlainText(content.label ?? [])
        : inlineNodesToPlainText(getTableCellDisplayNodes(table, cell, content));
      const trimmed = text.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

function updateBlocks(
  blocks: SigmaBlock[],
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): SigmaBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    const updated = updateBlock(block, blockId, updater) as SigmaBlock;
    changed ||= updated !== block;
    return updated;
  });
  return changed ? next : blocks;
}

function updateRichBlocks<T extends ProblemAreaBlock>(
  blocks: T[],
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): T[] {
  let changed = false;
  const next = blocks.map((block) => {
    const updated = updateBlock(block, blockId, updater) as T;
    changed ||= updated !== block;
    return updated;
  });
  return changed ? next : blocks;
}

function updateBoxBlockChildren(
  blocks: BoxBlockChildBlock[],
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): BoxBlockChildBlock[] {
  let changed = false;
  const next: BoxBlockChildBlock[] = [];
  for (const block of blocks) {
    const updated = updateBlock(block, blockId, updater);
    if (updated !== block) {
      changed = true;
    }
    if (isBoxBlockChildBlock(updated)) {
      next.push(updated);
    } else {
      changed = true;
    }
  }
  return changed ? next : blocks;
}

function updateBlock(
  block: EditableBlock,
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): EditableBlock {
  const current = block.id === blockId ? updater(block) : block;

  if (current.type === "problem") {
    const lead = updateRichBlocks(current.lead, blockId, updater);
    const prompt = updateRichBlocks(current.prompt, blockId, updater);
    const solution = updateRichBlocks(current.solution, blockId, updater);
    const hints = updateRichBlocks(current.hints, blockId, updater);
    if (current === block && lead === current.lead && prompt === current.prompt && solution === current.solution && hints === current.hints) {
      return block;
    }
    return { ...current, lead, prompt, solution, hints } satisfies ProblemNode;
  }

  if (current.type === "layoutSection") {
    const children = updateLayoutSectionChildren(current.children, blockId, updater);
    if (current === block && children === current.children) {
      return block;
    }
    return { ...current, children } satisfies LayoutSectionNode;
  }

  if (current.type === "boxBlock") {
    const blocks = updateBoxBlockChildren(current.blocks, blockId, updater);
    if (current === block && blocks === current.blocks) {
      return block;
    }
    return { ...current, blocks } satisfies BoxBlockNode;
  }

  if (current.type === "quote") {
    const blocks = updateQuoteChildren(current.blocks, blockId, updater);
    if (current === block && blocks === current.blocks) {
      return block;
    }
    return { ...current, blocks } satisfies QuoteBlockNode;
  }

  if (current.type === "list") {
    let changed = current !== block;
    const items: ListItemNode[] = [];
    for (const item of current.items) {
      const updated = updateListItem(item, blockId, updater);
      if (updated !== item) {
        changed = true;
      }
      if (updated) {
        items.push(updated);
      }
    }
    if (!changed) {
      return block;
    }
    return { ...current, items } satisfies ListNode;
  }

  return current;
}

function updateLayoutSectionChildren(
  blocks: LayoutSectionChildBlock[],
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): LayoutSectionChildBlock[] {
  let changed = false;
  const next: LayoutSectionChildBlock[] = [];
  for (const block of blocks) {
    const updated = updateBlock(block, blockId, updater);
    if (updated !== block) {
      changed = true;
    }
    if (isLayoutSectionChildBlock(updated)) {
      next.push(updated);
    } else {
      changed = true;
    }
  }
  return changed ? next : blocks;
}

function updateListItem(
  item: ListItemNode,
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): ListItemNode | null {
  const current = item.id === blockId ? updater(item) : item;
  if (current.type !== "listItem") {
    return null;
  }

  let continuations = current.continuations;
  if (current.continuations) {
    const nextContinuations = current.continuations.flatMap((continuation) => {
      const updated = updateBlock(continuation, blockId, updater);
      return updated.type === "paragraph" || updated.type === "heading" ? [updated] : [];
    });
    if (
      nextContinuations.length !== current.continuations.length ||
      nextContinuations.some((continuation, index) => continuation !== current.continuations?.[index])
    ) {
      continuations = nextContinuations;
    }
  }
  const nested = current.nested ? updateRichBlocks(current.nested, blockId, updater) as ListNode[] : undefined;
  if (current === item && continuations === current.continuations && nested === current.nested) {
    return item;
  }

  return { ...current, continuations, nested };
}

/**
 * Single shared traversal used by both `findBlock` and `collectBlocksById`: every top-level block,
 * plus (recursively) problem.lead/prompt/solution/hints, layoutSection.children, boxBlock.blocks and
 * list items. A generator so `findBlock` can still short-circuit on first match instead of always
 * walking the whole document.
 */
function* walkBlocksDeep(blocks: readonly SigmaBlock[]): Generator<EditableBlock> {
  for (const block of blocks) {
    yield* walkBlockDeep(block);
  }
}

function* walkBlockDeep(block: SigmaBlock): Generator<EditableBlock> {
  yield block;

  if (block.type === "list") {
    yield* walkListDeep(block);
    return;
  }

  if (block.type === "problem") {
    yield* walkBlocksDeep(block.lead);
    yield* walkBlocksDeep(block.prompt);
    yield* walkBlocksDeep(block.solution);
    yield* walkBlocksDeep(block.hints);
    return;
  }

  if (block.type === "layoutSection") {
    yield* walkBlocksDeep(block.children);
    return;
  }

  if (block.type === "boxBlock") {
    yield* walkBlocksDeep(block.blocks);
    return;
  }

  // 引用の中身も走る。ここを抜くと引用の中の段落が `findBlock` で見つからず、
  // `selectedBlock` が null になって **書式ツールバーが丸ごと無効になる**（実機で踏んだ）。
  if (block.type === "quote") {
    for (const child of block.blocks) {
      yield* walkBlockDeep(child);
    }
  }
}

function* walkListDeep(list: ListNode): Generator<EditableBlock> {
  for (const item of list.items) {
    yield item;
    for (const continuation of item.continuations ?? []) {
      yield continuation;
    }
    for (const nested of item.nested ?? []) {
      yield* walkListDeep(nested);
    }
  }
}

function containsBlockId(blocks: Generator<EditableBlock>, blockId: string): boolean {
  for (const block of blocks) {
    if (block.id === blockId) {
      return true;
    }
  }
  return false;
}

function removeFromBlocks(blocks: SigmaBlock[], blockId: string, transferBreak: boolean): SigmaBlock[] {
  return removeDirectBlock(blocks, blockId, transferBreak)
    .map((block) => {
      if (block.type === "problem") {
        return {
          ...block,
          lead: removeFromRichBlocks(block.lead, blockId, transferBreak),
          prompt: removeFromRichBlocks(block.prompt, blockId, transferBreak),
          solution: removeFromRichBlocks(block.solution, blockId, transferBreak),
          hints: removeFromRichBlocks(block.hints, blockId, transferBreak),
        };
      }

      if (block.type === "layoutSection") {
        return removeFromLayoutSection(block, blockId, transferBreak);
      }

      if (block.type === "boxBlock") {
        return {
          ...block,
          blocks: removeFromBoxBlockChildren(block.blocks, blockId, transferBreak),
        };
      }

      if (block.type === "quote") {
        return withQuoteChildren(block, removeFromQuoteChildren(block.blocks, blockId, transferBreak));
      }

      if (block.type === "list") {
        return removeFromList(block, blockId);
      }

      return block;
    })
    .filter((block) => block.type !== "list" || block.items.length > 0);
}

function removeFromLayoutSectionChildren(
  blocks: LayoutSectionChildBlock[],
  blockId: string,
  transferBreak: boolean,
): LayoutSectionChildBlock[] {
  return removeDirectBlock(blocks, blockId, transferBreak)
    .map((block) => {
      if (block.type === "list") {
        return removeFromList(block, blockId);
      }

      if (block.type === "boxBlock") {
        return {
          ...block,
          blocks: removeFromBoxBlockChildren(block.blocks, blockId, transferBreak),
        };
      }

      if (block.type === "quote") {
        return withQuoteChildren(block, removeFromQuoteChildren(block.blocks, blockId, transferBreak));
      }

      return block;
    })
    .filter((block) => block.type !== "list" || block.items.length > 0);
}

/**
 * Remove inside each persisted independent column, then rebuild the section from those columns.
 *
 * This path is used by grip deletion, AI batch deletion, and move extraction. None of them passes
 * through a TextFlowEditor/Tiptap projection, so the pre-edit `columnStartIds` must be resolved
 * here before a boundary owner disappears. Flattening first irreversibly loses that ownership.
 */
function removeFromLayoutSection(
  section: LayoutSectionNode,
  blockId: string,
  transferBreak: boolean,
): LayoutSectionNode {
  // Every deletion walks every container. Rebuilding an unrelated section is both wasteful and
  // destructive for a valid sparse section because the normal resolver cannot invent owners for
  // declared columns that currently have no child. Preserve the exact object until this section
  // actually owns the target (directly or below one of its children).
  if (!layoutSectionContainsBlock(section, blockId)) return section;

  const declaredColumnCount = Math.min(4, Math.max(1, Math.floor(section.layout.columnCount)));
  const columns = getLayoutSectionColumns(section);
  while (columns.length < declaredColumnCount) columns.push([]);
  const widths = getLayoutSectionColumnWidths(section, declaredColumnCount);
  const nextColumns = columns.map((column) => {
    const children = removeFromLayoutSectionChildren(column, blockId, transferBreak);
    return children.length > 0 ? children : [createParagraph("")];
  });
  return setLayoutSectionColumns(section, nextColumns, widths);
}

function removeFromRichBlocks<T extends ProblemAreaBlock>(blocks: T[], blockId: string, transferBreak: boolean): T[] {
  return removeDirectBlock(blocks, blockId, transferBreak)
    .map((block) => {
      if (block.type === "layoutSection") {
        return removeFromLayoutSection(block, blockId, transferBreak) as T;
      }
      if (block.type === "boxBlock") {
        return {
          ...block,
          blocks: removeFromBoxBlockChildren(block.blocks, blockId, transferBreak),
        } as T;
      }
      if (block.type === "quote") {
        return withQuoteChildren(block, removeFromQuoteChildren(block.blocks, blockId, transferBreak)) as T;
      }
      return block.type === "list" ? removeFromList(block, blockId) as T : block;
    })
    .filter((block) => block.type !== "list" || block.items.length > 0);
}

/**
 * 引用の中身を扱う小さなヘルパー。
 *
 * 引用は `boxBlock` と同じ「子ブロックの配列を持つ入れ物」だが、置ける種別が狭い
 * (`QuoteChildBlock`)。`boxBlock` 用のヘルパーは広い型を返すので、そのまま代入できない。
 * 空になったら段落を 1 つ残す — 中身の無い引用は編集面のスキーマでも作れないため。
 */
function withQuoteChildren(block: QuoteBlockNode, blocks: QuoteChildBlock[]): QuoteBlockNode {
  return { ...block, blocks: blocks.length > 0 ? blocks : [createParagraph("")] };
}

function removeFromQuoteChildren(
  blocks: QuoteChildBlock[],
  blockId: string,
  transferBreak: boolean,
): QuoteChildBlock[] {
  return removeDirectBlock(blocks, blockId, transferBreak)
    .map((block) => (block.type === "list" ? removeFromList(block, blockId) : block))
    .filter((block) => block.type !== "list" || block.items.length > 0);
}

function updateQuoteChildren(
  blocks: QuoteChildBlock[],
  blockId: string,
  updater: (block: EditableBlock) => EditableBlock,
): QuoteChildBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    const updated = updateBlock(block, blockId, updater);
    if (updated !== block) {
      changed = true;
    }
    return updated as QuoteChildBlock;
  });
  return changed ? next : blocks;
}

function removeFromBoxBlockChildren(
  blocks: BoxBlockChildBlock[],
  blockId: string,
  transferBreak: boolean,
): BoxBlockChildBlock[] {
  return removeFromBlocks(blocks, blockId, transferBreak);
}

/** ブロックそのものを消す操作では、break-before を同じ入れ物の直後の兄弟へ渡す。 */
function removeDirectBlock<
  T extends { id: string; pagination?: PaginationHints },
>(blocks: T[], blockId: string, transferBreak: boolean): T[] {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) {
    return blocks;
  }
  const removed = blocks[index];
  const next = blocks.filter((block) => block.id !== blockId);
  if (transferBreak && removed.pagination?.break === true && next[index]) {
    next[index] = {
      ...next[index],
      pagination: { ...(next[index].pagination ?? {}), break: true },
    };
  }
  return next;
}

function removeFromList(list: ListNode, blockId: string): ListNode {
  return {
    ...list,
    items: list.items
      .filter((item) => item.id !== blockId)
      .map((item) => ({
        ...item,
        continuations: item.continuations?.filter((continuation) => continuation.id !== blockId),
        nested: item.nested
          ?.filter((nested) => nested.id !== blockId)
          .map((nested) => removeFromList(nested, blockId))
          .filter((nested) => nested.items.length > 0),
      })),
  };
}

function regenerateIds(block: EditableBlock): EditableBlock {
  const cloned = structuredClone(block) as EditableBlock;
  setFreshIds(cloned);
  return cloned;
}

function setFreshIds(block: EditableBlock): void {
  block.id = createId(idPrefixForEditableBlock(block));

  if (block.type === "heading" || block.type === "paragraph") {
    refreshInlineIds(block);
  }

  if (block.type === "listItem") {
    refreshInlineIds(block);
    block.continuations?.forEach(setFreshIds);
    block.nested?.forEach(setFreshIds);
  }

  if (block.type === "list") {
    block.items.forEach(setFreshIds);
  }

  if (block.type === "problem") {
    block.lead.forEach(setFreshIds);
    block.prompt.forEach(setFreshIds);
    block.solution.forEach(setFreshIds);
    block.hints.forEach(setFreshIds);
  }

  if (block.type === "layoutSection") {
    const columns = getLayoutSectionColumns(block);
    block.children.forEach(setFreshIds);
    block.layout.columnStartIds = columns.map((column) => column[0].id);
  }

  if (block.type === "boxBlock" || block.type === "quote") {
    block.blocks.forEach(setFreshIds);
  }
}

function idPrefixForEditableBlock(block: EditableBlock): string {
  if (block.type === "list") {
    return "list";
  }
  if (block.type === "listItem") {
    return "li";
  }
  if (block.type === "paragraph") {
    return "p";
  }
  if (block.type === "layoutSection") {
    return "layout_section";
  }
  if (block.type === "boxBlock") {
    return "box";
  }
  if (block.type === "quote") {
    return "quote";
  }
  if (block.type === "codeBlock") {
    return "code";
  }
  return block.type;
}

function refreshInlineIds(block: HeadingNode | ParagraphNode | ListItemNode): void {
  for (const child of block.children) {
    if ("id" in child) {
      child.id = createId(child.type);
    }
  }
}

function richBlockContainsId(block: ProblemAreaBlock, blockId: string): boolean {
  return block.id === blockId ||
    (block.type === "layoutSection" && layoutSectionContainsBlock(block, blockId)) ||
    (block.type === "boxBlock" && containsBlockId(walkBlocksDeep(block.blocks), blockId)) ||
    (block.type === "list" && containsBlockId(walkListDeep(block), blockId));
}

function layoutSectionContainsBlock(section: LayoutSectionNode, blockId: string): boolean {
  return containsBlockId(walkBlocksDeep(section.children), blockId);
}

function isLayoutSectionChildBlock(block: EditableBlock): block is LayoutSectionChildBlock {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    || block.type === "boxBlock";
}

function isBoxBlockChildBlock(block: EditableBlock): block is BoxBlockChildBlock {
  return block.type === "problem" || block.type === "layoutSection" || isLayoutSectionChildBlock(block);
}

function listHasContent(list: ListNode): boolean {
  return list.items.some((item) =>
    !areInlineNodesEmpty(item.children) ||
    (item.continuations ?? []).some((continuation) => !areInlineNodesEmpty(listItemContinuationInlineNodes(continuation))) ||
    (item.nested ?? []).some(listHasContent),
  );
}

function isEmptyRichBlock(block: ProblemAreaBlock): boolean {
  if (block.type === "layoutSection") {
    return block.children.every(isEmptyBoxBlockChild);
  }
  if (block.type === "boxBlock") {
    return block.blocks.every(isEmptyBoxBlockChild)
      && areInlineNodesEmpty(block.title ?? []);
  }
  if (block.type === "divider") {
    // 空ではない — 空扱いすると「中身の無いブロック」を掃除する経路に黙って消される。
    return false;
  }
  if (block.type === "quote") {
    return block.blocks.every((child) => isEmptyRichBlock(child));
  }
  return block.type === "list" ? !listHasContent(block) : areInlineNodesEmpty(block.children);
}

function isEmptyBoxBlockChild(block: BoxBlockChildBlock): boolean {
  if (block.type === "problem") return false;
  if (block.type === "layoutSection") {
    return block.children.every((child) => {
      if (child.type === "section") {
        return child.title.trim().length === 0;
      }
      if (child.type === "boxBlock") {
        return child.blocks.every(isEmptyBoxBlockChild) && areInlineNodesEmpty(child.title ?? []);
      }
      return isEmptyRichBlock(child);
    });
  }
  if (block.type === "section") {
    return block.title.trim().length === 0;
  }
  if (block.type === "boxBlock") {
    return block.blocks.every(isEmptyBoxBlockChild) && areInlineNodesEmpty(block.title ?? []);
  }
  return isEmptyRichBlock(block);
}
