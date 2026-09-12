import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { z } from "zod";

import { SHAPE_PREVIEW_PADDING_PX } from "@/lib/ai/ai-edit-shape-preview";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

export const SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV = "SIGMA_STUDIO_RENDER_BRIDGE_FILE";

const DATA_DIR_NAME = "data";
const RENDER_BRIDGE_DIR_NAME = "ai-run-context";
const RENDER_BRIDGE_FILE_NAME = "render-bridge.json";

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const RENDER_PAGE_CONTEXT_PATH = "/render-page-context";
/**
 * Rasterizes a self-contained SVG through the app's own renderer.
 *
 * The MCP process can draw a 3D figure to SVG without a GPU, but turning that into the PNG the
 * document format accepts needs a rasterizer. `@resvg/resvg-js` is a devDependency and is absent
 * from a packaged build, so without this the one case that matters — a packaged app, a proposal
 * approved and printed before anyone opened the page — had no way to produce the picture at all.
 */
const RENDER_SVG_PATH = "/render-svg";
/** Characters, not bytes — `MAX_REQUEST_BODY_BYTES` is what bounds the encoded payload. */
const MAX_RENDER_SVG_CHARS = 24 * 1024 * 1024;
const MAX_RENDER_SVG_DIMENSION = 8192;
/**
 * Both sides of the canvas are capped, and so is their product: 8192×8192 is inside the
 * per-side limit but is a 268MB canvas allocation in the app's own process.
 * Mirrors `MAX_AI_OVERLAY_ASSET_PIXELS`, the ceiling the document format accepts anyway.
 */
const MAX_RENDER_SVG_PIXELS = 25_000_000;

export const AiRenderBridgeInfoSchema = z.object({
  version: z.literal(1),
  url: z.string().min(1),
  token: z.string().min(1),
  pid: z.number().int(),
  createdAt: z.string().min(1),
});

export type AiRenderBridgeInfo = z.infer<typeof AiRenderBridgeInfoSchema>;

export type AiRenderBridgeLoadResult =
  | { state: "none" }
  | { state: "invalid"; error: string }
  | { state: "ready"; info: AiRenderBridgeInfo };

function isEnoent(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && "code" in (error as Record<string, unknown>)
    && (error as { code?: string }).code === "ENOENT";
}

export function loadAiRenderBridgeInfo(env: Record<string, string | undefined>): AiRenderBridgeLoadResult {
  const filePath = env[SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]?.trim();
  if (!filePath) {
    return { state: "none" };
  }

  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { state: "none" };
    }
    return { state: "invalid", error: error instanceof Error ? error.message : ta("desktop.renderBridge.readFailed") };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.message : ta("desktop.renderBridge.jsonReadFailed") };
  }

  const parsed = AiRenderBridgeInfoSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { state: "invalid", error: parsed.error.message };
  }

  return { state: "ready", info: parsed.data };
}

export class LocalAiRenderBridgeStore {
  private readonly bridgeFilePath: string;

  constructor(userDataPath: string) {
    this.bridgeFilePath = path.join(userDataPath, DATA_DIR_NAME, RENDER_BRIDGE_DIR_NAME, RENDER_BRIDGE_FILE_NAME);
  }

  getBridgeFilePath(): string {
    return this.bridgeFilePath;
  }

