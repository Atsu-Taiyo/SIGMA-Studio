import { normalizeColumnRule } from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";
import { createId } from "@/lib/id";
import {
  normalizeBlockSpaceAfterPx,
  normalizeCodeBlockTheme,
  normalizeLineHeight,
  normalizeOrderedListMarkerStyle,
  inlineNodesToPlainText,
  PROBLEM_AREA_ORDER,
  type ProblemNode,
  type ProblemAreaBlock,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type BoxFrameSpec,
  type CodeBlockNode,
  type DividerNode,
  type HeadingNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListItemContinuationNode,
  type ListItemNode,
  type ListNode,
  type PaginationHints,
  type ParagraphNode,
  type QuoteBlockNode,
  type QuoteChildBlock,
  type SectionNode,
} from "@/features/document";
import {
  inlineNodesToTiptapNodes,
  tiptapNodesToInlineNodes,
  type TiptapDoc,
  type TiptapNode,
} from "@/lib/tiptap-adapter";
import { capInlineNodesForEditorLayout } from "./editor-layout-cap";
import {
  getInlineNodesEditorLength,
  getTextFlowBlockChildren,
  MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS,
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  migrateLegacyLayoutColumns,
  idPrefixForTextBlock,
  indexTextFlowBlocksById,
  isNonEmptyInlineNode,
  isOversizedLeafTextFlowBlock,
  isRecord,
  normalizeLayoutSectionColumnCount,
  normalizeNonnegativeNumber,
  normalizeTextAlign,
  preserveManualBreaksAfterTextEdit,
  setLayoutSectionColumns,
  type TextFlowBlock,
} from "@/features/text-editing";

/**
 * The editor's converter between body blocks and Tiptap's JSON. Every editing surface goes through
 * it, a shape's text included (`overlay-tiptap-adapter.ts` narrows the result, it does not convert).
 *
 */
export function textFlowToTiptap(blocks: TextFlowBlock[]): TiptapDoc {
  return {
    type: "doc",
    content: blocks.map(textFlowBlockToTiptapNode),
  };
}

export function tiptapToTextFlow(
  doc: TiptapDoc,
  previousBlocks: TextFlowBlock[] = [],
  options: { retainDeletedManualBreakOwners?: boolean } = {},
): TextFlowBlock[] {
  const usedIds = new Set<string>();
  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));

  const converted = (doc.content ?? [])
    // A partial clipboard slice can start at a derived column boundary.
    .flatMap(node => node.type === "layoutColumn" ? node.content ?? [] : [node])
    .filter(isSupportedTiptapBlockNode)
    .map((node) => {
      const block = tiptapNodeToTextBlock(node);
      const previous = previousById.get(block.id);
      // 既にある id のブロックは SigmaDoc 側の pagination が正 (改ページの付け外しはそちらの
      // 操作で行う)。id が無い = 貼り付けなどで新しく現れたブロックだけ、node の attrs が
      // 運んできた pagination をそのまま使う。
      //
      // 2 度目に出てくる id は Enter によるブロック分割の後半。PM の `tr.split` は attrs を
      // 両側へ複製するので (Tiptap の `keepOnSplit` は末尾での分割にしか効かない)、そのままだと
      // 「このブロックの前で改ページ」が 2 つに増える。後半からは落とす。
      //
      // 下余白 (`spaceAfterPx`) も同じ規約に載せる: 「このブロックの下の余白」なので、割った
      // ときに残るのは前半。既存 id で SigmaDoc 側を正にするのも同じ理由で、これが無いと
      // 余白をコミットした直後の onUpdate が古い PM attrs でコミットを巻き戻す。
      const isSplitTail = usedIds.has(block.id);
      const carried = isSplitTail
        ? withCarriedBlockFields(block, undefined)
        : previous
          ? withCarriedBlockFields(block, previous)
          : block;
      return ensureUniqueTextFlowBlockIds(carried, usedIds);
    });
  const preserved = options.retainDeletedManualBreakOwners === false
    ? converted
    : preserveManualBreaksAfterTextEdit(
      previousBlocks,
      converted,
      { retainDeletedOwners: true },
    );
  return restoreOversizedTextFlowBlocks(
    applyExplicitLeadingPasteBreakTransfers(previousBlocks, preserved),
    indexTextFlowBlocksById(previousBlocks),
    indexListItemsById(previousBlocks),
  );
}

/**
 * ブロック貼り付けは、break owner の直前へ入る先頭新規ブロックに pagination.break を
 * 明示して「区切りの後ろ側へ挿入した」ことを表す。旧 owner も生きているため通常の id
 * 引き継ぎだけでは break が二重になる。新規ブロックの明示 attr を移譲印として読み、
 * 直後の旧 owner からだけ break を外す。
 */
