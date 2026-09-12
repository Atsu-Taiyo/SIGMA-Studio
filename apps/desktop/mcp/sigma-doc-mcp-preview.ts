import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  normalizeOverlaySnapshot,
  type OverlayShape,
  getPageMetrics,
  mmToPx,
  paginateBlocks,
  PAGE_GAP_PX,
  type OutputProfileName,
  type SigmaDocument,
} from "@/features/document";

import { pageIndexForY, resolveShapeAnchorPositions } from "@/features/drawing";
import { findBlock } from "@/lib/document-tree";
import {
  buildShapeOnlyPreview,
  expandBounds,
  getVisualShapesFromOperations,
  unionShapeBounds,
} from "@/lib/ai/ai-edit-shape-preview";
import { assertAiOverlayAssetsInDocument, type AiEditDraft } from "@/lib/ai/sigma-doc-edit-schema";

import {
  loadAiRenderBridgeInfo,
  type RenderPageContextRequest,
  type RenderPageContextResult,
  type RenderRect,
} from "../electron/ai-render-bridge";
import { incrementMcpStatsCounter } from "./sigma-doc-mcp-stats";

const TEXT_LIKE_SHAPE_TYPES: ReadonlySet<OverlayShape["type"]> = new Set([
  "text",
  "tableShape",
  "graph2dShape",
  "callout",
]);
const TEXT_LIKE_FALLBACK_WARNING = "text/表/グラフ図形はfallback previewに描画されません。";
const PAGE_LAYOUT_FALLBACK_WARNING = "app bridgeを利用できないため、本文を含まないページ設定のfallback previewを返します。";

export function pngImageContent(buffer: Buffer): CallToolResult["content"][number] {
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
}

export interface VisualPreviewFocus {
  pageIndex: number;
  overlayRect: RenderRect;
  preferTargetPage?: boolean;
}

/**
 * pageIndex/overlayRect for the app-bridge crop. overlayRect.y is expressed
 * page-locally (0..pageHeightPx-1) so the bridge (ai-render-bridge.ts) never
 * has to re-derive a page split from an already-padded rect (that re-derivation
 * is what caused shapes near a page top to wrap the crop to the previous page's
 * bottom). pageIndex/localY are computed from the UNPADDED union bounds first,
 * using the document's own page height (not hardcoded A4) plus PAGE_GAP_PX —
 * the same continuous-canvas stride convention used to resolve shape.y itself
 * (see ANCHOR_PAGE_STRIDE_PX in features/drawing).
 *
 * Shared by computeVisualPreviewFocus (operations-derived shapes, used by the
 * visual edit session flow) and the generic render_block_context / post-write
 * verification path (shapes resolved by id from the committed overlay
 * snapshot instead of from in-flight operations).
 */
export function computeShapesPreviewFocus(
  shapes: OverlayShape[],
  pagePxSize: { width: number; height: number },
): VisualPreviewFocus | null {
  if (shapes.length === 0) {
    return null;
  }

  const resolvedShapes = resolveShapeAnchorPositions(shapes);
  const bounds = unionShapeBounds(resolvedShapes);
  const pageStridePx = pagePxSize.height + PAGE_GAP_PX;
  const { pageIndex, localY } = pageIndexForY(bounds.y, pageStridePx);
  const localBounds = { ...bounds, y: localY };
  const overlayRect: RenderRect = expandBounds(localBounds);

  return {
    pageIndex,
    overlayRect,
    // The estimate above ignores real text reflow, so a block-anchored shape's
    // actual DOM page (resolved by the hidden print renderer) must win — see
    // resolvePageContextCapturePage, which otherwise hard-fails a shape whose
    // anchor lands on a different page than this estimate.
    preferTargetPage: true,
  };
}

export function computeVisualPreviewFocus(
  operations: AiEditDraft[],
  pagePxSize: { width: number; height: number },
): VisualPreviewFocus | null {
  return computeShapesPreviewFocus(getVisualShapesFromOperations(operations), pagePxSize);
}

