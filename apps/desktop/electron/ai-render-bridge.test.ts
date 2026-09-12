import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AiRenderBridgeInfoSchema,
  computePageContextCaptureRect,
  computePreviewBadgeLayout,
  createAiRenderBridgeServer,
  LocalAiRenderBridgeStore,
  loadAiRenderBridgeInfo,
  resolvePageContextCapturePage,
  SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV,
  type AiRenderBridgeInfo,
  type RenderPageContextRequest,
  type RenderPageContextResult,
  type RenderSvgRequest,
  type RenderSvgResult,
} from "./ai-render-bridge";

const A4_PAGE_PX = { width: 794, height: 1123 };

describe("AiRenderBridgeInfoSchema", () => {
  it("accepts a well-formed bridge info object", () => {
    const info: AiRenderBridgeInfo = {
      version: 1,
      url: "http://127.0.0.1:12345",
      token: "secret-token",
      pid: 1234,
      createdAt: "2026-07-02T00:00:00.000Z",
    };
    expect(AiRenderBridgeInfoSchema.safeParse(info).success).toBe(true);
  });

  it("rejects a version other than 1", () => {
    expect(
      AiRenderBridgeInfoSchema.safeParse({
        version: 2,
        url: "http://127.0.0.1:1",
        token: "t",
        pid: 1,
        createdAt: "x",
      }).success,
    ).toBe(false);
  });
});

describe("computePreviewBadgeLayout", () => {
  it("keeps a five-character review code readable and inside the final resized PNG", () => {
    const layout = computePreviewBadgeLayout(1_200, 800, "K7Q2X");

    expect(layout.fontSize).toBe(40);
    expect(layout.x).toBeGreaterThanOrEqual(0);
    expect(layout.y).toBeGreaterThanOrEqual(0);
    expect(layout.x + layout.width).toBeLessThanOrEqual(1_200);
    expect(layout.y + layout.height).toBeLessThanOrEqual(800);
  });

  it("clamps the badge for a very small output image", () => {
    const layout = computePreviewBadgeLayout(40, 20, "K7Q2X");

    expect(layout.width).toBeLessThanOrEqual(40);
    expect(layout.height).toBeLessThanOrEqual(20);
    expect(layout.x + layout.width).toBeLessThanOrEqual(40);
    expect(layout.y + layout.height).toBeLessThanOrEqual(20);
  });
});