function applyExplicitLeadingPasteBreakTransfers(
  previousBlocks: readonly TextFlowBlock[],
  converted: readonly TextFlowBlock[],
): TextFlowBlock[] {
  const previousIds = new Set(previousBlocks.map((block) => block.id));
  const breakOwnerIds = new Set(
    previousBlocks
      .filter((block) => block.pagination?.break === true)
      .map((block) => block.id),
  );
  if (breakOwnerIds.size === 0) {
    return [...converted];
  }

  return converted.map((block, index) => {
    if (!breakOwnerIds.has(block.id)) {
      return block;
    }
    let hasLeadingPasteTransfer = false;
    for (let leadingIndex = index - 1; leadingIndex >= 0; leadingIndex -= 1) {
      const leading = converted[leadingIndex];
      if (previousIds.has(leading.id)) {
        break;
      }
      if (leading.pagination?.break === true) {
        hasLeadingPasteTransfer = true;
        break;
      }
    }
    if (!hasLeadingPasteTransfer) {
      return block;
    }
    return withoutManualBreak(block);
  });
}

function withoutManualBreak<T extends TextFlowBlock>(block: T): T {
  const pagination = { ...(block.pagination ?? {}) };
  delete pagination.break;
  const next = { ...block };
  if (Object.keys(pagination).length > 0) {
    return { ...next, pagination };
  }
  delete next.pagination;
  return next;
}

/**
 * PM の attrs ではなく SigmaDoc 側を正とするフィールドを載せ直す。
 * `previous` が無い (= 分割後半) ときは両方落とす。
 */
function withCarriedBlockFields<T extends TextFlowBlock>(block: T, previous: TextFlowBlock | undefined): T {
  return withSpaceAfter(withPagination(block, previous?.pagination), previous?.spaceAfterPx);
}

function withPagination<T extends TextFlowBlock>(block: T, pagination: PaginationHints | undefined): T {
  if (pagination) {
    return { ...block, pagination };
  }
  if (block.pagination === undefined) {
    return block;
  }
  const next = { ...block };
  delete next.pagination;
  return next;
}

function withSpaceAfter<T extends TextFlowBlock>(block: T, spaceAfterPx: number | undefined): T {
  const normalized = normalizeBlockSpaceAfterPx(spaceAfterPx);
  if (normalized !== undefined) {
    return { ...block, spaceAfterPx: normalized };
  }
  if (block.spaceAfterPx === undefined) {
    return block;
  }
  const next = { ...block };
  delete next.spaceAfterPx;
  return next;
}

/** PM の attrs へ載せる搬送用の値。SigmaDoc に無ければ null (attrs の既定値と揃える)。 */
function paginationAttr(block: { pagination?: PaginationHints | undefined }): PaginationHints | null {
  return block.pagination ?? null;
}

function spaceAfterAttr(block: { spaceAfterPx?: number | undefined }): number | null {
  return normalizeBlockSpaceAfterPx(block.spaceAfterPx) ?? null;
}

/** attrs から戻す。範囲外は clamp、非数は「指定なし」に倒す。 */
function spaceAfterFromAttrs(node: TiptapNode): number | undefined {
  return normalizeBlockSpaceAfterPx(node.attrs?.spaceAfterPx);
}

/** attrs から戻す。壊れた値は無視して「指定なし」に倒す。 */
function paginationFromAttrs(node: TiptapNode): PaginationHints | undefined {
  const value = node.attrs?.pagination;
  if (!isRecord(value)) {
    return undefined;
  }
  // 手動改ページだけが残る (keepTogether / keepWithNext は廃止)。
  return value.break === true ? { break: true } : undefined;
}