/**
 * Finds the top-level (document.content) ancestor id for a flow-block id that
 * may be nested inside a problem area, layoutSection, or boxBlock. Reuses the
 * existing findBlock traversal per top-level block instead of adding a new
 * export to document-tree.ts: findBlock already searches an entire
 * document's content array, so scoping `content` to a single top-level block
 * at a time turns it into an "is blockId inside this subtree" check.
 */
function findTopLevelAncestorId(document: SigmaDocument, blockId: string): string | null {
  for (const block of document.content) {
    if (block.id === blockId || findBlock({ ...document, content: [block] }, blockId)) {
      return block.id;
    }
  }
  return null;
}

/**
 * Page-context focus for a plain flow block (paragraph, heading, problem,
 * ...) that has no overlay geometry of its own. There is no server-side
 * layout engine to compute an exact on-page bounding box for arbitrary text
 * (pagination is only ever measured in the real renderer — see
 * `docs/architecture.md`'s continuous-pagination notes), so this reuses the
 * same estimate-based `paginateBlocks` heuristic the print preview and editor
 * already rely on to determine only WHICH page the block estimates onto, and
 * frames the whole page as the crop (the app bridge's DOM measurement still
 * unions this with the anchor block's real rect and re-scrolls if the guess
 * doesn't fit — see ai-render-bridge.ts computePageContextCaptureRect).
 */
export function computeBlockPreviewFocus(
  document: SigmaDocument,
  blockId: string | null,
  pagePxSize: { width: number; height: number },
): VisualPreviewFocus | null {
  if (!blockId) {
    return null;
  }
  const topLevelId = findTopLevelAncestorId(document, blockId);
  if (!topLevelId) {
    return null;
  }
  const pages = paginateBlocks(document.content, document.pageLayout);
  const pageIdx = pages.findIndex((page) => page.blocks.some((block) => block.id === topLevelId));
  return {
    pageIndex: pageIdx >= 0 ? pageIdx : 0,
    overlayRect: { x: 0, y: 0, w: pagePxSize.width, h: pagePxSize.height },
    // paginateBlocks is intentionally heuristic. The hidden print renderer
    // must replace this estimate with the target block's actual DOM page.
    preferTargetPage: true,
  };
}

/** Looks up an overlay shape by id in a document's current overlay snapshot — used to focus a
 * preview around a shape touched by a shapeId-only mutation (update_shape/align_shapes/
 * delete_shapes), where the mutation op itself carries no shape geometry. */
export function findOverlayShapeById(document: SigmaDocument, shapeId: string): OverlayShape | null {
  const overlay = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  return overlay.shapes.find((shape) => shape.id === shapeId) ?? null;
}

function operationsContainTextLikeShape(operations: AiEditDraft[]): boolean {
  return getVisualShapesFromOperations(operations).some((shape) => TEXT_LIKE_SHAPE_TYPES.has(shape.type));
}

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC_BYTES)) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface RenderVisualPreviewSessionLike {
  agentSession: { draftDocument: SigmaDocument; operations: AiEditDraft[] };
  targetId: string | null;
}

export interface RenderVisualPreviewOptions {
  /** Short deterministic code drawn into the captured preview for visual review. */
  badgeText?: string;
}

export interface ResvgLoaderResult {
  render: (svg: string) => Buffer;
}

interface ResvgModuleLike {
  Resvg: new (
    svg: string,
    options: { fitTo: { mode: "original" }; font: { loadSystemFonts: boolean } },
  ) => {
    render: () => { asPng: () => Buffer };
  };
}

// Deliberately routed through a variable (not a string literal in the import()
// call itself) so static bundlers (esbuild for the packaged Electron/MCP
// builds) cannot see the specifier and try to bundle this native, dev-only
// dependency. This used to go through `new Function("specifier", "return
// import(specifier)")` to hide the specifier from bundlers, but that indirection
// runs the dynamic import() in a detached V8 script/context that vitest's
// module runner (vite-node) does not register an `importModuleDynamically`
// callback for, so it always threw "A dynamic import callback was not
// specified" under `vitest run` — silently forcing every resvg-dependent test
// down the "unavailable" path (see resvgAvailable in sigma-doc-mcp-server.test.ts).
// A plain `import(specifier)` call is just as invisible to esbuild's static
// import graph (it only bundles literal string specifiers) while still
// running in the current realm, so it works under both Node and vitest.
async function importOptionalModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