  async write(info: AiRenderBridgeInfo): Promise<void> {
    await fs.mkdir(path.dirname(this.bridgeFilePath), { recursive: true });
    const tmpPath = `${this.bridgeFilePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(info), "utf8");
    await fs.rename(tmpPath, this.bridgeFilePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.bridgeFilePath);
    } catch (error) {
      if (!isEnoent(error)) {
        console.warn("render bridge情報の削除に失敗しました。", error);
      }
    }
  }
}

export interface RenderRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PreviewBadgeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  padding: number;
}

/**
 * Places the visual-review code in the final output bitmap rather than in the
 * print DOM. The latter is captured and then resized, which could make the
 * badge too small to read (or miss a compositor frame in a hidden window).
 */
export function computePreviewBadgeLayout(
  imageWidth: number,
  imageHeight: number,
  badgeText: string,
): PreviewBadgeLayout {
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const longSide = Math.max(width, height);
  const fontSize = Math.min(40, Math.max(18, longSide / 30));
  const padding = Math.max(4, fontSize * 0.28);
  const textWidth = Math.max(fontSize * 2, badgeText.length * fontSize * 0.68);
  const badgeWidth = Math.min(width, textWidth + padding * 2);
  const badgeHeight = Math.min(height, fontSize + padding * 2);
  return {
    x: Math.max(0, width - badgeWidth - padding),
    y: Math.min(Math.max(0, padding), Math.max(0, height - badgeHeight)),
    width: badgeWidth,
    height: badgeHeight,
    fontSize,
    padding,
  };
}

export interface RenderPageContextRequestFocus {
  pageIndex: number;
  overlayRect: RenderRect;
  /**
   * Flow pagination is estimated in the MCP process, while the print renderer
   * owns the actual page split. When true, the target block's DOM page is the
   * authoritative capture page and pageIndex is only an initial estimate.
   */
  preferTargetPage?: boolean;
}

export const RenderRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const RenderPageContextRequestSchema = z.object({
  document: z.record(z.string(), z.unknown()),
  targetId: z.string().min(1).nullable(),
  captureMode: z.enum(["context", "page"]).optional(),
  profile: z.enum(["student", "teacher", "answerBook"]).optional(),
  focus: z.object({
    pageIndex: z.number().int().nonnegative(),
    overlayRect: RenderRectSchema,
    preferTargetPage: z.boolean().optional(),
  }),
  paddingPx: z.number().nonnegative().optional(),
  maxLongSidePx: z.number().positive().optional(),
  badgeText: z.string().min(1).optional(),
});

export type RenderPageContextRequest = z.infer<typeof RenderPageContextRequestSchema>;

export interface RenderPageContextSuccess {
  ok: true;
  pngBase64: string;
  width: number;
  height: number;
  capture: { pageIndex: number; cropRect: RenderRect };
  anchorBlockFound: boolean;
  totalPages?: number;
  blockIds?: string[];
  splitBlockIds?: string[];
}

export interface RenderPageContextFailure {
  ok: false;
  error: string;
}

export type RenderPageContextResult = RenderPageContextSuccess | RenderPageContextFailure;

export type ResolvePageContextCapturePageResult =
  | { ok: true; pageIndex: number }
  | { ok: false; error: string };

/**
 * Resolves the page that is safe to capture after the hidden print renderer
 * has measured the real DOM. A flow block's actual page wins over the MCP
 * process's estimate. For shape-focused captures, a block anchor on a
 * different page is rejected instead of silently returning an unrelated page.
 */
export function resolvePageContextCapturePage(input: {
  requestedPageIndex: number;
  pageCount: number;
  targetId: string | null;
  anchorBlockFound: boolean;
  anchorPageIndex: number | null;
  preferTargetPage?: boolean;
}): ResolvePageContextCapturePageResult {
  if (input.pageCount <= 0) {
    return { ok: false, error: ta("desktop.renderBridge.noPages") };
  }

  if (input.targetId) {
    if (!input.anchorBlockFound) {
      return { ok: false, error: ta("desktop.renderBridge.anchorNotFound", { targetId: input.targetId }) };
    }
    if (
      input.anchorPageIndex === null
      || input.anchorPageIndex < 0
      || input.anchorPageIndex >= input.pageCount
    ) {
      return { ok: false, error: ta("desktop.renderBridge.targetNotFound", { targetId: input.targetId }) };
    }
    if (input.preferTargetPage) {
      return { ok: true, pageIndex: input.anchorPageIndex };
    }
    if (input.anchorPageIndex !== input.requestedPageIndex) {
      return {
        ok: false,
        error: ta("desktop.renderBridge.pageMismatch", {
          anchorPage: input.anchorPageIndex,
          requestedPage: input.requestedPageIndex,
          targetId: input.targetId,
        }),
      };
    }
  }

  if (input.requestedPageIndex < 0 || input.requestedPageIndex >= input.pageCount) {
    return { ok: false, error: ta("desktop.renderBridge.pageNotFound", { pageIndex: input.requestedPageIndex }) };
  }
  return { ok: true, pageIndex: input.requestedPageIndex };
}

export const RenderSvgRequestSchema = z.object({
  /** A self-contained SVG document. External references are not fetched by the renderer. */
  svg: z.string().min(1).max(MAX_RENDER_SVG_CHARS),
  width: z.number().int().positive().max(MAX_RENDER_SVG_DIMENSION),
  height: z.number().int().positive().max(MAX_RENDER_SVG_DIMENSION),
}).refine((value) => value.width * value.height <= MAX_RENDER_SVG_PIXELS, {
  error: () => ta("desktop.renderBridge.invalidRequest"),
});

export type RenderSvgRequest = z.infer<typeof RenderSvgRequestSchema>;

export interface RenderSvgSuccess {
  ok: true;
  pngBase64: string;
  width: number;
  height: number;
}

export type RenderSvgResult = RenderSvgSuccess | RenderPageContextFailure;

export interface CreateAiRenderBridgeServerDeps {
  token: string;
  renderPageContext: (request: RenderPageContextRequest) => Promise<RenderPageContextResult>;
  renderSvg: (request: RenderSvgRequest) => Promise<RenderSvgResult>;
  parseDocument: (input: unknown) => unknown;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function timingSafeTokenEquals(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const actual = header.slice("Bearer ".length);
  return timingSafeTokenEquals(token, actual);
}

async function readRequestBody(req: http.IncomingMessage): Promise<{ ok: true; body: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let settled = false;

    const finish = (result: { ok: true; body: Buffer } | { ok: false; error: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        finish({ ok: false, error: ta("desktop.renderBridge.bodyTooLarge") });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      finish({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : ta("desktop.renderBridge.requestReadFailed") });
    });
  });
}

export function createAiRenderBridgeServer(deps: CreateAiRenderBridgeServerDeps): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const isPageContext = req.method === "POST" && req.url === RENDER_PAGE_CONTEXT_PATH;
      const isSvg = req.method === "POST" && req.url === RENDER_SVG_PATH;
      if (!isPageContext && !isSvg) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      if (!isAuthorized(req, deps.token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const bodyResult = await readRequestBody(req);
      if (!bodyResult.ok) {
        sendJson(res, 400, { ok: false, error: bodyResult.error });
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(bodyResult.body.toString("utf8"));
      } catch {
        sendJson(res, 400, { ok: false, error: ta("desktop.renderBridge.requestJsonFailed") });
        return;
      }

      if (isSvg) {
        const parsedSvgRequest = RenderSvgRequestSchema.safeParse(parsedJson);
        if (!parsedSvgRequest.success) {
          sendJson(res, 400, {
            ok: false,
            error: ta("desktop.renderBridge.invalidRequest"),
            details: parsedSvgRequest.error.issues,
          });
          return;
        }
        try {
          const result = await deps.renderSvg(parsedSvgRequest.data);
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : ta("desktop.renderBridge.renderFailed"),
          });
        }
        return;
      }

      const parsedRequest = RenderPageContextRequestSchema.safeParse(parsedJson);
      if (!parsedRequest.success) {
        sendJson(res, 400, { ok: false, error: ta("desktop.renderBridge.invalidRequest"), details: parsedRequest.error.issues });
        return;
      }

      try {
        deps.parseDocument(parsedRequest.data.document);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: ta("desktop.renderBridge.invalidDocument", {
            reason: error instanceof Error ? error.message : ta("desktop.renderBridge.unknownError"),
          }),
        });
        return;
      }

      try {
        const result = await deps.renderPageContext(parsedRequest.data);
        if (!result.ok) {
          sendJson(res, 502, result);
          return;
        }
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : ta("desktop.renderBridge.renderFailed") });
      }
    })();
  });
}

export interface ComputePageContextCaptureRectInput {
  anchorRectDip: RenderRect | null;
  pageRectDip: RenderRect;
  overlayRect: RenderRect;
  pagePxSize: { width: number; height: number };
  paddingPx?: number;
  maxLongSidePx?: number;
}

export interface ComputePageContextCaptureRectResult {
  cropRectDip: RenderRect;
  scale: number;
  /**
   * The maxLongSidePx actually used to compute `scale` (input.maxLongSidePx if
   * provided, otherwise DEFAULT_MAX_LONG_SIDE_PX). Callers that also need to
   * decide a render-window resize policy (main.ts renderAiPageContextPng) must
   * consume this instead of independently re-resolving
   * `request.maxLongSidePx ?? DEFAULT_MAX_LONG_SIDE_PX`, so the crop and
   * resize policies can never diverge.
   */
  resolvedMaxLongSidePx: number;
}

// Reuse the same padding as the shape-only SVG fallback preview
// (ai-edit-shape-preview.ts) so the app-bridge and fallback previews frame
// shapes with identical breathing room.
const DEFAULT_CAPTURE_PADDING_PX = SHAPE_PREVIEW_PADDING_PX;
export const DEFAULT_MAX_LONG_SIDE_PX = 2000;

function unionRects(a: RenderRect, b: RenderRect): RenderRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

function expandRect(rect: RenderRect, paddingPx: number): RenderRect {
  return {
    x: rect.x - paddingPx,
    y: rect.y - paddingPx,
    w: rect.w + paddingPx * 2,
    h: rect.h + paddingPx * 2,
  };
}

function clampRectToPage(rect: RenderRect, pageRectDip: RenderRect): RenderRect {
  const left = Math.max(rect.x, pageRectDip.x);
  const top = Math.max(rect.y, pageRectDip.y);
  const right = Math.min(rect.x + rect.w, pageRectDip.x + pageRectDip.w);
  const bottom = Math.min(rect.y + rect.h, pageRectDip.y + pageRectDip.h);
  return {
    x: left,
    y: top,
    w: Math.max(0, right - left),
    h: Math.max(0, bottom - top),
  };
}

/**
 * overlayRect (ドキュメント座標, pagePxSize 基準) をページDIP座標に変換し、
 * anchor block の矩形と結合した上でページ矩形にクランプする。
 *
 * overlayRect.y is expected to already be page-local (0..pagePxSize.height range,
 * possibly slightly negative/over due to padding) — the caller (sigma-doc-mcp-preview.ts
 * computeVisualPreviewFocus) resolves pageIndex/localY from the UNPADDED shape bounds
 * before applying padding. Re-deriving the page split here from an already-padded
 * rect via modulo would wrap a shape within `paddingPx` of a page top to the
 * previous page's bottom, so this function does not modulo overlayRect.y — it only
 * scales + clamps within the given page rect.
 */
export function computePageContextCaptureRect(
  input: ComputePageContextCaptureRectInput,
): ComputePageContextCaptureRectResult {
  const { pageRectDip, overlayRect, pagePxSize, anchorRectDip } = input;
  const paddingPx = input.paddingPx ?? DEFAULT_CAPTURE_PADDING_PX;
  const maxLongSidePx = input.maxLongSidePx ?? DEFAULT_MAX_LONG_SIDE_PX;
  const scale = pageRectDip.w / pagePxSize.width;

  const overlayRectPageDip: RenderRect = {
    x: pageRectDip.x + overlayRect.x * scale,
    y: pageRectDip.y + overlayRect.y * scale,
    w: overlayRect.w * scale,
    h: overlayRect.h * scale,
  };

  const unionRectDip = anchorRectDip ? unionRects(anchorRectDip, overlayRectPageDip) : overlayRectPageDip;
  const expandedRectDip = expandRect(unionRectDip, paddingPx * scale);
  const cropRectDip = clampRectToPage(expandedRectDip, pageRectDip);

  const longSidePx = Math.max(cropRectDip.w, cropRectDip.h);
  if (longSidePx <= maxLongSidePx || longSidePx === 0) {
    return { cropRectDip, scale, resolvedMaxLongSidePx: maxLongSidePx };
  }

  const shrinkFactor = maxLongSidePx / longSidePx;
  return { cropRectDip, scale: scale * shrinkFactor, resolvedMaxLongSidePx: maxLongSidePx };
}