export function textFlowBlockToTiptapNode(block: TextFlowBlock): TiptapNode {
  if (block.type === "section") {
    const titleChildren = block.title ? [{ type: "text" as const, text: block.title }] : [];
    const capped = capInlineNodesForEditorLayout(titleChildren);
    return {
      type: "heading",
      attrs: {
        level: 1,
        sigmaDocId: block.id,
        sigmaDocType: block.type,
        textAlign: block.align ?? null,
        lineHeight: block.lineHeight ?? null,
        pagination: paginationAttr(block),
        spaceAfterPx: spaceAfterAttr(block),
        ...cappedEditorLayoutAttrs(capped),
      },
      content: capped.children.length > 0 ? inlineNodesToTiptapNodes([...capped.children]) : undefined,
    };
  }

  if (block.type === "heading") {
    const capped = capInlineNodesForEditorLayout(block.children);
    return {
      type: "heading",
      attrs: {
        level: block.level,
        sigmaDocId: block.id,
        sigmaDocType: block.type,
        textAlign: block.align ?? null,
        lineHeight: block.lineHeight ?? null,
        pagination: paginationAttr(block),
        spaceAfterPx: spaceAfterAttr(block),
        ...cappedEditorLayoutAttrs(capped),
      },
      content: inlineNodesToTiptapNodes([...capped.children]),
    };
  }

  if (block.type === "list") {
    return listNodeToTiptapNode(block);
  }

  if (block.type === "layoutSection") {
    return layoutSectionToTiptapNode(block);
  }

  if (block.type === "problem") {
    const { lead, prompt, hints, solution, id, type, pagination, spaceAfterPx, ...problemMetadata } = block;
    const areas = { lead, prompt, hints, solution };
    return {
      type,
      attrs: { sigmaDocId: id, sigmaDocType: type, pagination: pagination ?? null, spaceAfterPx: spaceAfterPx ?? null, problemMetadata },
      content: PROBLEM_AREA_ORDER.map(area => ({
        type: "problemArea", attrs: { area }, content: areas[area].map(textFlowBlockToTiptapNode),
      })),
    };
  }

  if (block.type === "boxBlock") {
    return boxBlockToTiptapNode(block);
  }

  if (block.type === "quote") {
    return {
      type: "quote",
      attrs: blockIdentityAttrs(block),
      // 引用は必ず 1 つ以上の子を持つ。空で保存されていても段落 1 つに直して開く
      // (content 式が `+` なので、空のままだと PM がノードを作れず文書ごと開けなくなる)。
      content: block.blocks.length > 0
        ? block.blocks.map((child) => textFlowBlockToTiptapNode(child))
        : [textFlowBlockToTiptapNode(createEmptyParagraph(`${block.id}_p`))],
    };
  }

  if (block.type === "codeBlock") {
    const capped = capInlineNodesForEditorLayout(block.children);
    return {
      type: "codeBlock",
      attrs: {
        ...blockIdentityAttrs(block),
        language: normalizeCodeLanguage(block.language) ?? null,
        theme: normalizeCodeBlockTheme(block.theme) ?? "light",
        ...cappedEditorLayoutAttrs(capped),
      },
      content: inlineNodesToTiptapNodes([...capped.children]),
    };
  }

  if (block.type === "divider") {
    return { type: "divider", attrs: blockIdentityAttrs(block) };
  }

  const capped = capInlineNodesForEditorLayout(block.children);
  return {
    type: "paragraph",
    attrs: {
      ...blockIdentityAttrs(block),
      textAlign: block.align ?? null,
      lineHeight: block.lineHeight ?? null,
      ...cappedEditorLayoutAttrs(capped),
    },
    content: inlineNodesToTiptapNodes([...capped.children]),
  };
}

function cappedEditorLayoutAttrs(capped: { capped: boolean; originalLength: number }): Record<string, unknown> {
  return capped.capped
    ? { editorLayoutCapped: true, editorLayoutCharCount: capped.originalLength }
    : {};
}

/** どのブロックも同じ形で運ぶ id・種別・改ページ指定・下余白。 */
function blockIdentityAttrs(block: {
  id: string;
  type: string;
  pagination?: PaginationHints | undefined;
  spaceAfterPx?: number | undefined;
}) {
  return {
    sigmaDocId: block.id,
    sigmaDocType: block.type,
    pagination: paginationAttr(block),
    spaceAfterPx: spaceAfterAttr(block),
  };
}

function createEmptyParagraph(id: string): ParagraphNode {
  return { type: "paragraph", id, children: [] };
}

function boxBlockToTiptapNode(block: BoxBlockNode): TiptapNode {
  return {
    type: "boxBlock",
    attrs: {
      sigmaDocId: block.id,
      sigmaDocType: "boxBlock",
      styleId: block.styleId,
      frame: block.frame ?? null,
      pagination: paginationAttr(block),
      spaceAfterPx: spaceAfterAttr(block),
    },
    content: [
      {
        type: "boxBlockTitle",
        content: inlineNodesToTiptapNodes([...capInlineNodesForEditorLayout(block.title ?? []).children]),
      },
      {
        type: "boxBlockBody",
        content: block.blocks.length > 0
          ? block.blocks.map(boxBlockChildToTiptapNode)
          : [boxBlockChildToTiptapNode({ type: "paragraph", id: createId("p"), children: [] })],
      },
    ],
  };
}

function layoutSectionToTiptapNode(block: LayoutSectionNode): TiptapNode {
  block = migrateLegacyLayoutColumns(block);
  const columns = getLayoutSectionColumns(block);
  while (columns.length < normalizeLayoutSectionColumnCount(block.layout.columnCount)) {
    columns.push([createEmptyParagraph(createId("p"))]);
  }
  return {
    type: "layoutSection",
    attrs: {
      sigmaDocId: block.id,
      sigmaDocType: "layoutSection",
      columnCount: normalizeLayoutSectionColumnCount(block.layout.columnCount),
      columnGapMm: block.layout.columnGapMm ?? 8,
      columnRule: block.layout.columnRule,
      columnStartIds: block.layout.columnStartIds,
      columnWidths: block.layout.columnWidths,
      pagination: paginationAttr(block),
      spaceAfterPx: spaceAfterAttr(block),
    },
    content: columns.map((column, index) => ({
      type: "layoutColumn",
      attrs: { index },
      content: column.map(layoutSectionChildToTiptapNode),
    })),
  };
}