describe("LocalAiRenderBridgeStore / loadAiRenderBridgeInfo", () => {
  let userDataDir: string;
  let store: LocalAiRenderBridgeStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-render-bridge-"));
    store = new LocalAiRenderBridgeStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  const validInfo: AiRenderBridgeInfo = {
    version: 1,
    url: "http://127.0.0.1:23456",
    token: "tok",
    pid: 999,
    createdAt: "2026-07-02T00:00:00.000Z",
  };

  it("returns state:none when the env var is unset or blank", () => {
    expect(loadAiRenderBridgeInfo({}).state).toBe("none");
    expect(loadAiRenderBridgeInfo({ [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: " " }).state).toBe("none");
  });

  it("returns state:none when the file does not exist", () => {
    const missing = path.join(userDataDir, "missing.json");
    expect(loadAiRenderBridgeInfo({ [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: missing }).state).toBe("none");
  });

  it("returns state:invalid for malformed JSON", async () => {
    const filePath = path.join(userDataDir, "bad.json");
    await fs.writeFile(filePath, "{not json", "utf8");
    const result = loadAiRenderBridgeInfo({ [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: filePath });
    expect(result.state).toBe("invalid");
  });

  it("returns state:invalid for JSON that fails schema validation", async () => {
    const filePath = path.join(userDataDir, "invalid.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 1 }), "utf8");
    const result = loadAiRenderBridgeInfo({ [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: filePath });
    expect(result.state).toBe("invalid");
  });

  it("roundtrips a written bridge info file, and clear() makes it none again", async () => {
    await store.write(validInfo);
    const result = loadAiRenderBridgeInfo({
      [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: store.getBridgeFilePath(),
    });
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.info).toEqual(validInfo);
    }

    await store.clear();
    const afterClear = loadAiRenderBridgeInfo({
      [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: store.getBridgeFilePath(),
    });
    expect(afterClear.state).toBe("none");
  });

  it("clear() is best-effort and does not throw when the file is missing", async () => {
    await expect(store.clear()).resolves.not.toThrow();
  });

  it("write() is atomic: no leftover tmp file", async () => {
    await store.write(validInfo);
    const dir = path.dirname(store.getBridgeFilePath());
    const entries = await fs.readdir(dir);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("createAiRenderBridgeServer", () => {
  const TOKEN = "test-token-123";
  let server: ReturnType<typeof createAiRenderBridgeServer>;
  let lastRequest: RenderPageContextRequest | null;
  let lastSvgRequest: RenderSvgRequest | null;
  let renderResult: RenderPageContextResult;
  let renderSvgResult: RenderSvgResult;

  function fakeParseDocument(input: unknown): unknown {
    if (!input || typeof input !== "object" || !("docId" in (input as Record<string, unknown>))) {
      throw new Error("docId is required");
    }
    return input;
  }

  beforeEach(() => {
    lastRequest = null;
    lastSvgRequest = null;
    renderSvgResult = { ok: true, pngBase64: "iVBORw0KGgo=", width: 12, height: 8 };
    renderResult = {
      ok: true,
      pngBase64: "iVBORw0KGgo=",
      width: 100,
      height: 200,
      capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 100, h: 200 } },
      anchorBlockFound: true,
    };

    server = createAiRenderBridgeServer({
      token: TOKEN,
      parseDocument: fakeParseDocument,
      renderPageContext: async (request) => {
        lastRequest = request;
        return renderResult;
      },
      renderSvg: async (request) => {
        lastSvgRequest = request;
        return renderSvgResult;
      },
    });

  });

  async function requestBridge(
    route: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
    return new Promise((resolve) => {
      const request = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as IncomingMessage;
      request.method = options.method;
      request.url = route;
      request.headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      );

      let statusCode = 200;
      const response = {
        writeHead(code: number) {
          statusCode = code;
          return this;
        },
        end(body?: string | Buffer) {
          const text = body === undefined ? "" : body.toString();
          resolve({
            status: statusCode,
            json: async () => JSON.parse(text) as Record<string, unknown>,
          });
          return this;
        },
      } as unknown as ServerResponse;

      // Exercise the real http.Server request listener without binding a port.
      server.emit("request", request, response);
    });
  }

  const validBody = {
    document: { docId: "doc_1" },
    targetId: "block_1",
    focus: { pageIndex: 0, overlayRect: { x: 10, y: 20, w: 30, h: 40 } },
  };

  it("returns 401 for a wrong or missing bearer token", async () => {
    const wrongToken = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(validBody),
    });
    expect(wrongToken.status).toBe(401);

    const noAuth = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(noAuth.status).toBe(401);
  });

  it("returns 400 when the request body fails schema validation", async () => {
    const res = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ document: {} }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 400 when the document fails re-validation as a SigmaDocument", async () => {
    const res = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...validBody, document: { notADoc: true } }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("returns 200 with the rendered PNG payload on a valid authorized request", async () => {
    const res = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.pngBase64).toBe(renderResult.ok ? renderResult.pngBase64 : undefined);
    expect(json.width).toBe(100);
    expect(json.height).toBe(200);
    expect(json.anchorBlockFound).toBe(true);

    expect(lastRequest?.targetId).toBe("block_1");
    expect(lastRequest?.focus).toEqual(validBody.focus);
  });

  it("accepts and forwards the optional badgeText render request field", async () => {
    const res = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...validBody, badgeText: "K7Q2X" }),
    });
    expect(res.status).toBe(200);
    expect(lastRequest?.badgeText).toBe("K7Q2X");
  });

  it("accepts and forwards full-page capture mode and output profile", async () => {
    const res = await requestBridge("/render-page-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...validBody, captureMode: "page", profile: "answerBook" }),
    });
    expect(res.status).toBe(200);
    expect(lastRequest?.captureMode).toBe("page");
    expect(lastRequest?.profile).toBe("answerBook");
  });

  it("returns 404 for unknown paths or non-POST methods", async () => {
    const wrongPath = await requestBridge("/not-a-route", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await requestBridge("/render-page-context", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(wrongMethod.status).toBe(404);
  });

  it("rasterizes a self-contained SVG on /render-svg", async () => {
    const res = await requestBridge("/render-svg", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", width: 12, height: 8 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pngBase64: "iVBORw0KGgo=" });
    expect(lastSvgRequest).toMatchObject({ width: 12, height: 8 });
  });

  it("requires the bearer token on /render-svg", async () => {
    const res = await requestBridge("/render-svg", {
      method: "POST",
      body: JSON.stringify({ svg: "<svg/>", width: 12, height: 8 }),
    });

    expect(res.status).toBe(401);
    expect(lastSvgRequest).toBeNull();
  });

  it("rejects an /render-svg request with a missing or oversized canvas", async () => {
    const missingSize = await requestBridge("/render-svg", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ svg: "<svg/>" }),
    });
    expect(missingSize.status).toBe(400);

    const hugeSize = await requestBridge("/render-svg", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ svg: "<svg/>", width: 100_000, height: 8 }),
    });
    expect(hugeSize.status).toBe(400);

    // 片辺は上限内でも、面積は 268MB の canvas になる組み合わせ。
    const hugeArea = await requestBridge("/render-svg", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ svg: "<svg/>", width: 8192, height: 8192 }),
    });
    expect(hugeArea.status).toBe(400);
    expect(lastSvgRequest).toBeNull();
  });

  it("reports a failed rasterization as 502 rather than throwing", async () => {
    renderSvgResult = { ok: false, error: "canvas unavailable" };

    const res = await requestBridge("/render-svg", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ svg: "<svg/>", width: 12, height: 8 }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe("computePageContextCaptureRect", () => {
  const pageRectDip: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 397, h: 561.5 };

  it("unions the anchor rect and shape rect, applies padding, and stays within the page rect", () => {
    const result = computePageContextCaptureRect({
      anchorRectDip: { x: 50, y: 50, w: 20, h: 20 },
      pageRectDip,
      overlayRect: { x: 100, y: 100, w: 50, h: 50 },
      pagePxSize: A4_PAGE_PX,
    });

    const scale = pageRectDip.w / A4_PAGE_PX.width;
    const overlayRectDip = { x: 100 * scale, y: 100 * scale, w: 50 * scale, h: 50 * scale };
    const expectedUnion = {
      x: Math.min(50, overlayRectDip.x),
      y: Math.min(50, overlayRectDip.y),
      right: Math.max(70, overlayRectDip.x + overlayRectDip.w),
      bottom: Math.max(70, overlayRectDip.y + overlayRectDip.h),
    };
    const paddingDip = 32 * scale;
    expect(result.cropRectDip.x).toBeCloseTo(expectedUnion.x - paddingDip, 5);
    expect(result.cropRectDip.y).toBeCloseTo(expectedUnion.y - paddingDip, 5);
    expect(result.cropRectDip.w).toBeCloseTo(expectedUnion.right - expectedUnion.x + paddingDip * 2, 5);
    expect(result.cropRectDip.h).toBeCloseTo(expectedUnion.bottom - expectedUnion.y + paddingDip * 2, 5);
  });

  it("uses overlayRect only when anchor is absent", () => {
    const result = computePageContextCaptureRect({
      anchorRectDip: null,
      pageRectDip,
      overlayRect: { x: 100, y: 100, w: 50, h: 50 },
      pagePxSize: A4_PAGE_PX,
      paddingPx: 0,
    });
    const scale = pageRectDip.w / A4_PAGE_PX.width;
    expect(result.cropRectDip.x).toBeCloseTo(100 * scale, 5);
    expect(result.cropRectDip.y).toBeCloseTo(100 * scale, 5);
    expect(result.cropRectDip.w).toBeCloseTo(50 * scale, 5);
    expect(result.cropRectDip.h).toBeCloseTo(50 * scale, 5);
  });

  it("clamps the crop rect to the page rect bounds", () => {
    const result = computePageContextCaptureRect({
      anchorRectDip: null,
      pageRectDip,
      overlayRect: { x: A4_PAGE_PX.width - 10, y: A4_PAGE_PX.height - 10, w: 100, h: 100 },
      pagePxSize: A4_PAGE_PX,
      paddingPx: 0,
    });
    expect(result.cropRectDip.x + result.cropRectDip.w).toBeLessThanOrEqual(pageRectDip.x + pageRectDip.w + 1e-6);
    expect(result.cropRectDip.y + result.cropRectDip.h).toBeLessThanOrEqual(pageRectDip.y + pageRectDip.h + 1e-6);
    expect(result.cropRectDip.x).toBeGreaterThanOrEqual(pageRectDip.x);
    expect(result.cropRectDip.y).toBeGreaterThanOrEqual(pageRectDip.y);
  });

  it("treats overlayRect.y as already page-local and does not re-derive a page split via modulo", () => {
    // The caller (sigma-doc-mcp-preview.ts computeVisualPreviewFocus) resolves
    // pageIndex/localY from the unpadded shape bounds before calling this
    // function, so overlayRect.y here is page-local (e.g. 100, not
    // A4_PAGE_PX.height * n + 100). This function must use it as-is.
    const result = computePageContextCaptureRect({
      anchorRectDip: null,
      pageRectDip,
      overlayRect: { x: 10, y: 100, w: 20, h: 20 },
      pagePxSize: A4_PAGE_PX,
      paddingPx: 0,
    });
    const scale = pageRectDip.w / A4_PAGE_PX.width;
    expect(result.cropRectDip.y).toBeCloseTo(100 * scale, 5);
  });

  it("does not wrap a shape's padded rect to the previous page bottom when the shape is within padding of the page top", () => {
    // Regression for a bug where a padded overlayRect with a slightly negative
    // page-local y (shape near page top, expanded by SHAPE_PREVIEW_PADDING_PX)
    // was re-moduloed and wrapped around to the bottom of the page.
    const result = computePageContextCaptureRect({
      anchorRectDip: null,
      pageRectDip,
      overlayRect: { x: 10, y: -16, w: 20, h: 48 },
      pagePxSize: A4_PAGE_PX,
      paddingPx: 0,
    });
    const scale = pageRectDip.w / A4_PAGE_PX.width;
    // Clamped to the top of the page rect, never wrapped to the bottom.
    expect(result.cropRectDip.y).toBeCloseTo(pageRectDip.y, 5);
    expect(result.cropRectDip.h).toBeLessThanOrEqual(32 * scale + 1e-6);
  });

  it("shrinks the scale when the union rect's long side exceeds maxLongSidePx", () => {
    const largePageRectDip = { x: 0, y: 0, w: A4_PAGE_PX.width, h: A4_PAGE_PX.height };
    const result = computePageContextCaptureRect({
      anchorRectDip: null,
      pageRectDip: largePageRectDip,
      overlayRect: { x: 0, y: 0, w: A4_PAGE_PX.width, h: A4_PAGE_PX.height },
      pagePxSize: A4_PAGE_PX,
      paddingPx: 0,
      maxLongSidePx: 200,
    });
    expect(result.scale).toBeLessThan(1);
    expect(result.scale).toBeCloseTo(200 / A4_PAGE_PX.height, 5);
  });
});

describe("resolvePageContextCapturePage", () => {
  it("uses the target block's actual DOM page when flow pagination differs from the estimate", () => {
    expect(resolvePageContextCapturePage({
      requestedPageIndex: 0,
      pageCount: 3,
      targetId: "p_later_page",
      anchorBlockFound: true,
      anchorPageIndex: 2,
      preferTargetPage: true,
    })).toEqual({ ok: true, pageIndex: 2 });
  });

  it("rejects a shape-focused capture whose block anchor belongs to another page", () => {
    const result = resolvePageContextCapturePage({
      requestedPageIndex: 0,
      pageCount: 2,
      targetId: "p_other_page",
      anchorBlockFound: true,
      anchorPageIndex: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected page mismatch");
    expect(result.error).toContain("一致しません");
  });

  it("rejects a target that exists outside every print page", () => {
    const result = resolvePageContextCapturePage({
      requestedPageIndex: 0,
      pageCount: 1,
      targetId: "p_detached",
      anchorBlockFound: true,
      anchorPageIndex: null,
      preferTargetPage: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected detached target failure");
    expect(result.error).toContain("印刷ページ内");
  });
});