export interface RenderVisualPreviewDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  loadResvg: () => Promise<ResvgLoaderResult | null>;
}

export type RenderVisualPreviewResult =
  | {
      source: "app-bridge";
      png: Buffer;
      width: number;
      height: number;
      capture: { pageIndex: number; cropRect: RenderRect };
      anchorBlockFound: boolean;
      warnings: string[];
    }
  | {
      source: "svg-fallback";
      png: Buffer;
      width: number;
      height: number;
      warnings: string[];
    }
  | {
      source: "none";
      svg: string | null;
      warnings: string[];
    };

export type RenderDocumentPageResult =
  | {
      source: "app-bridge";
      png: Buffer;
      width: number;
      height: number;
      pageNumber: number;
      totalPages: number;
      blockIds: string[];
      splitBlockIds: string[];
      warnings: string[];
    }
  | {
      source: "none";
      warnings: string[];
    };

export interface RenderDocumentPageInput {
  document: SigmaDocument;
  pageNumber?: number;
  blockId?: string;
  profile: OutputProfileName;
}

export interface RenderDocumentPreviewCacheContext {
  /** Store dataDir (or another stable physical-storage namespace). */
  storageNamespace: string;
  fileId: string;
  /** Current committed library revision. Draft/proposal changes are separated below. */
  revision: number;
  /** Includes run/room or proposal/session identity plus a hash of its changedIds/draft. */
  proposalIdentity?: string;
  /** Separates committed, proposal, write-verification, and visual-session render profiles. */
  renderSource: "committed" | "proposal" | "write-verification" | "visual-session";
}

const PREVIEW_CACHE_ENTRY_LIMIT = 16;
const PREVIEW_CACHE_PNG_BYTES_LIMIT = 32 * 1024 * 1024;
interface PreviewCacheEntry {
  result: Extract<RenderVisualPreviewResult, { source: "app-bridge" }>;
  pngBytes: number;
}
const previewCache = new Map<string, PreviewCacheEntry>();
let previewCachePngBytes = 0;
const renderDepsIds = new WeakMap<RenderVisualPreviewDeps, number>();
let nextRenderDepsId = 1;

export function hashPreviewCacheValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function getRenderDepsId(deps: RenderVisualPreviewDeps): number {
  const existing = renderDepsIds.get(deps);
  if (existing !== undefined) {
    return existing;
  }
  const created = nextRenderDepsId;
  nextRenderDepsId += 1;
  renderDepsIds.set(deps, created);
  return created;
}

function resolveRenderProfile(deps: RenderVisualPreviewDeps): string {
  const bridgeInfo = loadAiRenderBridgeInfo(deps.env);
  if (bridgeInfo.state === "ready") {
    return [
      `deps:${getRenderDepsId(deps)}`,
      "app-bridge",
      bridgeInfo.info.url,
      String(bridgeInfo.info.pid),
      bridgeInfo.info.createdAt,
    ].join(":");
  }
  if (bridgeInfo.state === "invalid") {
    return `deps:${getRenderDepsId(deps)}:invalid-bridge`;
  }
  return `deps:${getRenderDepsId(deps)}:svg-fallback`;
}

function readPreviewCache(key: string): RenderVisualPreviewResult | null {
  const cached = previewCache.get(key);
  if (!cached) {
    return null;
  }
  previewCache.delete(key);
  previewCache.set(key, cached);
  return cached.result;
}