function boxBlockChildToTiptapNode(block: BoxBlockChildBlock): TiptapNode {
  if (block.type === "layoutSection") {
    return layoutSectionToTiptapNode(block);
  }
  return textFlowBlockToTiptapNode(block);
}

function layoutSectionChildToTiptapNode(block: LayoutSectionChildBlock): TiptapNode {
  return textFlowBlockToTiptapNode(block);
}

function listNodeToTiptapNode(list: ListNode): TiptapNode {
  return {
    type: list.listType === "ordered" ? "orderedList" : "bulletList",
    attrs: {
      sigmaDocId: list.id,
      sigmaDocType: "list",
      pagination: paginationAttr(list),
      spaceAfterPx: spaceAfterAttr(list),
      ...(list.listType === "ordered" && list.start ? { start: list.start } : {}),
      ...(list.listType === "ordered" && list.markerStyle ? { markerStyle: list.markerStyle } : {}),
    },
    content: list.items.map(listItemNodeToTiptapNode),
  };
}

function listItemNodeToTiptapNode(item: ListItemNode): TiptapNode {
  return {
    type: "listItem",
    attrs: {
      spaceAfterPx: spaceAfterAttr(item),
    },
    content: [
      {
        type: "paragraph",
        attrs: {
          sigmaDocId: item.id,
          sigmaDocType: "listItem",
          ...(item.align ? { textAlign: item.align } : {}),
          ...(item.spaceAfterPx ? { listItemSpaceAfterPx: item.spaceAfterPx } : {}),
        },
        content: inlineNodesToTiptapNodes([...capInlineNodesForEditorLayout(item.children).children]),
      },
      ...(item.continuations ?? []).map(textFlowBlockToTiptapNode),
      ...(item.nested ?? []).map(listNodeToTiptapNode),
    ],
  };
}

function isTiptapListNode(node: TiptapNode): boolean {
  return node.type === "bulletList" || node.type === "orderedList";
}

/**
 * SigmaDoc へ書き戻せるノードか。
 *
 * ここに無い種別は **黙って捨てられる**。かつて StarterKit の blockquote / codeBlock /
 * horizontalRule が有効なまま素通りしていて、`> ` と打つと引用ができ、次の同期で中身ごと
 * 消えていた。いまは `createRichTextEngineExtensions` がそれらのノードを本文スキーマから
 * 外しているので、ここへ来ない種別は「本当に描けないもの」だけになっている。
 */
/**
 * 引用ノードを SigmaDoc へ戻す。
 *
 * 子は `QuoteChildBlock` しか取らない。PM のスキーマ (content 式) がそれ以外を作れないので、
 * ここで弾かれるものが出るのは「スキーマと SigmaDoc の型が食い違ったとき」だけ — そのときは
 * 黙って捨てるのではなく段落として残す方が、書いた文字が消えないぶん必ず良い。
 */
function tiptapQuoteNodeToTextBlock(node: TiptapNode): QuoteBlockNode {
  const pagination = paginationFromAttrs(node);
  const spaceAfterPx = spaceAfterFromAttrs(node);
  const blocks = (node.content ?? [])
    .filter(isSupportedTiptapBlockNode)
    .map((child) => tiptapNodeToTextBlock(child))
    .map(toQuoteChildBlock);
  return {
    type: "quote",
    id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("quote"),
    blocks: blocks.length > 0
      ? blocks
      : [{ type: "paragraph", id: createId("p"), children: [] }],
    ...(pagination ? { pagination } : {}),
    ...(spaceAfterPx ? { spaceAfterPx } : {}),
  };
}

function toQuoteChildBlock(block: TextFlowBlock): QuoteChildBlock {
  if (
    block.type === "paragraph"
    || block.type === "heading"
    || block.type === "list"
    || block.type === "codeBlock"
    || block.type === "divider"
  ) {
    return block;
  }
  return {
    type: "paragraph",
    id: block.id,
    children: getTextFlowBlockChildren(block),
  };
}

function isSupportedTiptapBlockNode(node: TiptapNode): boolean {
  return node.type === "paragraph"
    || node.type === "heading"
    || node.type === "quote"
    || node.type === "codeBlock"
    || node.type === "divider"
    || node.type === "boxBlock"
    || node.type === "problem"
    || node.type === "layoutSection"
    || isTiptapListNode(node);
}

function ensureUniqueTextFlowBlockIds<T extends TextFlowBlock>(block: T, usedIds: Set<string>): T {
  if (block.type === "problem") {
    return {
      ...block,
      id: claimUniqueId(block.id, "problem", usedIds),
      ...Object.fromEntries(PROBLEM_AREA_ORDER.map(area => [area,
        block[area].map(child => ensureUniqueTextFlowBlockIds(child, usedIds)),
      ])),
    } as T;
  }
  if (block.type === "boxBlock") {
    const id = claimUniqueId(block.id, "box", usedIds);
    return {
      ...block,
      id,
      blocks: block.blocks.map((child) => ensureUniqueBoxBlockChildIds(child, usedIds)),
    } as T;
  }

  if (block.type === "layoutSection") {
    const id = claimUniqueId(block.id, "layout_section", usedIds);
    return {
      ...block,
      id,
      children: block.children.map((child) => ensureUniqueLayoutSectionChildIds(child, usedIds)),
    } as T;
  }

  if (block.type !== "list") {
    if (!usedIds.has(block.id)) {
      usedIds.add(block.id);
      return block;
    }

    const next = {
      ...block,
      id: createId(idPrefixForTextBlock(block)),
    };
    usedIds.add(next.id);
    return next;
  }

  const nextList = ensureUniqueListNodeIds(block, usedIds);
  return nextList as T;
}

