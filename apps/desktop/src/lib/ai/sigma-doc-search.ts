import {
  listItemContinuationInlineNodes,
  normalizeOverlaySnapshot,
  overlayTextBlockInlineRuns,
  type OverlayRichTextShape,
  type OverlayTableShape,
  type SigmaTableCellContent,
  type SigmaTableSpec,
  type BoxBlockChildBlock,
  type InlineNode,
  type ListItemNode,
  type ListNode,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";

export type SigmaDocSearchField = "text" | "tex";

export interface SigmaDocSearchMatch {
  /** The addressable block id, or an overlay shape id for table-shape/text-shape matches. */
  blockId: string;
  /** The owning block's type (e.g. "paragraph", "listItem"), or "overlayShape" for overlay matches. */
  blockType: string;
  /** Where the match lives, e.g. "content[12]", "problem_3.solution", or "overlay". */
  areaPath: string;
  field: SigmaDocSearchField;
  /** ~40 chars of context on each side, with the match wrapped in 「」. */
  excerpt: string;
  /** Character offset of the match within its source text/tex string. */
  matchIndex: number;
}

export interface SigmaDocSearchOptions {
  /** Defaults to 20, hard-capped at 50. */
  limit?: number;
}

export interface SigmaDocSearchResult {
  matches: SigmaDocSearchMatch[];
  /** Total matches found, which may exceed `matches.length` when the result was truncated. */
  totalMatches: number;
}

const DEFAULT_LIMIT = 20;
const HARD_MAX_LIMIT = 50;
const EXCERPT_CONTEXT_LENGTH = 40;

interface SearchContext {
  lowerQuery: string;
  queryLength: number;
  limit: number;
  matches: SigmaDocSearchMatch[];
  totalMatches: number;
}

/**
 * Case-insensitive search across the document: text runs, mathInline tex, table-shape cell
 * content, and overlay text shapes. Returns up to `options.limit` matches (default 20, hard max
 * 50) plus a `totalMatches` count so callers can detect truncation.
 */
export function searchSigmaDocument(
  document: SigmaDocument,
  query: string,
  options?: SigmaDocSearchOptions,
): SigmaDocSearchResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { matches: [], totalMatches: 0 };
  }

  const context: SearchContext = {
    lowerQuery: trimmedQuery.toLowerCase(),
    queryLength: trimmedQuery.length,
    limit: resolveLimit(options?.limit),
    matches: [],
    totalMatches: 0,
  };

  let problemNumber = 0;
  document.content.forEach((block, index) => {
    searchBlock(block, `content[${index}]`, context);
    if (block.type === "problem") {
      problemNumber += 1;
      searchProblemAreas(block, problemNumber, context);
    }
  });

  searchOverlayShapes(document, context);

  return { matches: context.matches, totalMatches: context.totalMatches };
}

function resolveLimit(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(input), HARD_MAX_LIMIT);
}

function searchProblemAreas(problem: ProblemNode, problemNumber: number, context: SearchContext): void {
  for (const area of ["lead", "prompt", "hints", "solution"] as const satisfies readonly ProblemAreaKind[]) {
    problem[area].forEach((richBlock, index) => {
      const areaPath = index === 0 ? `problem_${problemNumber}.${area}` : `problem_${problemNumber}.${area}[${index}]`;
      searchBlock(richBlock, areaPath, context);
    });
  }
}

function searchBlock(block: SigmaBlock | RichBlock, areaPath: string, context: SearchContext): void {
  if (block.type === "section") {
    recordPlainStringMatches(block.id, "section", areaPath, block.title, context);
    return;
  }

  if (block.type === "heading" || block.type === "paragraph") {
    searchInlineNodes(block.children, block.id, block.type, areaPath, context);
    return;
  }

  if (block.type === "list") {
    searchListItems(block.items, areaPath, context);
    return;
  }

  if (block.type === "layoutSection") {
    block.children.forEach((child, index) => searchBlock(child, `${areaPath}.children[${index}]`, context));
    return;
  }

  if (block.type === "boxBlock") {
    searchInlineNodes(block.title ?? [], block.id, "boxBlock", areaPath, context);
    searchBoxBlockChildren(block.blocks, areaPath, context);
    return;
  }

  // "problem" blocks are only reachable at the top level and are searched separately via
  // searchProblemAreas (their lead/prompt/hints/solution arrays), so nothing else to do here.
}

