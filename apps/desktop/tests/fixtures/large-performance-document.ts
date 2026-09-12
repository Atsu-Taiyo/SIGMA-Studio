import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { SigmaDocument, Graph2DSpec, ParagraphNode } from "@/types/sigma-doc";

const PAGE_STRIDE_PX = 1240;
export const LARGE_PERFORMANCE_TARGET_PAGES = 36;
export const LARGE_PERFORMANCE_TEXT_BLOCKS = 540;
export const LARGE_PERFORMANCE_GEO_SHAPES = LARGE_PERFORMANCE_TARGET_PAGES * 10;
export const LARGE_PERFORMANCE_IMAGE_SHAPES = LARGE_PERFORMANCE_TARGET_PAGES * 3;
export const LARGE_PERFORMANCE_GRAPH_SHAPES = LARGE_PERFORMANCE_TARGET_PAGES * 3;
export const LARGE_PERFORMANCE_TOTAL_OVERLAY_SHAPES =
  LARGE_PERFORMANCE_GEO_SHAPES + LARGE_PERFORMANCE_IMAGE_SHAPES + LARGE_PERFORMANCE_GRAPH_SHAPES;

export function createLargePerformanceDocument(): SigmaDocument {
  const assets: Record<string, OverlayAsset> = {};
  const shapes: OverlayShape[] = [
    ...createGeoShapes(),
    ...createImageShapes(assets),
    ...createGraphShapes(),
  ];

  return {
    version: "2.0",
    docId: "doc_large_performance_e2e",
    metadata: { title: "大教材パフォーマンス E2E" },
    content: createTextBlocks(),
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 14, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 10 },
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes,
          assets,
        },
      },
    },
  };
}

function createTextBlocks(): ParagraphNode[] {
  return Array.from({ length: LARGE_PERFORMANCE_TEXT_BLOCKS }, (_, index) => ({
    type: "paragraph",
    id: `perf_block_${index}`,
    lineHeight: "1.5",
    children: [
      {
        type: "text",
        text: [
          `大教材パフォーマンス確認 ${index + 1}。`,
          "2段組の本文が長く続く状態で、入力・改行・図形追従が重くならないことを確認する段落です。",
          "式変形、説明、余白調整、コメント対象になり得る本文を十分な長さで配置しています。",
          "同じ段落が複数ページにわたって増えても、本文DOMは維持しつつ重い表示層だけを可視ページへ絞ります。",
        ].join(""),
        fontFamily: "serif",
      },
      ...(index % 12 === 0
        ? [{
            type: "mathInline" as const,
            id: `perf_math_${index}`,
            tex: `x_${index}+y_${index}=z_${index}`,
            display: "inline" as const,
          }]
        : []),
    ],
  }));
}

function createGeoShapes(): OverlayShape[] {
  return Array.from({ length: LARGE_PERFORMANCE_GEO_SHAPES }, (_, index): OverlayShape => {
    const page = index % LARGE_PERFORMANCE_TARGET_PAGES;
    const row = Math.floor(index / LARGE_PERFORMANCE_TARGET_PAGES);
    const x = 42 + (row % 5) * 110;
    const y = 72 + page * PAGE_STRIDE_PX + Math.floor(row / 5) * 92;
    return {
      id: `perf_geo_${index}`,
      type: "geo",
      x,
      y,
      props: {
        w: 72,
        h: 44,
        geo: index % 3 === 0 ? "ellipse" : "rectangle",
        fill: index % 4 === 0 ? "solid" : "none",
        color: "#2563eb",
        fillColor: "#dbeafe",
        labelColor: "#111827",
        dash: index % 5 === 0 ? "dashed" : "solid",
        size: "s",
        label: index % 10 === 0 ? `S${index}` : undefined,
      },
    };
  });
}

function createImageShapes(assets: Record<string, OverlayAsset>): OverlayShape[] {
  return Array.from({ length: LARGE_PERFORMANCE_IMAGE_SHAPES }, (_, index): OverlayShape => {
    const assetId = `perf_asset_${index}`;
    assets[assetId] = createSvgAsset(assetId, index);
    const page = index % LARGE_PERFORMANCE_TARGET_PAGES;
    const column = index % 2;
    return {
      id: `perf_image_${index}`,
      type: "image",
      x: 360 + column * 150,
      y: 260 + page * PAGE_STRIDE_PX + Math.floor(index / 20) * 120,
      props: {
        assetId,
        w: 96,
        h: 64,
      },
    };
  });
}

function createSvgAsset(id: string, index: number): OverlayAsset {
  const hue = (index * 47) % 360;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64">',
    `<rect width="96" height="64" rx="6" fill="hsl(${hue} 70% 88%)"/>`,
    `<path d="M8 48 L30 24 L46 38 L62 16 L88 48 Z" fill="hsl(${hue} 70% 45%)"/>`,
    `<circle cx="72" cy="18" r="7" fill="hsl(${(hue + 80) % 360} 80% 55%)"/>`,
    "</svg>",
  ].join("");
  return {
    id,
    type: "image",
    props: {
      w: 96,
      h: 64,
      name: `${id}.svg`,
      isAnimated: false,
      mimeType: "image/svg+xml",
      src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
      fileSize: svg.length,
    },
  };
}

function createGraphShapes(): OverlayShape[] {
  return Array.from({ length: LARGE_PERFORMANCE_GRAPH_SHAPES }, (_, index): OverlayShape => {
    const page = index % LARGE_PERFORMANCE_TARGET_PAGES;
    return {
      id: `perf_graph_${index}`,
      type: "graph2dShape",
      x: 78 + (index % 3) * 170,
      y: 520 + page * PAGE_STRIDE_PX + Math.floor(index / 20) * 145,
      props: {
        w: 142,
        h: 112,
        spec: createGraphSpec(index),
      },
    };
  });
}

function createGraphSpec(index: number): Graph2DSpec {
  return {
    kind: "cartesian",
    title: `graph-${index}`,
    width: 142,
    height: 112,
    viewBox: { xMin: "-4", xMax: "4", yMin: "-4", yMax: "4" },
    axes: {
      grid: index % 2 === 0,
      showX: true,
      showY: true,
      showTicks: true,
      xTickStep: "1",
      yTickStep: "1",
    },
    curves: [
      {
        id: `perf_curve_${index}_linear`,
        expr: index % 2 === 0 ? "x" : "-x",
        color: "#1d4ed8",
        samples: 32,
      },
      {
        id: `perf_curve_${index}_quad`,
        expr: "0.25*x^2-1",
        color: "#dc2626",
        dash: "dashed",
        samples: 32,
      },
    ],
    points: [
      {
        id: `perf_point_${index}`,
        x: "1",
        y: "1",
        label: "P",
        color: "#111827",
        fill: "solid",
      },
    ],
  };
}