function ensureUniqueBoxBlockChildIds(block: BoxBlockChildBlock, usedIds: Set<string>): BoxBlockChildBlock {
  if (block.type === "layoutSection") {
    const id = claimUniqueId(block.id, "layout_section", usedIds);
    return {
      ...block,
      id,
      children: block.children.map((child) => ensureUniqueLayoutSectionChildIds(child, usedIds)),
    };
  }
  return ensureUniqueTextFlowBlockIds(block, usedIds);
}

function ensureUniqueLayoutSectionChildIds(block: LayoutSectionChildBlock, usedIds: Set<string>): LayoutSectionChildBlock {
  if (block.type === "boxBlock") {
    const id = claimUniqueId(block.id, "box", usedIds);
    return {
      ...block,
      id,
      blocks: block.blocks.map((child) => ensureUniqueBoxBlockChildIds(child, usedIds)),
    };
  }
  return ensureUniqueTextFlowBlockIds(block, usedIds) as LayoutSectionChildBlock;
}

function ensureUniqueListNodeIds(list: ListNode, usedIds: Set<string>): ListNode {
  const id = claimUniqueId(list.id, "list", usedIds);
  return {
    ...list,
    id,
    items: list.items.map((item) => ensureUniqueListItemNodeIds(item, usedIds)),
  };
}

function ensureUniqueListItemNodeIds(item: ListItemNode, usedIds: Set<string>): ListItemNode {
  return {
    ...item,
    id: claimUniqueId(item.id, "li", usedIds),
    ...(item.continuations ? {
      continuations: item.continuations.map((continuation) => ({
        ...continuation,
        id: claimUniqueId(continuation.id, continuationIdPrefix(continuation.type), usedIds),
      })),
    } : {}),
    ...(item.nested ? { nested: item.nested.map((list) => ensureUniqueListNodeIds(list, usedIds)) } : {}),
  };
}

function continuationIdPrefix(type: ListItemContinuationNode["type"]): string {
  if (type === "heading") {
    return "heading";
  }
  if (type === "divider") {
    return "divider";
  }
  return "p";
}

function claimUniqueId(id: string, prefix: string, usedIds: Set<string>): string {
  if (id && !usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }

  let nextId = "";
  do {
    nextId = createId(prefix);
  } while (usedIds.has(nextId));

  usedIds.add(nextId);
  return nextId;
}