function searchBoxBlockChildren(blocks: BoxBlockChildBlock[], areaPath: string, context: SearchContext): void {
  blocks.forEach((child, index) => searchBlock(child, `${areaPath}.blocks[${index}]`, context));
}

function searchListItems(items: ListItemNode[], areaPath: string, context: SearchContext): void {
  items.forEach((item, index) => {
    const itemPath = `${areaPath}.items[${index}]`;
    searchInlineNodes(item.children, item.id, "listItem", itemPath, context);
    (item.continuations ?? []).forEach((continuation, continuationIndex) =>
      searchInlineNodes(
        listItemContinuationInlineNodes(continuation),
        continuation.id,
        continuation.type,
        `${itemPath}.continuations[${continuationIndex}]`,
        context,
      ),
    );
    (item.nested ?? []).forEach((nested: ListNode, nestedIndex) =>
      searchListItems(nested.items, `${itemPath}.nested[${nestedIndex}]`, context),
    );
  });
}

function searchInlineNodes(
  children: InlineNode[],
  blockId: string,
  blockType: string,
  areaPath: string,
  context: SearchContext,
): void {
  for (const child of children) {
    if (child.type === "text") {
      recordMatches(blockId, blockType, areaPath, "text", child.text, context);
    } else {
      recordMatches(blockId, blockType, areaPath, "tex", child.tex, context);
    }
  }
}

function searchOverlayShapes(document: SigmaDocument, context: SearchContext): void {
  const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  for (const shape of snapshot.shapes) {
    if (shape.type === "tableShape") {
      searchTableShape(shape, context);
    } else if (shape.type === "text" || shape.type === "callout") {
      searchTextShape(shape, context);
    }
  }
}

function searchTableShape(shape: OverlayTableShape, context: SearchContext): void {
  searchTableSpec(shape.id, shape.props.table, context);
}

function searchTableSpec(shapeId: string, table: SigmaTableSpec, context: SearchContext): void {
  for (const cell of table.cells) {
    for (const content of cell.content) {
      searchTableCellContent(shapeId, content, context);
    }
  }
}

function searchTableCellContent(shapeId: string, content: SigmaTableCellContent, context: SearchContext): void {
  if (content.type === "trend") {
    searchInlineNodes(content.label ?? [], shapeId, "overlayShape", "overlay", context);
    return;
  }
  searchInlineNodes(content.children, shapeId, "overlayShape", "overlay", context);
}

function searchTextShape(shape: OverlayRichTextShape, context: SearchContext): void {
  for (const inline of shape.props.blocks.flatMap(overlayTextBlockInlineRuns)) {
    if (inline.type === "text") {
      recordMatches(shape.id, "overlayShape", "overlay", "text", inline.text, context);
    } else if (inline.type === "mathInline") {
      recordMatches(shape.id, "overlayShape", "overlay", "tex", inline.tex, context);
    }
  }
}

function recordPlainStringMatches(
  blockId: string,
  blockType: string,
  areaPath: string,
  text: string,
  context: SearchContext,
): void {
  recordMatches(blockId, blockType, areaPath, "text", text, context);
}

function recordMatches(
  blockId: string,
  blockType: string,
  areaPath: string,
  field: SigmaDocSearchField,
  text: string,
  context: SearchContext,
): void {
  for (const matchIndex of findAllMatchIndexes(text, context.lowerQuery)) {
    context.totalMatches += 1;
    if (context.matches.length < context.limit) {
      context.matches.push({
        blockId,
        blockType,
        areaPath,
        field,
        excerpt: buildExcerpt(text, matchIndex, context.queryLength),
        matchIndex,
      });
    }
  }
}

function findAllMatchIndexes(text: string, lowerQuery: string): number[] {
  if (!text) {
    return [];
  }

  const lowerText = text.toLowerCase();
  const indexes: number[] = [];
  let from = 0;
  while (from <= lowerText.length - lowerQuery.length) {
    const index = lowerText.indexOf(lowerQuery, from);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    from = index + lowerQuery.length;
  }
  return indexes;
}

function buildExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(text.length, matchIndex + matchLength + EXCERPT_CONTEXT_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const before = text.slice(start, matchIndex);
  const matched = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength, end);
  return `${prefix}${before}「${matched}」${after}${suffix}`;
}