function writePreviewCache(key: string, result: RenderVisualPreviewResult): void {
  // A transient bridge failure can recover without changing the bridge profile. Caching its
  // degraded fallback under that healthy profile would poison every identical render afterward.
  if (result.source !== "app-bridge") {
    return;
  }
  const existing = previewCache.get(key);
  if (existing) {
    previewCachePngBytes -= existing.pngBytes;
    previewCache.delete(key);
  }
  const entry: PreviewCacheEntry = { result, pngBytes: result.png.byteLength };
  previewCache.set(key, entry);
  previewCachePngBytes += entry.pngBytes;
  while (
    previewCache.size > PREVIEW_CACHE_ENTRY_LIMIT ||
    previewCachePngBytes > PREVIEW_CACHE_PNG_BYTES_LIMIT
  ) {
    const oldestKey = previewCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    const oldest = previewCache.get(oldestKey);
    if (oldest) {
      previewCachePngBytes -= oldest.pngBytes;
    }
    previewCache.delete(oldestKey);
  }
}

/** Internal cache reset for focused tests. Runtime entries are bounded by count and PNG bytes. */
export function resetDocumentPreviewCache(): void {
  previewCache.clear();
  previewCachePngBytes = 0;
}

export function createDefaultRenderVisualPreviewDeps(): RenderVisualPreviewDeps {
  return {
    env: process.env,
    fetchImpl: fetch,
    loadResvg: async () => {
      try {
        // lazy require: @resvg/resvg-js is a devDependency and is not bundled into
        // the packaged app (see WI-2 plan section 4). Packaged builds always have
        // the app-assisted render bridge available, so this path only matters for
        // dev/CLI usage where node_modules resolution works.
        const mod = (await importOptionalModule("@resvg/resvg-js")) as ResvgModuleLike;
        return {
          render: (svg: string) => {
            const resvg = new mod.Resvg(svg, {
              fitTo: { mode: "original" },
              font: { loadSystemFonts: true },
            });
            return resvg.render().asPng();
          },
        };
      } catch {
        return null;
      }
    },
  };
}