function tiptapNodeToTextBlock(node: TiptapNode): TextFlowBlock {
  if (isTiptapListNode(node)) {
    return tiptapListNodeToTextBlock(node);
  }

  if (node.type === "problem") {
    const metadata = isRecord(node.attrs?.problemMetadata) ? node.attrs.problemMetadata : {};
    const areaBlocks = (area: string): ProblemAreaBlock[] => (node.content?.find(child => child.attrs?.area === area)?.content ?? [])
      .filter(isSupportedTiptapBlockNode)
      .map(tiptapNodeToTextBlock)
      .filter((block): block is ProblemAreaBlock => block.type !== "section" && block.type !== "problem");
    return {
      ...metadata,
      type: "problem", id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("problem"),
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [],
      lead: areaBlocks("lead"), prompt: areaBlocks("prompt"), hints: areaBlocks("hints"), solution: areaBlocks("solution"),
      ...(paginationFromAttrs(node) ? { pagination: paginationFromAttrs(node) } : {}),
      ...(spaceAfterFromAttrs(node) ? { spaceAfterPx: spaceAfterFromAttrs(node) } : {}),
    } as ProblemNode;
  }

  if (node.type === "boxBlock") {
    return tiptapBoxNodeToTextBlock(node);
  }

  if (node.type === "layoutSection") {
    return tiptapLayoutSectionNodeToTextBlock(node);
  }

  if (node.type === "quote") {
    return tiptapQuoteNodeToTextBlock(node);
  }

  if (node.type === "codeBlock") {
    const codePagination = paginationFromAttrs(node);
    const codeSpaceAfter = spaceAfterFromAttrs(node);
    const theme = normalizeCodeBlockTheme(node.attrs?.theme);
    return {
      type: "codeBlock",
      id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("code"),
      children: tiptapNodesToInlineNodes(node.content ?? []),
      language: normalizeCodeLanguage(node.attrs?.language),
      ...(theme && theme !== "light" ? { theme } : {}),
      ...(codePagination ? { pagination: codePagination } : {}),
      ...(codeSpaceAfter ? { spaceAfterPx: codeSpaceAfter } : {}),
    };
  }

  if (node.type === "divider") {
    const dividerPagination = paginationFromAttrs(node);
    const dividerSpaceAfter = spaceAfterFromAttrs(node);
    return {
      type: "divider",
      id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("divider"),
      ...(dividerPagination ? { pagination: dividerPagination } : {}),
      ...(dividerSpaceAfter ? { spaceAfterPx: dividerSpaceAfter } : {}),
    };
  }

  const previousType = node.attrs?.sigmaDocType;
  const id = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("text");
  const children = tiptapNodesToInlineNodes(node.content ?? []);

  const pagination = paginationFromAttrs(node);
  const spaceAfterPx = spaceAfterFromAttrs(node);

  // `section` は level 1 の見出しとして描いている。level が動いていたら、それは
  // Tiptap の chain (`setHeading`) で見出しレベルを変えた結果なので、section へ
  // 引き戻さずその見出しにする — 引き戻すと選んだレベルが黙って 1 に戻る。
  if (previousType === "section" && Number(node.attrs?.level ?? 1) === 1) {
    return {
      type: "section",
      id,
      title: inlineNodesToPlainText(children),
      align: normalizeTextAlign(node.attrs?.textAlign),
      lineHeight: normalizeLineHeight(node.attrs?.lineHeight),
      ...(pagination ? { pagination } : {}),
      ...(spaceAfterPx ? { spaceAfterPx } : {}),
    };
  }

  if (node.type === "heading") {
    const level = Number(node.attrs?.level ?? 2);
    return {
      type: "heading",
      id,
      level: level === 1 || level === 2 || level === 3 ? level : 2,
      children,
      align: normalizeTextAlign(node.attrs?.textAlign),
      lineHeight: normalizeLineHeight(node.attrs?.lineHeight),
      ...(pagination ? { pagination } : {}),
      ...(spaceAfterPx ? { spaceAfterPx } : {}),
    };
  }

  return {
    type: "paragraph",
    id,
    children,
    align: normalizeTextAlign(node.attrs?.textAlign),
    lineHeight: normalizeLineHeight(node.attrs?.lineHeight),
    ...(pagination ? { pagination } : {}),
    ...(spaceAfterPx ? { spaceAfterPx } : {}),
  };
}

function tiptapBoxNodeToTextBlock(node: TiptapNode): BoxBlockNode {
  const styleId = typeof node.attrs?.styleId === "string" && node.attrs.styleId
    ? node.attrs.styleId
    : "fancybox";
  const frame = isRecord(node.attrs?.frame) ? node.attrs.frame as BoxFrameSpec : undefined;
  const titleNode = node.content?.find((child) => child.type === "boxBlockTitle");
  const bodyNode = node.content?.find((child) => child.type === "boxBlockBody");
  const title = tiptapNodesToInlineNodes(titleNode?.content ?? []);
  const blocks = tiptapNodesToBoxBlockChildren(bodyNode?.content ?? []);
  return {
    type: "boxBlock",
    id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("box"),
    styleId,
    ...(title.length > 0 ? { title } : {}),
    ...(frame ? { frame } : {}),
    ...(paginationFromAttrs(node) ? { pagination: paginationFromAttrs(node) } : {}),
    ...(spaceAfterFromAttrs(node) ? { spaceAfterPx: spaceAfterFromAttrs(node) } : {}),
    blocks: blocks.length > 0 ? blocks : [{
      type: "paragraph",
      id: createId("p"),
      children: [],
    }],
  };
}

