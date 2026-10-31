import { z } from "zod";
import type { ProblemAreaBlock, SigmaDocument } from "@/features/document";
import { ProblemAreaBlockSchema } from "./sigma-doc-schema";

/**
 * The members-only problem library: a second provider of the problem dialog, next to 受験数学研究所.
 * Its display name comes from the server (`access.label`), so nothing here names an organisation.
 * The main process validates every request before the network and every response after it; the
 * renderer only sees the shapes below.
 */

// Control characters never belong in a query; they also keep a request from smuggling extra lines.
const plainText = (max: number) => z.string().max(max).regex(/^[^\x00-\x1f\x7f]*$/u);

/** Ids are opaque server data. Only their shape is checked, so a route cannot be smuggled through them. */
export const LIBRARY_PROBLEM_ID = /^[a-z0-9_]{1,64}$/u;
/** `group|type|name>name>…`. The server owns the vocabulary; the client only keeps keys printable and bounded. */
export const LibraryFacetKeySchema = plainText(300).min(1).refine(key => key.split("|").length === 3, "facet key");

export const LibrarySearchRequestSchema = z.object({
  q: plainText(200).optional(),
  facets: z.array(LibraryFacetKeySchema).max(20).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
}).strict();
export type LibrarySearchRequest = z.input<typeof LibrarySearchRequestSchema>;

export const LibraryFacetsRequestSchema = z.object({ parent: LibraryFacetKeySchema.nullable() }).strict();
export type LibraryFacetsRequest = z.input<typeof LibraryFacetsRequestSchema>;

export const LibraryGetRequestSchema = z.object({ id: z.string().regex(LIBRARY_PROBLEM_ID) }).strict();
export type LibraryGetRequest = z.input<typeof LibraryGetRequestSchema>;

export const LibraryAccessSchema = z.object({
  available: z.boolean(),
  label: plainText(80).trim().min(1).optional(),
});
export type LibraryAccess = z.infer<typeof LibraryAccessSchema>;

const count = z.number().int().min(0).max(100_000_000);
export const LibraryProblemSummarySchema = z.object({
  id: z.string().regex(LIBRARY_PROBLEM_ID),
  title: plainText(2000).trim().min(1),
  source_label: plainText(2000).nullish(),
  exam_year: z.number().int().min(1000).max(9999).nullish(),
  has_solution: z.boolean(),
  tags: z.array(plainText(200)).max(12).default([]),
  preview: z.array(ProblemAreaBlockSchema).max(50),
});
export type LibraryProblemSummary = z.infer<typeof LibraryProblemSummarySchema>;

export const LibrarySearchResponseSchema = z.object({
  total: count,
  results: z.array(LibraryProblemSummarySchema).max(50),
  facetCounts: z.record(LibraryFacetKeySchema, count).default({}).refine(counts => Object.keys(counts).length <= 5000, "facet counts"),
});
export type LibrarySearchResponse = z.infer<typeof LibrarySearchResponseSchema>;

export const LibraryFacetSchema = z.object({
  key: LibraryFacetKeySchema,
  group: plainText(200).min(1),
  type: plainText(200).min(1),
  label: plainText(300).min(1),
  count,
  hasChildren: z.boolean(),
});
export type LibraryFacet = z.infer<typeof LibraryFacetSchema>;
export const LibraryFacetsResponseSchema = z.object({ facets: z.array(LibraryFacetSchema).max(5000) });

type Failure = { ok: false; error: string };
export type LibrarySearchResult = { ok: true; search: LibrarySearchResponse } | Failure;
export type LibraryFacetsResult = { ok: true; facets: LibraryFacet[] } | Failure;
export type LibraryGetResult = { ok: true; document: SigmaDocument } | Failure;

/** The renderer's view of the library. Credentials never cross this bridge. */
export interface MemberLibraryBridge {
  /** Any failure (signed out, not a member, offline) resolves to `{ available: false }`. */
  access(): Promise<LibraryAccess>;
  search(request: LibrarySearchRequest): Promise<LibrarySearchResult>;
  facets(request: LibraryFacetsRequest): Promise<LibraryFacetsResult>;
  /** The full document; its referenced fonts are already in the application font store. */
  get(request: LibraryGetRequest): Promise<LibraryGetResult>;
}

/** Splits a facet key for display. The last path step is the value; the rest is its ancestry. */
export function facetKeyParts(key: string): { group: string; type: string; path: string[] } {
  const [group = "", type = "", path = ""] = key.split("|");
  return { group, type, path: path.split(">").filter(Boolean) };
}

/** Drops every problem's solution so the import carries the prompt only. Nothing else changes. */
export function withoutSolutions(document: SigmaDocument): SigmaDocument {
  const strip = <T extends { type: string }>(block: T): T => {
    if (block.type === "problem") {
      const problem = block as T & { solution: ProblemAreaBlock[]; areaLayout?: { solution?: unknown } };
      const areaLayout = problem.areaLayout ? { ...problem.areaLayout } : undefined;
      if (areaLayout) delete areaLayout.solution;
      return { ...problem, solution: [], ...(areaLayout ? { areaLayout } : {}) };
    }
    if (block.type === "layoutSection") {
      const section = block as T & { children: Array<{ type: string }> };
      return { ...section, children: section.children.map(strip) };
    }
    if (block.type === "boxBlock") {
      const box = block as T & { blocks: Array<{ type: string }> };
      return { ...box, blocks: box.blocks.map(strip) };
    }
    return block;
  };
  return { ...document, content: document.content.map(strip) };
}
