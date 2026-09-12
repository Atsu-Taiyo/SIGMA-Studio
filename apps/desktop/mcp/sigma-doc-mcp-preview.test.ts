import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeBlockPreviewFocus,
  computeVisualPreviewFocus,
  createDefaultRenderVisualPreviewDeps,
  appendSvgPreviewBadge,
  pngImageContent,
  renderDocumentPreview,
  renderVisualPreview,
  resolveRenderBridgeTargetId,
  type RenderVisualPreviewDeps,
  type RenderVisualPreviewSessionLike,
  type ResvgLoaderResult,
} from "./sigma-doc-mcp-preview";
import { A4_PAGE_PX, PAGE_GAP_PX, ensurePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { AiEditDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayGeoShape, OverlayTextShape } from "@/features/document";
import {
  resolvePageContextCapturePage,
  SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV,
  LocalAiRenderBridgeStore,
} from "../electron/ai-render-bridge";

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SHAPE_PREVIEW_PADDING_PX = 32;

function geoShapeOp(overrides: Partial<OverlayGeoShape> = {}): AiEditDraft {
  const shape: OverlayGeoShape = {
    id: "shape_geo_1",
    type: "geo",
    x: 100,
    y: 100,
    props: {
      w: 80,
      h: 60,
      geo: "rectangle",
      fill: "none",
      color: "#000000",
      labelColor: "#000000",
      dash: "solid",
      size: "m",
    },
    ...overrides,
  };
  return {
    operation: "insertOverlayShape",
    summary: "テスト用の矩形を追加",
    targetId: "block_1",
    overlayShape: shape,
    assets: {},
  };
}

function textShapeOp(): AiEditDraft {
  const shape: OverlayTextShape = {
    id: "shape_text_1",
    type: "text",
    x: 100,
    y: 100,
    props: {
      w: 100,
      h: 16,
      blocks: [],
      color: "#000000",
      size: "m",
    },
  };
  return {
    operation: "insertOverlayShape",
    summary: "テスト用のテキストを追加",
    targetId: "block_1",
    overlayShape: shape,
    assets: {},
  };
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// describe.skipIf needs the answer synchronously at collection time, so resolve
// resvg availability via top-level await instead of an async beforeAll.
const resvgAvailable = (await createDefaultRenderVisualPreviewDeps().loadResvg()) !== null;

describe("pngImageContent", () => {
  it("wraps a buffer as an MCP image content block with image/png mimeType", () => {
    const buffer = Buffer.from(PNG_MAGIC_BYTES);
    const content = pngImageContent(buffer);
    expect(content.type).toBe("image");
    if (content.type !== "image") throw new Error("expected image content");
    expect(content.mimeType).toBe("image/png");
    expect(Buffer.from(content.data, "base64")).toEqual(buffer);
  });
});

describe("appendSvgPreviewBadge", () => {
  it("adds a right-top badge and escapes text before SVG rendering", () => {
    const svg = '<svg width="200" height="100" viewBox="0 0 200 100"></svg>';
    const result = appendSvgPreviewBadge(svg, "K7<&2");
    expect(result).toContain('data-sigma-ai-preview-badge="true"');
    expect(result).toContain("K7&lt;&amp;2");
    expect(result).toContain('font-family="monospace"');
    expect(result.indexOf('data-sigma-ai-preview-badge="true"')).toBeLessThan(result.indexOf("</svg>"));
  });
});

describe("computeVisualPreviewFocus", () => {
  it("returns null when there are no shape-insertion operations", () => {
    expect(computeVisualPreviewFocus([], A4_PAGE_PX)).toBeNull();
  });

  it("resolves pageIndex 0 and a padded overlayRect for a shape near the top of page 1", () => {
    const focus = computeVisualPreviewFocus([geoShapeOp({ x: 100, y: 100 })], A4_PAGE_PX);
    expect(focus).not.toBeNull();
    expect(focus?.pageIndex).toBe(0);
    expect(focus?.overlayRect).toEqual({
      x: 100 - SHAPE_PREVIEW_PADDING_PX,
      y: 100 - SHAPE_PREVIEW_PADDING_PX,
      w: 80 + SHAPE_PREVIEW_PADDING_PX * 2,
      h: 60 + SHAPE_PREVIEW_PADDING_PX * 2,
    });
  });

  it("resolves pageIndex 1 for a shape whose y is past the first page's stride (height + gap)", () => {
    const y = A4_PAGE_PX.height + PAGE_GAP_PX + 100;
    const focus = computeVisualPreviewFocus([geoShapeOp({ y })], A4_PAGE_PX);
    expect(focus?.pageIndex).toBe(1);
    // localY should be page-local (100), not the raw continuous y.
    expect(focus?.overlayRect.y).toBe(100 - SHAPE_PREVIEW_PADDING_PX);
  });

  it("does not wrap to pageIndex 0's bottom for a shape within padding distance of a page top", () => {
    // A shape sitting exactly at the start of page 2 (localY === 0) must resolve
    // to pageIndex 1 with a small negative local y after padding, not wrap
    // around to a huge y near the bottom of page 1.
    const y = A4_PAGE_PX.height + PAGE_GAP_PX;
    const focus = computeVisualPreviewFocus([geoShapeOp({ y })], A4_PAGE_PX);
    expect(focus?.pageIndex).toBe(1);
    expect(focus?.overlayRect.y).toBe(-SHAPE_PREVIEW_PADDING_PX);
  });

  it("uses ANCHOR_PAGE_STRIDE_PX (height + gap), not the gap-less A4 page height, for the page split", () => {
    // A y just past the gap-less page height (but still before the real,
    // gap-full stride) must still resolve to pageIndex 0.
    const y = A4_PAGE_PX.height + 10;
    const focus = computeVisualPreviewFocus([geoShapeOp({ y })], A4_PAGE_PX);
    expect(focus?.pageIndex).toBe(0);
  });

  it("clamps the overlayRect to the minimum preview size for a tiny shape", () => {
    const focus = computeVisualPreviewFocus(
      [geoShapeOp({ x: 100, y: 100, props: { w: 4, h: 4, geo: "rectangle", fill: "none", color: "#000000", labelColor: "#000000", dash: "solid", size: "m" } })],
      A4_PAGE_PX,
    );
    expect(focus?.overlayRect.w).toBeGreaterThanOrEqual(96);
    expect(focus?.overlayRect.h).toBeGreaterThanOrEqual(72);
  });

  it("uses the provided (non-A4) pagePxSize to derive the page stride", () => {
    const customPageHeight = 500;
    const y = customPageHeight + PAGE_GAP_PX + 20;
    const focus = computeVisualPreviewFocus([geoShapeOp({ y })], { width: A4_PAGE_PX.width, height: customPageHeight });
    expect(focus?.pageIndex).toBe(1);
    expect(focus?.overlayRect.y).toBe(20 - SHAPE_PREVIEW_PADDING_PX);
  });

  it("sets preferTargetPage so a block-anchored shape's real DOM page wins over the estimate", () => {
    const focus = computeVisualPreviewFocus([geoShapeOp({ y: 100 })], A4_PAGE_PX);
    expect(focus?.preferTargetPage).toBe(true);

    expect(resolvePageContextCapturePage({
      requestedPageIndex: focus!.pageIndex,
      pageCount: 5,
      targetId: "p_block_page4",
      anchorBlockFound: true,
      anchorPageIndex: 4,
      preferTargetPage: focus!.preferTargetPage,
    })).toEqual({ ok: true, pageIndex: 4 });
  });
});

describe("computeBlockPreviewFocus", () => {
  it("marks the estimated flow page so the render bridge resolves the target's actual DOM page", () => {
    const targetId = sampleDocument.content[0]?.id;
    if (!targetId) throw new Error("sample document must have a block");

    const focus = computeBlockPreviewFocus(sampleDocument, targetId, A4_PAGE_PX);

    expect(focus).toMatchObject({ preferTargetPage: true });
  });
});

describe("renderVisualPreview: svg fallback", () => {
  function fallbackDeps(overrides: Partial<RenderVisualPreviewDeps> = {}): RenderVisualPreviewDeps {
    return {
      env: {},
      fetchImpl: (async () => {
        throw new Error("fetch should not be called when no bridge is configured");
      }) as unknown as typeof fetch,
      loadResvg: createDefaultRenderVisualPreviewDeps().loadResvg,
      ...overrides,
    };
  }

  function session(operations: AiEditDraft[]): RenderVisualPreviewSessionLike {
    return {
      agentSession: { draftDocument: sampleDocument, operations },
      targetId: "block_1",
    };
  }

  describe.skipIf(!resvgAvailable)("with resvg available", () => {
    it("returns a valid PNG whose dimensions match the padded shape crop size", async () => {
      const result = await renderVisualPreview(fallbackDeps(), session([geoShapeOp()]));
      expect(result.source).toBe("svg-fallback");
      if (result.source !== "svg-fallback") throw new Error("expected svg-fallback");

      expect(Array.from(result.png.subarray(0, 8))).toEqual(PNG_MAGIC_BYTES);
      const dims = readPngDimensions(result.png);
      expect(dims.width).toBe(result.width);
      expect(dims.height).toBe(result.height);
      expect(result.width).toBe(80 + SHAPE_PREVIEW_PADDING_PX * 2);
      expect(result.height).toBe(60 + SHAPE_PREVIEW_PADDING_PX * 2);
    });

    it("includes a warning when operations contain a text-like shape", async () => {
      const result = await renderVisualPreview(fallbackDeps(), session([textShapeOp()]));
      expect(result.source).toBe("svg-fallback");
      if (result.source !== "svg-fallback") throw new Error("expected svg-fallback");
      expect(result.warnings).toContain("text/表/グラフ図形はfallback previewに描画されません。");
    });

    it("does not include the text-like warning for pure geo shapes", async () => {
      const result = await renderVisualPreview(fallbackDeps(), session([geoShapeOp()]));
      expect(result.source).toBe("svg-fallback");
      if (result.source !== "svg-fallback") throw new Error("expected svg-fallback");
      expect(result.warnings).toEqual([]);
    });
  });

  it("returns source:none with the raw svg when resvg cannot be loaded", async () => {
    const deps = fallbackDeps({ loadResvg: async () => null });
    const result = await renderVisualPreview(deps, session([geoShapeOp()]), undefined, { badgeText: "K7Q2X" });
    expect(result.source).toBe("none");
    if (result.source !== "none") throw new Error("expected none");
    expect(result.svg).toContain("<svg");
    expect(result.svg).toContain("K7Q2X");
  });

  it("passes the badge through to the SVG fallback renderer", async () => {
    let renderedSvg = "";
    const deps = fallbackDeps({
      loadResvg: async () => ({
        render: (svg: string) => {
          renderedSvg = svg;
          return Buffer.from(PNG_MAGIC_BYTES);
        },
      }),
    });
    const result = await renderVisualPreview(deps, session([geoShapeOp()]), undefined, { badgeText: "K7Q2X" });
    expect(result.source).toBe("svg-fallback");
    expect(renderedSvg).toContain("K7Q2X");
  });

  it("returns source:none when there are no shape operations at all", async () => {
    const deps = fallbackDeps({ loadResvg: async () => null });
    const result = await renderVisualPreview(deps, session([]));
    expect(result.source).toBe("none");
  });
});

describe("renderVisualPreview: app bridge", () => {
  let userDataDir: string;
  let bridgeStore: LocalAiRenderBridgeStore;
  const TOKEN = "bridge-token";

  function session(operations: AiEditDraft[]): RenderVisualPreviewSessionLike {
    return {
      agentSession: { draftDocument: sampleDocument, operations },
      targetId: "block_1",
    };
  }

  function disabledResvgLoader(): () => Promise<ResvgLoaderResult | null> {
    return async () => null;
  }

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-preview-bridge-"));
    bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function writeReadyBridge(): Promise<void> {
    await bridgeStore.write({
      version: 1,
      url: "http://preview-bridge.test",
      token: TOKEN,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
  }

  it("uses the app bridge when a ready bridge file is present and returns source:app-bridge", async () => {
    const pngBase64 = Buffer.from(PNG_MAGIC_BYTES).toString("base64");
    await writeReadyBridge();

    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: true,
        pngBase64,
        width: 10,
        height: 20,
        capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 10, h: 20 } },
        anchorBlockFound: true,
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderVisualPreview(deps, session([geoShapeOp()]));
    expect(result.source).toBe("app-bridge");
    if (result.source !== "app-bridge") throw new Error("expected app-bridge");
    expect(result.width).toBe(10);
    expect(result.height).toBe(20);
    expect(result.anchorBlockFound).toBe(true);
    expect(Array.from(result.png.subarray(0, 8))).toEqual(PNG_MAGIC_BYTES);
  });

  it("rejects an unsafe persisted document asset before any app-bridge resource request", async () => {
    // この門番は **生の文書**を見る必要がある。正規化境界 (`overlay-snapshot.ts`) が許可外の
    // `src` を落とすようになったので、正規化済みを見ていると「不正は 0 件」と読めて黙って
    // 無効化される。正規化が防ぐのは描画であって、文書をブリッジへ渡すこと自体ではない。
    await writeReadyBridge();
    const fetchImpl = (async () => {
      throw new Error("unsafe document must not reach the bridge");
    }) as typeof fetch;
    const fetchSpy = vi.fn(fetchImpl);
    const unsafeDocument = ensurePageLayout(structuredClone(sampleDocument));
    unsafeDocument.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        shapes: [],
        assets: {
          malicious: {
            id: "malicious",
            type: "image",
            props: {
              w: 10,
              h: 10,
              name: "malicious.png",
              isAnimated: false,
              mimeType: "image/png",
              src: "file:///tmp/private.png",
              fileSize: 10,
            },
          },
        },
      },
    };
    const targetId = unsafeDocument.content[0]?.id;
    if (!targetId) throw new Error("sample document must have a block");
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: fetchSpy as unknown as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    await expect(renderDocumentPreview(deps, {
      document: unsafeDocument,
      targetId,
      changedIds: [targetId],
    })).rejects.toThrow("安全な形式");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes badgeText to the app render bridge", async () => {
    await writeReadyBridge();
    let request: { badgeText?: string } | null = null;
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async (_input, init) => {
        request = JSON.parse(String(init?.body)) as { badgeText?: string };
        return new Response(JSON.stringify({
          ok: true,
          pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
          width: 10,
          height: 20,
          capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 10, h: 20 } },
          anchorBlockFound: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    await renderVisualPreview(deps, session([geoShapeOp()]), undefined, { badgeText: "K7Q2X" });
    expect(request).toEqual(expect.objectContaining({ badgeText: "K7Q2X" }));
  });

  it("tells the bridge to replace a flow-page estimate with the target block's actual DOM page", async () => {
    const targetId = sampleDocument.content[0]?.id;
    if (!targetId) throw new Error("sample document must have a block");
    await writeReadyBridge();
    let receivedFocus: { pageIndex: number; preferTargetPage?: boolean } | null = null;
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { focus: { pageIndex: number; preferTargetPage?: boolean } };
        receivedFocus = body.focus;
        return new Response(JSON.stringify({
          ok: true,
          pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
          width: 10,
          height: 20,
          capture: { pageIndex: 2, cropRect: { x: 0, y: 0, w: 10, h: 20 } },
          anchorBlockFound: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderDocumentPreview(deps, {
      document: sampleDocument,
      targetId,
      changedIds: [targetId],
    });

    expect(receivedFocus).toMatchObject({ preferTargetPage: true });
    expect(result.source).toBe("app-bridge");
    if (result.source !== "app-bridge") throw new Error("expected app-bridge");
    expect(result.capture.pageIndex).toBe(2);
  });

  it("uses the insert operation's flow-block anchor instead of the inserted shape id", () => {
    const blockTargetId = sampleDocument.content[0]?.id;
    if (!blockTargetId) {
      throw new Error("sample document must have a block");
    }
    expect(resolveRenderBridgeTargetId({
      document: sampleDocument,
      targetId: "shape_geo_1",
      operations: [{ ...geoShapeOp(), targetId: blockTargetId }],
      changedIds: ["shape_geo_1"],
    })).toBe(blockTargetId);
  });

  it("does not send the END_OF_DOCUMENT sentinel as a DOM anchor", () => {
    const operation = geoShapeOp();
    expect(resolveRenderBridgeTargetId({
      document: sampleDocument,
      targetId: "shape_geo_1",
      operations: [{ ...operation, targetId: "END_OF_DOCUMENT" }],
      changedIds: ["shape_geo_1"],
    })).toBeNull();
  });

  it("omits the DOM anchor for a shape mutation and lets overlay focus drive the capture", async () => {
    const operation = geoShapeOp();
    if (operation.operation !== "insertOverlayShape") {
      throw new Error("expected insertOverlayShape fixture");
    }
    if (!sampleDocument.pageLayout) {
      throw new Error("sample document must have page layout");
    }
    const shape = operation.overlayShape;
    const document = {
      ...sampleDocument,
      pageLayout: {
        ...sampleDocument.pageLayout,
        overlay: {
          ...sampleDocument.pageLayout?.overlay,
          overlaySnapshot: { version: 1 as const, shapes: [shape], assets: {} },
        },
      },
    };
    let receivedTargetId: unknown = "not-called";
    await bridgeStore.write({
      version: 1,
      url: "http://127.0.0.1:9999",
      token: TOKEN,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { targetId?: unknown };
        receivedTargetId = body.targetId;
        return new Response(JSON.stringify({
          ok: true,
          pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
          width: 1,
          height: 1,
          capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
          anchorBlockFound: false,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderDocumentPreview(deps, {
      document,
      targetId: shape.id,
      changedIds: [shape.id],
    });

    expect(result.source).toBe("app-bridge");
    expect(receivedTargetId).toBeNull();
  });

  it("falls back when the bridge is not configured, without a bridge-failure warning (state:none is expected)", async () => {
    const deps: RenderVisualPreviewDeps = {
      env: {},
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderVisualPreview(deps, session([geoShapeOp()]));
    expect(result.source).toBe("none");
    expect(result.warnings).toEqual([]);
  });

  it("surfaces the HTTP status and error body message in warnings when the bridge returns a non-2xx response", async () => {
    await writeReadyBridge();

    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => new Response(
        JSON.stringify({ ok: false, error: "hidden window failed to load print.html" }),
        { status: 502, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderVisualPreview(deps, session([geoShapeOp()]));
    expect(result.source).toBe("none");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("app bridgeでのレンダリングに失敗したためfallback previewを返します");
    expect(result.warnings[0]).toContain("502");
    expect(result.warnings[0]).toContain("hidden window failed to load print.html");
  });

  it("surfaces a connection-failure reason in warnings when the bridge file points at an unreachable server", async () => {
    await bridgeStore.write({
      version: 1,
      url: "http://127.0.0.1:1",
      token: TOKEN,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });

    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: fetch,
      loadResvg: disabledResvgLoader(),
    };

    const result = await renderVisualPreview(deps, session([geoShapeOp()]));
    expect(result.source).toBe("none");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("render bridgeへの接続に失敗しました");
  });
});
