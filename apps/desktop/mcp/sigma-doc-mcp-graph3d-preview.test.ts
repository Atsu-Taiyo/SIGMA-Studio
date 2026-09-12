import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderGraph3DPreviewPng } from "./sigma-doc-mcp-graph3d-preview";
import { createDefaultRenderVisualPreviewDeps, type RenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";
import { SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV } from "../electron/ai-render-bridge";
import {
  isAllowedAiOverlayAssetSource,
  MAX_AI_OVERLAY_ASSET_BYTES,
} from "@/lib/ai/sigma-doc-edit-schema";
import { createGraph3DSpecPreset } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";
import type { Graph3DSpec } from "@/features/document";

const PRESET_NAMES = buildGraph3DPresetNames(createTranslator("ja", "shape"));
const SIZE = { width: 360, height: 280 };

// describe.skipIf は収集時に同期で答えが要るので top-level await で解決する。
const resvgAvailable = (await createDefaultRenderVisualPreviewDeps().loadResvg()) !== null;

function specOf(preset: Parameters<typeof createGraph3DSpecPreset>[0]): Graph3DSpec {
  return createGraph3DSpecPreset(preset, PRESET_NAMES);
}

function depsWithout(overrides: Partial<RenderVisualPreviewDeps> = {}): RenderVisualPreviewDeps {
  return {
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called without a bridge");
    },
    loadResvg: async () => null,
    ...overrides,
  };
}

describe("renderGraph3DPreviewPng", () => {
  it("returns source:none with a reason instead of throwing when nothing can rasterize", async () => {
    const result = await renderGraph3DPreviewPng(depsWithout(), specOf("revolution"), SIZE);

    expect(result.source).toBe("none");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("gives up on a figure past the triangle budget without attempting a rasterizer", async () => {
    let rasterizerLoaded = false;
    const heavy: Graph3DSpec = {
      ...specOf("blank"),
      objects: Array.from({ length: 8 }, (_, index) => ({
        id: `solid_${index}`,
        kind: "boundedSolid" as const,
        inequalities: ["x^2 + y^2 + z^2 <= 1"],
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        resolution: 128,
      })),
    };

    const result = await renderGraph3DPreviewPng(
      depsWithout({ loadResvg: async () => { rasterizerLoaded = true; return null; } }),
      heavy,
      SIZE,
    );

    expect(result.source).toBe("none");
    expect(rasterizerLoaded).toBe(false);
  }, 60_000);

  it("refuses a canvas larger than the overlay asset pixel budget", async () => {
    const result = await renderGraph3DPreviewPng(depsWithout(), specOf("blank"), { width: 9000, height: 9000 });

    expect(result.source).toBe("none");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  describe("app bridge", () => {
    let bridgeDir: string;
    let bridgeFile: string;

    beforeEach(async () => {
      bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-graph3d-bridge-"));
      bridgeFile = path.join(bridgeDir, "render-bridge.json");
      await fs.writeFile(bridgeFile, JSON.stringify({
        version: 1,
        url: "http://127.0.0.1:65000",
        token: "test-token",
        pid: 1234,
        createdAt: "2026-08-31T00:00:00.000Z",
      }), "utf8");
    });

    afterEach(async () => {
      await fs.rm(bridgeDir, { recursive: true, force: true });
    });

    it("prefers the app renderer and posts a self-contained SVG to /render-svg", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      let requestedUrl = "";
      let requestedBody: { svg: string; width: number; height: number } | null = null;

      const result = await renderGraph3DPreviewPng({
        env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeFile },
        fetchImpl: async (input, init) => {
          requestedUrl = String(input);
          requestedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({
            ok: true,
            pngBase64: png.toString("base64"),
            width: 720,
            height: 560,
          }), { headers: { "content-type": "application/json" } });
        },
        loadResvg: async () => {
          throw new Error("resvg must not be reached while the app bridge answers");
        },
      }, specOf("revolution"), SIZE);

      expect(result.source).toBe("app-bridge");
      expect(requestedUrl).toBe("http://127.0.0.1:65000/render-svg");
      expect(requestedBody!.width).toBe(720);
      expect(requestedBody!.height).toBe(560);
      expect(requestedBody!.svg).not.toContain("<text");
      expect(result.source !== "none" && result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("asks the app renderer once, not once per supersample step", async () => {
      let bridgeCalls = 0;
      const result = await renderGraph3DPreviewPng({
        env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeFile },
        fetchImpl: async () => {
          bridgeCalls += 1;
          return new Response(
            JSON.stringify({ ok: false, error: "renderer is busy" }),
            { headers: { "content-type": "application/json" } },
          );
        },
        loadResvg: async () => null,
      }, specOf("blank"), SIZE);

      expect(result.source).toBe("none");
      // 失敗の理由は解像度ではなくレンダラ側にある。段を落として聞き直すと、
      // アプリが固まっているときにタイムアウトを人数分払ってツール呼び出し自体が落ちる。
      expect(bridgeCalls).toBe(1);
    });

    it("falls back to resvg when the app renderer reports a failure", async () => {
      const result = await renderGraph3DPreviewPng({
        env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeFile },
        fetchImpl: async () => new Response(
          JSON.stringify({ ok: false, error: "canvas unavailable" }),
          { headers: { "content-type": "application/json" } },
        ),
        loadResvg: async () => null,
      }, specOf("blank"), SIZE);

      expect(result.source).toBe("none");
      expect(result.warnings.some((warning) => warning.includes("canvas unavailable"))).toBe(true);
    });
  });

  describe.skipIf(!resvgAvailable)("resvg", () => {
    it("produces a document-legal PNG data url within the asset budget", async () => {
      const result = await renderGraph3DPreviewPng(
        createDefaultRenderVisualPreviewDeps(),
        specOf("revolution"),
        SIZE,
      );

      expect(result.source).toBe("resvg");
      if (result.source === "none") return;
      expect(isAllowedAiOverlayAssetSource(result.dataUrl)).toBe(true);
      const bytes = Buffer.from(result.dataUrl.split(",")[1], "base64");
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_AI_OVERLAY_ASSET_BYTES);
      expect(result.width).toBe(720);
      expect(result.height).toBe(560);
    }, 60_000);

    it.each(["revolution", "surface", "tricylinder", "sphereTetrahedron"] as const)(
      "rasterizes the %s preset",
      async (preset) => {
        const result = await renderGraph3DPreviewPng(
          createDefaultRenderVisualPreviewDeps(),
          specOf(preset),
          SIZE,
        );

        expect(result.source).toBe("resvg");
        if (result.source === "none") return;
        expect(isAllowedAiOverlayAssetSource(result.dataUrl)).toBe(true);
      },
      120_000,
    );
  });
});