export async function renderDocumentPage(
  deps: RenderVisualPreviewDeps,
  input: RenderDocumentPageInput,
): Promise<RenderDocumentPageResult> {
  const bridgeInfo = loadAiRenderBridgeInfo(deps.env);
  if (bridgeInfo.state === "none") {
    return { source: "none", warnings: ["Sigma Studioのrender bridgeを利用できません。アプリを起動した状態で再実行してください。"] };
  }
  if (bridgeInfo.state === "invalid") {
    return { source: "none", warnings: [`render bridge情報が不正です: ${bridgeInfo.error}`] };
  }

  const pageMetrics = getPageMetrics(input.document.pageLayout);
  const pagePxSize = { width: pageMetrics.page.widthPx, height: pageMetrics.page.heightPx };
  const blockFocus = input.blockId
    ? computeBlockPreviewFocus(input.document, input.blockId, pagePxSize)
    : null;
  if (input.blockId && !blockFocus) {
    return { source: "none", warnings: [`指定されたblockIdが見つかりません: ${input.blockId}`] };
  }
  const requestedPageIndex = input.pageNumber !== undefined
    ? input.pageNumber - 1
    : blockFocus?.pageIndex ?? 0;
  const request: RenderPageContextRequest = {
    document: input.document as unknown as Record<string, unknown>,
    targetId: input.blockId ?? null,
    captureMode: "page",
    profile: input.profile,
    focus: {
      pageIndex: requestedPageIndex,
      overlayRect: { x: 0, y: 0, w: pagePxSize.width, h: pagePxSize.height },
      ...(input.blockId ? { preferTargetPage: true } : {}),
    },
  };

  let response: Response;
  try {
    incrementMcpStatsCounter("previewBridgeRenders");
    response = await deps.fetchImpl(`${bridgeInfo.info.url}/render-page-context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeInfo.info.token}`,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return {
      source: "none",
      warnings: [`render bridgeへの接続に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`],
    };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const bodyMessage = extractErrorMessageFromResponseBody(bodyText);
    return {
      source: "none",
      warnings: [`render bridgeがエラーを返しました (HTTP ${response.status})${bodyMessage ? `: ${bodyMessage}` : ""}`],
    };
  }

  let result: RenderPageContextResult;
  try {
    result = await response.json() as RenderPageContextResult;
  } catch (error) {
    return {
      source: "none",
      warnings: [`render bridgeの応答のJSON解析に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`],
    };
  }
  if (!result.ok) {
    return { source: "none", warnings: [`render bridgeでのレンダリングに失敗しました: ${result.error}`] };
  }
  if (
    typeof result.totalPages !== "number"
    || !Array.isArray(result.blockIds)
    || !Array.isArray(result.splitBlockIds)
  ) {
    return { source: "none", warnings: ["render bridgeの応答にページ情報がありません。Sigma Studioを最新版へ更新してください。"] };
  }

  return {
    source: "app-bridge",
    png: Buffer.from(result.pngBase64, "base64"),
    width: result.width,
    height: result.height,
    pageNumber: result.capture.pageIndex + 1,
    totalPages: result.totalPages,
    blockIds: result.blockIds,
    splitBlockIds: result.splitBlockIds,
    warnings: [],
  };
}

type RenderViaAppBridgeOutcome =
  | { ok: true; result: RenderVisualPreviewResult }
  | { ok: false; reason: string | null };

/**
 * reason is null when the bridge simply isn't configured (state:"none") — that
 * is the expected/common case (e.g. CLI usage, app not running) and is not
 * worth surfacing as a warning. Any other failure (invalid bridge file,
 * network error, non-2xx, malformed JSON, or an explicit ok:false from the
 * bridge) returns a human-readable reason so callers can tell the operator
 * *why* the preview fell back instead of silently returning svg-fallback/none.
 */
async function renderViaAppBridge(
  deps: RenderVisualPreviewDeps,
  session: RenderVisualPreviewSessionLike,
  focus: VisualPreviewFocus,
  badgeText?: string,
): Promise<RenderViaAppBridgeOutcome> {
  const bridgeInfo = loadAiRenderBridgeInfo(deps.env);
  if (bridgeInfo.state === "none") {
    return { ok: false, reason: null };
  }
  if (bridgeInfo.state === "invalid") {
    return { ok: false, reason: `render bridge情報が不正です: ${bridgeInfo.error}` };
  }

  // draftDocument is already a parsed/validated SigmaDocument (it came from
  // createSigmaDocAgentSession / rebuildVisualEditSessionDraft, not raw
  // user input), so re-parsing it here only risked throwing an error past
  // the svg-fallback path below for a document that is, by construction,
  // already valid. A plain structural cast to the request's JSON-record
  // shape is sufficient.
  const request: RenderPageContextRequest = {
    document: session.agentSession.draftDocument as unknown as Record<string, unknown>,
    targetId: session.targetId,
    focus,
    ...(badgeText ? { badgeText } : {}),
  };

  let response: Response;
  try {
    incrementMcpStatsCounter("previewBridgeRenders");
    response = await deps.fetchImpl(`${bridgeInfo.info.url}/render-page-context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeInfo.info.token}`,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return { ok: false, reason: `render bridgeへの接続に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const bodyMessage = extractErrorMessageFromResponseBody(bodyText);
    return {
      ok: false,
      reason: `render bridgeがエラーを返しました (HTTP ${response.status})${bodyMessage ? `: ${bodyMessage}` : ""}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    return { ok: false, reason: `render bridgeの応答のJSON解析に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}` };
  }

  const result = json as RenderPageContextResult;
  if (!result.ok) {
    return { ok: false, reason: `render bridgeでのレンダリングに失敗しました: ${result.error}` };
  }

  return {
    ok: true,
    result: {
      source: "app-bridge",
      png: Buffer.from(result.pngBase64, "base64"),
      width: result.width,
      height: result.height,
      capture: result.capture,
      anchorBlockFound: result.anchorBlockFound,
      warnings: [],
    },
  };
}

function extractErrorMessageFromResponseBody(bodyText: string): string | null {
  if (!bodyText) {
    return null;
  }
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // not JSON; fall through to returning the raw (truncated) body text below.
  }
  return bodyText.slice(0, 500);
}

async function renderViaSvgFallback(
  deps: RenderVisualPreviewDeps,
  operations: AiEditDraft[],
  bridgeFailureReason: string | null,
  pageLayoutDocument?: SigmaDocument,
  badgeText?: string,
): Promise<RenderVisualPreviewResult> {
  const bridgeWarning = bridgeFailureReason
    ? [`app bridgeでのレンダリングに失敗したためfallback previewを返します: ${bridgeFailureReason}`]
    : [];

  const shapePreview = buildShapeOnlyPreview(operations)
    ?? (pageLayoutDocument ? buildPageLayoutOnlyPreview(pageLayoutDocument) : null);
  if (!shapePreview) {
    return { source: "none", svg: null, warnings: bridgeWarning };
  }

  const badgeSvg = badgeText ? appendSvgPreviewBadge(shapePreview.svg, badgeText) : shapePreview.svg;
  const resvg = await deps.loadResvg();
  if (!resvg) {
    return { source: "none", svg: badgeSvg, warnings: bridgeWarning };
  }

  let png: Buffer;
  try {
    png = resvg.render(badgeSvg);
  } catch {
    return { source: "none", svg: badgeSvg, warnings: bridgeWarning };
  }

  const dimensions = readPngDimensions(png) ?? { width: shapePreview.width, height: shapePreview.height };
  const textWarning = operationsContainTextLikeShape(operations) ? [TEXT_LIKE_FALLBACK_WARNING] : [];
  const pageLayoutWarning = pageLayoutDocument ? [PAGE_LAYOUT_FALLBACK_WARNING] : [];

  return {
    source: "svg-fallback",
    png,
    width: dimensions.width,
    height: dimensions.height,
    warnings: [...bridgeWarning, ...textWarning, ...pageLayoutWarning],
  };
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Appends a small, high-contrast badge to an otherwise self-contained SVG. */
export function appendSvgPreviewBadge(svg: string, badgeText: string): string {
  const viewBoxMatch = svg.match(/viewBox=["']0\s+0\s+([\d.]+)\s+([\d.]+)["']/i);
  const widthMatch = svg.match(/\bwidth=["']([\d.]+)/i);
  const heightMatch = svg.match(/\bheight=["']([\d.]+)/i);
  const width = Number(viewBoxMatch?.[1] ?? widthMatch?.[1] ?? 1);
  const height = Number(viewBoxMatch?.[2] ?? heightMatch?.[1] ?? 1);
  const longSide = Math.max(width, height);
  const fontSize = Math.min(40, Math.max(14, longSide / 30));
  const padding = Math.max(4, fontSize * 0.28);
  const textWidth = Math.max(fontSize * 2, badgeText.length * fontSize * 0.68);
  const badgeWidth = textWidth + padding * 2;
  const badgeHeight = fontSize + padding * 2;
  const x = Math.max(0, width - badgeWidth - padding);
  const y = padding;
  const escaped = escapeSvgText(badgeText);
  const badge = [
    `<g data-sigma-ai-preview-badge="true">`,
    `<rect x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}" fill="#ffffff" stroke="#000000" stroke-width="1"/>`,
    `<text x="${x + badgeWidth / 2}" y="${y + padding + fontSize * 0.82}" text-anchor="middle" fill="#000000" font-family="monospace" font-size="${fontSize}" font-weight="700">${escaped}</text>`,
    `</g>`,
  ].join("");
  const closingTagIndex = svg.lastIndexOf("</svg>");
  return closingTagIndex >= 0
    ? `${svg.slice(0, closingTagIndex)}${badge}${svg.slice(closingTagIndex)}`
    : `${svg}${badge}`;
}

function buildPageLayoutOnlyPreview(document: SigmaDocument): { svg: string; width: number; height: number } {
  const metrics = getPageMetrics(document.pageLayout);
  const sourceWidth = metrics.page.widthPx;
  const sourceHeight = metrics.page.heightPx;
  const scale = Math.min(1, 900 / sourceWidth, 1_200 / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const bodyX = metrics.margins.leftPx;
  const bodyY = metrics.margins.topPx;
  const bodyWidth = metrics.content.widthPx;
  const bodyHeight = metrics.content.heightPx;
  const layout = document.pageLayout;
  const header = layout?.header?.enabled ? layout.header : null;
  const footer = layout?.footer?.enabled ? layout.footer : null;
  const headerRect = header
    ? `<rect x="${bodyX}" y="${mmToPx(header.offsetMm)}" width="${bodyWidth}" height="${mmToPx(header.heightMm)}" fill="#e2e8f0" stroke="#64748b" stroke-width="1"/>`
    : "";
  const footerRect = footer
    ? `<rect x="${bodyX}" y="${sourceHeight - mmToPx(footer.offsetMm + footer.heightMm)}" width="${bodyWidth}" height="${mmToPx(footer.heightMm)}" fill="#e2e8f0" stroke="#64748b" stroke-width="1"/>`
    : "";
  const label = layout
    ? `${layout.preset} ${layout.orientation} ${layout.pageSize.widthMm} x ${layout.pageSize.heightMm} mm`
    : `${metrics.page.widthMm} x ${metrics.page.heightMm} mm`;

  return {
    width,
    height,
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sourceWidth} ${sourceHeight}">`,
      `<rect width="${sourceWidth}" height="${sourceHeight}" fill="#ffffff"/>`,
      `<rect x="0.75" y="0.75" width="${Math.max(0, sourceWidth - 1.5)}" height="${Math.max(0, sourceHeight - 1.5)}" fill="none" stroke="#334155" stroke-width="1.5"/>`,
      `<rect x="${bodyX}" y="${bodyY}" width="${bodyWidth}" height="${bodyHeight}" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.25" stroke-dasharray="6 4"/>`,
      headerRect,
      footerRect,
      `<text x="${bodyX + 8}" y="${Math.max(16, bodyY + 20)}" fill="#475569" font-family="sans-serif" font-size="14">${label}</text>`,
      "</svg>",
    ].join(""),
  };
}

/** Generic input for renderDocumentPreview: any draft/committed document plus the block or
 * shapes an agent wants context around. `operations` (AiEditDraft-family insert ops) carry full
 * shape geometry directly; `changedIds` is a fallback used to resolve shapes that already exist
 * in the document's overlay snapshot (e.g. after update_shape/align_shapes/delete_shapes, whose
 * mutation ops reference shapes by id only) or, failing that, a flow block to frame the page
 * around. */
export interface RenderDocumentPreviewInput {
  document: SigmaDocument;
  targetId: string | null;
  operations?: AiEditDraft[];
  changedIds?: string[];
  /** When the app bridge is unavailable, render the updated paper/margin frame as page 1. */
  pageLayoutFallback?: boolean;
  badgeText?: string;
  cache?: RenderDocumentPreviewCacheContext;
}

function resolveRenderFocus(
  input: RenderDocumentPreviewInput,
  pagePxSize: { width: number; height: number },
): VisualPreviewFocus | null {
  const opShapes = getVisualShapesFromOperations(input.operations ?? []);
  if (opShapes.length > 0) {
    return computeShapesPreviewFocus(opShapes, pagePxSize);
  }

  const shapesById = (input.changedIds ?? [])
    .map((id) => findOverlayShapeById(input.document, id))
    .filter((shape): shape is OverlayShape => shape !== null);
  if (shapesById.length > 0) {
    return computeShapesPreviewFocus(shapesById, pagePxSize);
  }

  const blockId = input.targetId ?? input.changedIds?.[0] ?? null;
  const blockFocus = computeBlockPreviewFocus(input.document, blockId, pagePxSize);
  if (blockFocus) {
    return blockFocus;
  }
  return input.pageLayoutFallback
    ? { pageIndex: 0, overlayRect: { x: 0, y: 0, w: pagePxSize.width, h: pagePxSize.height } }
    : null;
}

/**
 * The render bridge can measure a flow block through `data-sigma-doc-id`, but
 * overlay shapes are flattened into the print SVG and therefore have no DOM
 * anchor with that attribute. Passing a shape id as `targetId` made the bridge
 * reject an otherwise valid shape-focused capture with anchorBlockFound:false.
 *
 * Shape insert operations still carry their real flow-block anchor, so retain
 * that page context when available. Shape mutations only carry shape ids; for
 * those, the already-computed overlay focus is sufficient and the DOM anchor
 * must intentionally be null.
 */
export function resolveRenderBridgeTargetId(input: RenderDocumentPreviewInput): string | null {
  const operations = input.operations ?? [];
  const shapeInsertAnchorId = operations.find((operation) =>
    operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape")?.targetId;
  if (shapeInsertAnchorId && findBlock(input.document, shapeInsertAnchorId)) {
    return shapeInsertAnchorId;
  }

  const insertedShapeIds = new Set(getVisualShapesFromOperations(operations).map((shape) => shape.id));
  if (input.targetId && (insertedShapeIds.has(input.targetId) || findOverlayShapeById(input.document, input.targetId))) {
    return null;
  }

  return input.targetId;
}

/**
 * Renders page context around an arbitrary document + target block/shape(s) — the generalization
 * of renderVisualPreview (which only ever rendered around shapes in a visual edit session's own
 * operations) used by post-write verification and the render_block_context tool. Shares the same
 * app-bridge/svg-fallback machinery, so the source/warnings contract is identical.
 */
export async function renderDocumentPreview(
  deps: RenderVisualPreviewDeps,
  input: RenderDocumentPreviewInput,
): Promise<RenderVisualPreviewResult> {
  // Persisted proposals can be edited outside the app. Never hand an unsafe asset URL to the
  // hidden renderer or SVG fallback even if an upstream proposal quarantine check regresses.
  assertAiOverlayAssetsInDocument(input.document);
  const pageMetrics = getPageMetrics(input.document.pageLayout);
  const pagePxSize = { width: pageMetrics.page.widthPx, height: pageMetrics.page.heightPx };
  const focus = resolveRenderFocus(input, pagePxSize);

  if (!focus) {
    return { source: "none", svg: null, warnings: ["プレビュー対象のブロックまたは図形を特定できませんでした。"] };
  }

  const bridgeTargetId = resolveRenderBridgeTargetId(input);
  const cacheKey = input.cache
    ? hashPreviewCacheValue({
        storageNamespace: input.cache.storageNamespace,
        fileId: input.cache.fileId,
        revision: input.cache.revision,
        proposalIdentity: input.cache.proposalIdentity ?? null,
        renderSource: input.cache.renderSource,
        renderProfile: resolveRenderProfile(deps),
        operations: hashPreviewCacheValue(input.operations ?? []),
        changedIds: input.changedIds ?? [],
        targetId: bridgeTargetId,
        focus,
        badgeText: input.badgeText ?? null,
      })
    : null;
  if (cacheKey) {
    const cached = readPreviewCache(cacheKey);
    if (cached) {
      incrementMcpStatsCounter("previewCacheHits");
      return cached;
    }
    incrementMcpStatsCounter("previewCacheMisses");
  }

  const bridgeOutcome = await renderViaAppBridge(
    deps,
    {
      agentSession: { draftDocument: input.document, operations: input.operations ?? [] },
      targetId: bridgeTargetId,
    },
    focus,
    input.badgeText,
  );
  if (bridgeOutcome.ok) {
    if (cacheKey) {
      writePreviewCache(cacheKey, bridgeOutcome.result);
    }
    return bridgeOutcome.result;
  }

  // Regardless of whether the svg fallback itself succeeds or also ends up
  // source:"none", bridgeFailureReason (if any) is already folded into its
  // warnings by renderViaSvgFallback, so callers always see why a non-bridge
  // source was used.
  return renderViaSvgFallback(
    deps,
    input.operations ?? [],
    bridgeOutcome.reason,
    input.pageLayoutFallback ? input.document : undefined,
    input.badgeText,
  );
}

export async function renderVisualPreview(
  deps: RenderVisualPreviewDeps,
  session: RenderVisualPreviewSessionLike,
  cache?: RenderDocumentPreviewCacheContext,
  options: RenderVisualPreviewOptions = {},
): Promise<RenderVisualPreviewResult> {
  return renderDocumentPreview(deps, {
    document: session.agentSession.draftDocument,
    targetId: session.targetId,
    operations: session.agentSession.operations,
    badgeText: options.badgeText,
    cache,
  });
}
