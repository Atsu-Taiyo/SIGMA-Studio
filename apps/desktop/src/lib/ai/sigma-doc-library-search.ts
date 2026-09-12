import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";
import { listItemContinuationInlineNodes } from "@/features/document";
import type {
  BoxBlockNode,
  LayoutSectionChildBlock,
  LayoutSectionNode,
  ListNode,
  ProblemAreaBlock,
  ProblemNode,
  SigmaDocument,
} from "@/features/document";

import { searchSigmaDocument, type SigmaDocSearchMatch } from "./sigma-doc-search";

export interface LibrarySearchDocumentInput {
  fileId: string;
  title: string;
  updatedAt: string; // ISO
  document: SigmaDocument;
}

export type LibrarySearchScope = "all" | "problems";

export interface LibrarySearchOptions {
  /** Defaults to "all". */
  scope?: LibrarySearchScope;
  /** Max documents returned. Defaults to 8, hard-capped at 20. */
  limit?: number;
  /** Marks the matching document's `isCurrentFile`. Typically the file being edited. */
  currentFileId?: string;
}

export interface LibrarySearchMatch {
  blockId: string;
  blockType: string;
  areaPath: string;
  field: "text" | "tex";
  excerpt: string;
}

export interface LibrarySearchDocumentResult {
  fileId: string;
  title: string;
  updatedAt: string;
  isCurrentFile: boolean;
  score: number;
  matches: LibrarySearchMatch[];
}

export interface LibrarySearchResult {
  documents: LibrarySearchDocumentResult[];
  /** May exceed documents.length when the result set was truncated by `limit`. */
  totalMatchingDocuments: number;
}

const DEFAULT_DOCUMENT_LIMIT = 8;
const HARD_MAX_DOCUMENT_LIMIT = 20;
const MAX_MATCHES_PER_DOCUMENT = 5;
const ALL_TERMS_MATCH_BOOST = 5;
const PROBLEM_EXCERPT_PROMPT_LENGTH = 200;

const WEIGHT_TITLE = 5;
const WEIGHT_PROBLEM_LEAD_PROMPT = 3;
const WEIGHT_HEADING = 2;
const WEIGHT_DEFAULT = 1;

/**
 * Searches across a caller-supplied set of already-parsed documents (the MCP layer is
 * responsible for loading/parsing SigmaDoc JSON from disk — this module is pure and only knows
 * about SigmaDocument shapes, so it stays trivially unit-testable).
 */