function tiptapLayoutSectionNodeToTextBlock(node: TiptapNode): LayoutSectionNode {
  const columnCount = normalizeLayoutSectionColumnCount(node.attrs?.columnCount);
  const childNodes = (node.content ?? []).flatMap((child, index) => child.type === "layoutColumn"
    ? (child.content ?? []).map(block => ({ ...block, attrs: { ...block.attrs, layoutColumnIndex: index } }))
    : [child]).filter(isSupportedTiptapBlockNode);
  const children = childNodes.map(tiptapNodeToLayoutSectionChildBlock);
  const section: LayoutSectionNode = {
    type: "layoutSection",
    id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("layout_section"),
    layout: {
      columnCount,
      columnGapMm: normalizeNonnegativeNumber(node.attrs?.columnGapMm) ?? 8,
      ...(normalizeColumnRule(node.attrs?.columnRule) ? { columnRule: normalizeColumnRule(node.attrs?.columnRule) } : {}),
      ...(Array.isArray(node.attrs?.columnStartIds) ? { columnStartIds: node.attrs.columnStartIds.filter((id): id is string => typeof id === "string") } : {}),
      ...(Array.isArray(node.attrs?.columnWidths) ? { columnWidths: node.attrs.columnWidths.filter((width): width is number => typeof width === "number" && width > 0) } : {}),
    },
    ...(paginationFromAttrs(node) ? { pagination: paginationFromAttrs(node) } : {}),
    ...(spaceAfterFromAttrs(node) ? { spaceAfterPx: spaceAfterFromAttrs(node) } : {}),
    children: children.length > 0 ? children : [{
      type: "paragraph",
      id: createId("p"),
      children: [],
    }],
  };
  const ownedColumns = Array.from({ length: columnCount }, () => [] as LayoutSectionChildBlock[]);
  const projectedOwners = childNodes.map((child) => {
    const projected = child.attrs?.layoutColumnIndex;
    return typeof projected === "number" && Number.isInteger(projected) && projected >= 0 && projected < columnCount
      ? projected
      : null;
  });
  const hasProjectedOwnership = projectedOwners.some((owner) => owner !== null);
  if (hasProjectedOwnership) {
    // A newly inserted node may not have inherited a projection attribute. Keep it beside the
    // nearest owned sibling instead of repartitioning the entire flattened section.
    for (const [index, child] of children.entries()) {
      const projected = projectedOwners[index];
      const previous = projectedOwners.slice(0, index).reverse().find((owner) => owner !== null);
      const next = projectedOwners.slice(index + 1).find((owner) => owner !== null);
      const owner = projected ?? previous ?? next ?? 0;
      ownedColumns[Math.min(columnCount - 1, Math.max(0, owner))].push(child);
    }
    for (const column of ownedColumns) {
      if (column.length === 0) column.push(createEmptyParagraph(createId("p")));
    }
    return setLayoutSectionColumns(
      section,
      ownedColumns,
      getLayoutSectionColumnWidths(section, ownedColumns.length),
    );
  }
  while (section.children.length < columnCount) {
    section.children.push(createEmptyParagraph(createId("p")));
  }
  const columns = getLayoutSectionColumns(section);
  return setLayoutSectionColumns(
    section,
    columns,
    getLayoutSectionColumnWidths(section, columns.length),
  );
}

function tiptapNodesToBoxBlockChildren(nodes: TiptapNode[]): BoxBlockChildBlock[] {
  return nodes.filter(isSupportedTiptapBlockNode).map(tiptapNodeToTextBlock);
}

function tiptapNodeToLayoutSectionChildBlock(node: TiptapNode): LayoutSectionChildBlock {
  const block = tiptapNodeToTextBlock(node);
  return isLayoutSectionChildBlock(block) ? block : degradeToParagraph(block);
}

/**
 * 受け取れない種別を段落へ落とすときは、**文章を持ったまま**落とす (引用の子と同じ規約)。
 *
 * 空の段落へ差し替えると、入れ物の中で種別を変えた瞬間に書いた文字ごと消える。実際に
 * 「箱の中で引用ボタンを押すと本文が空になる」という形で出ていた。
 */
function degradeToParagraph(block: TextFlowBlock): ParagraphNode {
  return {
    type: "paragraph",
    id: block.id,
    children: getTextFlowBlockChildren(block),
  };
}

function tiptapListNodeToTextBlock(node: TiptapNode): ListNode {
  const isOrdered = node.type === "orderedList";
  const start = normalizePositiveInteger(node.attrs?.start);
  const markerStyle = normalizeOrderedListMarkerStyle(node.attrs?.markerStyle);
  return {
    type: "list",
    id: typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : createId("list"),
    listType: isOrdered ? "ordered" : "bullet",
    ...(paginationFromAttrs(node) ? { pagination: paginationFromAttrs(node) } : {}),
    ...(spaceAfterFromAttrs(node) ? { spaceAfterPx: spaceAfterFromAttrs(node) } : {}),
    ...(isOrdered && start && start !== 1 ? { start } : {}),
    ...(isOrdered && markerStyle && markerStyle !== "decimal" ? { markerStyle } : {}),
    items: (node.content ?? [])
      .filter((child) => child.type === "listItem")
      .map(tiptapListItemNodeToSigmaNode),
  };
}