export function searchSigmaDocLibrary(
  documents: LibrarySearchDocumentInput[],
  query: string,
  options?: LibrarySearchOptions,
): LibrarySearchResult {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return { documents: [], totalMatchingDocuments: 0 };
  }

  const scope = options?.scope ?? "all";
  const limit = Math.min(Math.max(1, Math.floor(options?.limit ?? DEFAULT_DOCUMENT_LIMIT)), HARD_MAX_DOCUMENT_LIMIT);
  const currentFileId = options?.currentFileId;

  const results: LibrarySearchDocumentResult[] = [];
  for (const input of documents) {
    const matched = scope === "problems" ? searchProblemsInDocument(input, terms) : searchAllInDocument(input, terms);
    if (matched) {
      results.push({ ...matched, isCurrentFile: input.fileId === currentFileId });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  return { documents: results.slice(0, limit), totalMatchingDocuments: results.length };
}

function tokenizeQuery(query: string): string[] {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

// ---------------------------------------------------------------------------
// scope: "all" — reuses searchSigmaDocument (run once per query term) plus a synthetic
// document-title match, weighting each hit location by category.
// ---------------------------------------------------------------------------

interface WeightedMatch {
  weight: number;
  match: LibrarySearchMatch;
  dedupeKey: string;
}

function searchAllInDocument(
  input: LibrarySearchDocumentInput,
  terms: string[],
): Omit<LibrarySearchDocumentResult, "isCurrentFile"> | null {
  const normalizedTitle = normalizeText(input.title);
  const weighted: WeightedMatch[] = [];
  const hitTerms = new Set<string>();

  for (const term of terms) {
    let termHit = false;

    if (normalizedTitle.includes(term)) {
      termHit = true;
      weighted.push({
        weight: WEIGHT_TITLE,
        dedupeKey: `title:${term}`,
        match: {
          blockId: "__title__",
          blockType: "documentTitle",
          areaPath: "title",
          field: "text",
          excerpt: buildExcerptAround(input.title, normalizedTitle.indexOf(term), term.length),
        },
      });
    }

    const searchResult = searchSigmaDocument(input.document, term, { limit: 50 });
    for (const match of searchResult.matches) {
      termHit = true;
      const weight = categorizeAreaWeight(match);
      weighted.push({
        weight,
        dedupeKey: `${match.blockId}:${match.areaPath}:${match.field}:${match.matchIndex}`,
        match: {
          blockId: match.blockId,
          blockType: match.blockType,
          areaPath: match.areaPath,
          field: match.field,
          excerpt: match.excerpt,
        },
      });
    }

    if (termHit) {
      hitTerms.add(term);
    }
  }

  if (hitTerms.size === 0) {
    return null;
  }

  const score = weighted.reduce((sum, item) => sum + item.weight, 0)
    + (hitTerms.size === terms.length ? ALL_TERMS_MATCH_BOOST : 0);

  return {
    fileId: input.fileId,
    title: input.title,
    updatedAt: input.updatedAt,
    score,
    matches: pickTopMatches(weighted),
  };
}

function categorizeAreaWeight(match: SigmaDocSearchMatch): number {
  if (match.areaPath.includes(".lead") || match.areaPath.includes(".prompt")) {
    return WEIGHT_PROBLEM_LEAD_PROMPT;
  }
  if (match.blockType === "heading" || match.blockType === "section") {
    return WEIGHT_HEADING;
  }
  return WEIGHT_DEFAULT;
}

function pickTopMatches(weighted: WeightedMatch[]): LibrarySearchMatch[] {
  const seen = new Set<string>();
  const deduped: WeightedMatch[] = [];
  for (const item of weighted) {
    if (seen.has(item.dedupeKey)) {
      continue;
    }
    seen.add(item.dedupeKey);
    deduped.push(item);
  }
  deduped.sort((a, b) => b.weight - a.weight);
  return deduped.slice(0, MAX_MATCHES_PER_DOCUMENT).map((item) => item.match);
}

function buildExcerptAround(text: string, matchIndex: number, matchLength: number): string {
  if (matchIndex < 0) {
    return text;
  }
  const before = text.slice(0, matchIndex);
  const matched = text.slice(matchIndex, matchIndex + matchLength);
  const after = text.slice(matchIndex + matchLength);
  return `${before}「${matched}」${after}`;
}

// ---------------------------------------------------------------------------
// scope: "problems" — one hit per matching ProblemNode, with a fuller excerpt (prompt + tags).
// ---------------------------------------------------------------------------

function searchProblemsInDocument(
  input: LibrarySearchDocumentInput,
  terms: string[],
): Omit<LibrarySearchDocumentResult, "isCurrentFile"> | null {
  const problems = input.document.content.filter((block): block is ProblemNode => block.type === "problem");
  if (problems.length === 0) {
    return null;
  }

  const matches: { weight: number; match: LibrarySearchMatch }[] = [];
  const hitTerms = new Set<string>();

  problems.forEach((problem, index) => {
    const leadPromptText = normalizeText(`${problemAreaBlocksToPlainText(problem.lead)} ${problemAreaBlocksToPlainText(problem.prompt)}`);
    const tagsText = normalizeText((problem.tags ?? []).join(" "));
    const solutionText = normalizeText(problemAreaBlocksToPlainText(problem.solution));

    let problemWeight = 0;
    for (const term of terms) {
      if (leadPromptText.includes(term)) {
        problemWeight += WEIGHT_PROBLEM_LEAD_PROMPT;
        hitTerms.add(term);
      } else if (tagsText.includes(term) || solutionText.includes(term)) {
        problemWeight += WEIGHT_DEFAULT;
        hitTerms.add(term);
      }
    }

    if (problemWeight > 0) {
      matches.push({
        weight: problemWeight,
        match: {
          blockId: problem.id,
          blockType: "problem",
          areaPath: `problem_${index + 1}`,
          field: "text",
          excerpt: buildProblemExcerpt(problem),
        },
      });
    }
  });

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.weight - a.weight);
  const score = matches.reduce((sum, item) => sum + item.weight, 0)
    + (hitTerms.size === terms.length ? ALL_TERMS_MATCH_BOOST : 0);

  return {
    fileId: input.fileId,
    title: input.title,
    updatedAt: input.updatedAt,
    score,
    matches: matches.slice(0, MAX_MATCHES_PER_DOCUMENT).map((item) => item.match),
  };
}

function buildProblemExcerpt(problem: ProblemNode): string {
  const promptText = problemAreaBlocksToPlainText(problem.prompt).trim();
  const truncatedPrompt = promptText.length > PROBLEM_EXCERPT_PROMPT_LENGTH
    ? `${promptText.slice(0, PROBLEM_EXCERPT_PROMPT_LENGTH)}…`
    : promptText;
  const tags = problem.tags ?? [];
  const tagsSuffix = tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : "";
  return `${truncatedPrompt}${tagsSuffix}`;
}

function problemAreaBlocksToPlainText(blocks: readonly ProblemAreaBlock[]): string {
  return richBlocksToPlainText(blocks);
}

function richBlocksToPlainText(blocks: readonly (ProblemAreaBlock | LayoutSectionChildBlock | ProblemNode)[]): string {
  return blocks.map(richBlockToPlainText).filter(Boolean).join(" ");
}

function richBlockToPlainText(block: ProblemAreaBlock | LayoutSectionChildBlock | ProblemNode): string {
  switch (block.type) {
    case "problem":
      return richBlocksToPlainText([...block.lead, ...block.prompt, ...block.hints, ...block.solution]);
    case "list":
      return listNodeToPlainText(block);
    case "layoutSection":
      return layoutSectionToPlainText(block);
    case "boxBlock":
      return boxBlockToPlainText(block);
    case "section":
      return block.title;
    case "divider":
      return "";
    case "quote":
      return richBlocksToPlainText(block.blocks);
    default:
      return inlineNodesToPlainText(block.children);
  }
}

function layoutSectionToPlainText(node: LayoutSectionNode): string {
  return richBlocksToPlainText(node.children);
}

function boxBlockToPlainText(node: BoxBlockNode): string {
  const title = node.title ? inlineNodesToPlainText(node.title) : "";
  return [title, richBlocksToPlainText(node.blocks)].filter(Boolean).join(" ");
}

function listNodeToPlainText(list: ListNode): string {
  return list.items
    .map((item) => {
      const own = inlineNodesToPlainText(item.children);
      const continuations = (item.continuations ?? [])
        .map((continuation) => inlineNodesToPlainText(listItemContinuationInlineNodes(continuation)))
        .join(" ");
      const nested = (item.nested ?? []).map(listNodeToPlainText).join(" ");
      return [own, continuations, nested].filter(Boolean).join(" ");
    })
    .join(" ");
}