function tiptapListItemNodeToSigmaNode(node: TiptapNode): ListItemNode {
  // 項目の 1 行目は必ず段落か見出し。続きには区切り線とコードも置ける
  // (`ListItemContinuationNode`)。入れ物 (引用・囲み枠・段組) は項目の中には置かない。
  const bodyBlocks = (node.content ?? []).filter((child) => (
    child.type === "paragraph" || child.type === "heading" || child.type === "divider"
  ));
  const firstTextBlock = bodyBlocks.findIndex((child) => (
    child.type === "paragraph" || child.type === "heading"
  ));
  const firstBody = firstTextBlock >= 0 ? bodyBlocks[firstTextBlock] : undefined;
  const children = tiptapNodesToInlineNodes(firstBody?.content ?? []).filter(isNonEmptyInlineNode);
  const align = normalizeTextAlign(firstBody?.attrs?.textAlign);
  const spaceAfterPx = normalizeBlockSpaceAfterPx(firstBody?.attrs?.listItemSpaceAfterPx);
  const continuations = bodyBlocks
    .filter((_, index) => index !== firstTextBlock)
    .map(tiptapNodeToTextBlock)
    .filter((body): body is ListItemContinuationNode => (
      body.type === "paragraph" || body.type === "heading" || body.type === "divider"
    ));
  const nested = (node.content ?? [])
    .filter(isTiptapListNode)
    .map(tiptapListNodeToTextBlock);

  return {
    type: "listItem",
    id: typeof firstBody?.attrs?.sigmaDocId === "string" ? firstBody.attrs.sigmaDocId : createId("li"),
    children,
    ...(align && align !== "left" ? { align } : {}),
    ...(spaceAfterPx ? { spaceAfterPx } : {}),
    ...(continuations.length > 0 ? { continuations } : {}),
    ...(nested.length > 0 ? { nested } : {}),
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * n 段組の中に置ける子。SigmaDoc の `LayoutSectionChildBlock` と編集面の
 * `LayoutSectionExtension` の content 式はこの集合を一致させる。
 * **PM が持てる集合**をここで型にしておく — 広げると SigmaDoc → PM で content 式に合わない
 * ノードを作ってしまう。
 */
type EditableLayoutSectionChildBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode;

function isLayoutSectionChildBlock(block: TextFlowBlock): block is EditableLayoutSectionChildBlock {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    || block.type === "boxBlock";
}


function indexListItemsById(
  blocks: readonly TextFlowBlock[],
  into: Map<string, ListItemNode> = new Map(),
): Map<string, ListItemNode> {
  for (const block of blocks) {
    if (block.type === "list") {
      for (const item of block.items) {
        into.set(item.id, item);
        if (item.nested) {
          indexListItemsById(item.nested, into);
        }
      }
    } else if (block.type === "problem") {
      PROBLEM_AREA_ORDER.forEach((area) => indexListItemsById(block[area], into));
    } else if (block.type === "quote") {
      indexListItemsById(block.blocks, into);
    } else if (block.type === "boxBlock") {
      indexListItemsById(block.blocks, into);
    } else if (block.type === "layoutSection") {
      indexListItemsById(block.children, into);
    }
  }
  return into;
}

function restoreOversizedTextFlowBlocks(
  blocks: TextFlowBlock[],
  previousById: Map<string, TextFlowBlock>,
  previousListItems: Map<string, ListItemNode>,
): TextFlowBlock[] {
  return blocks.map((block) => restoreOversizedTextFlowBlock(block, previousById, previousListItems));
}

function restoreOversizedTextFlowBlock(
  block: TextFlowBlock,
  previousById: Map<string, TextFlowBlock>,
  previousListItems: Map<string, ListItemNode>,
): TextFlowBlock {
  const previous = previousById.get(block.id);
  if (block.type === "problem") return { ...block, ...Object.fromEntries(PROBLEM_AREA_ORDER.map((area) => [area, restoreOversizedTextFlowBlocks(block[area], previousById, previousListItems)])) };
  if (previous && isOversizedLeafTextFlowBlock(previous)) {
    return previous;
  }
  if (block.type === "quote") {
    return {
      ...block,
      blocks: restoreOversizedTextFlowBlocks(block.blocks, previousById, previousListItems) as typeof block.blocks,
    };
  }
  if (block.type === "boxBlock") {
    return {
      ...block,
      blocks: block.blocks.map((child) => {
        const restored = restoreOversizedTextFlowBlock(child, previousById, previousListItems);
        return restored;
      }),
    };
  }
  if (block.type === "layoutSection") {
    return {
      ...block,
      children: block.children.map((child) => {
        const restored = restoreOversizedTextFlowBlock(child, previousById, previousListItems);
        return isLayoutSectionChildBlock(restored) ? restored : child;
      }),
    };
  }
  if (block.type === "list") {
    return {
      ...block,
      items: block.items.map((item) => restoreOversizedListItem(item, previousListItems, previousById)),
    };
  }
  return block;
}

function restoreOversizedListItem(
  item: ListItemNode,
  previousListItems: Map<string, ListItemNode>,
  previousById: Map<string, TextFlowBlock>,
): ListItemNode {
  const previous = previousListItems.get(item.id);
  const children = previous && getInlineNodesEditorLength(previous.children) > MAX_TEXT_FLOW_EDITOR_LAYOUT_CHARS
    ? previous.children
    : item.children;
  return {
    ...item,
    children,
    ...(item.continuations
      ? {
          continuations: item.continuations.map((continuation) => {
            const restored = restoreOversizedTextFlowBlock(continuation, previousById, previousListItems);
            return restored.type === "paragraph" || restored.type === "heading" || restored.type === "divider"
              ? restored
              : continuation;
          }),
        }
      : {}),
    ...(item.nested ? { nested: item.nested.map((list) => {
      const restored = restoreOversizedTextFlowBlock(list, previousById, previousListItems);
      return restored.type === "list" ? restored : list;
    }) } : {}),
  };
}
