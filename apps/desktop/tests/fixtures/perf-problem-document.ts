/**
 * Problem-heavy perf fixture: a two-column A4 document with framed problems and a dense overlay,
 * matching the real 15-problem / ~500-shape document whose pagination failed to converge
 * (geo 400 + image 60 + graph 30 + table 20 = 510 図形)。
 *
 * One framed problem (`PERF_PROBLEM_OVERSIZED_PROBLEM_ID`) is deliberately taller than a single
 * column so the "atomic problem that does not fit a page" path stays under measurement.
 *
 * Generated, never captured: every value is a pure function of its index, so two calls give
 * byte-identical JSON.
 */
import { perfParagraph, perfSentence, perfTex } from "./perf-fixture-content";
import type {
  OverlayAsset,
  OverlayShape,
  SigmaTableCell,
  SigmaTableSpec,
} from "@/components/editor/overlay-canvas/types";
import type {
  Graph2DSpec,
  ParagraphNode,
  ProblemAreaBlock,
  ProblemNode,
  SigmaBlock,
  SigmaDocument,
} from "@/types/sigma-doc";

const PAGE_STRIDE_PX = 1240;
const OVERLAY_PAGE_SPAN = 40;

export const PERF_PROBLEM_COUNT = 15;
/** Indices of the problems drawn with a frame; the last one is the page-overflowing case. */
export const PERF_PROBLEM_FRAMED_INDEXES: readonly number[] = [3, 7, 11];
export const PERF_PROBLEM_FRAMED_COUNT = PERF_PROBLEM_FRAMED_INDEXES.length;
export const PERF_PROBLEM_OVERSIZED_PROBLEM_ID = "perf_problem_11";
/**
 * ページ超過の枠付き問題の形。過去にページ分割が収束しなかったケースに合わせ、
 * **lead は空**・`areaLayout` 未指定・prompt は数段落・solution だけがページ内容高さ (≈1017px) を
 * 大きく超える、という配分にしてある。エリアの高さがページを超えると、前パスで内部に入った
 * spacer が次パスの高さに混ざり、「keep-together する / しない」が毎パス入れ替わる。
 */
const OVERSIZED_PROMPT_BLOCKS = 3;
const OVERSIZED_SOLUTION_BLOCKS = 70;

export const PERF_PROBLEM_GEO_SHAPES = 400;
export const PERF_PROBLEM_IMAGE_SHAPES = 60;
export const PERF_PROBLEM_GRAPH_SHAPES = 30;
export const PERF_PROBLEM_TABLE_SHAPES = 20;
export const PERF_PROBLEM_TOTAL_SHAPES =
  PERF_PROBLEM_GEO_SHAPES
  + PERF_PROBLEM_IMAGE_SHAPES
  + PERF_PROBLEM_GRAPH_SHAPES
  + PERF_PROBLEM_TABLE_SHAPES;
/** Geo shapes that hang off a body block instead of an absolute page position. */
export const PERF_PROBLEM_BLOCK_ANCHORED_SHAPES = 120;
export const PERF_PROBLEM_PROMPT_ID_PREFIX = "perf_prob_";

export function createPerfProblemDocument(): SigmaDocument {
  const content = createContent();
  const anchorBlockIds = content
    .filter((block): block is ParagraphNode => block.type === "paragraph")
    .map((block) => block.id);
  const assets: Record<string, OverlayAsset> = {};
  const shapes: OverlayShape[] = [
    ...createGeoShapes(anchorBlockIds),
    ...createImageShapes(assets),
    ...createGraphShapes(),
    ...createTableShapes(),
  ];

  return {
    version: "2.0",
    docId: "doc_perf_problem",
    metadata: { title: "性能計測用 問題型フィクスチャ" },
    content,
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
      // 1 段組。1段組の教材 と同じで、ページ割りの walk はこちらの経路にしか無い
      // — 2 段組だと `computeColumnUnitLayouts` に分岐して、枠付き問題の keep-together 判定を
      // 一度も通らない。
      flow: { type: "columns", columnCount: 1, columnGapMm: 10 },
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

function createContent(): SigmaBlock[] {
  const blocks: SigmaBlock[] = [
    {
      type: "heading",
      id: "perf_top_h_0",
      level: 1,
      children: [{ type: "text", text: "性能計測用 問題集", fontFamily: "serif" }],
      lineHeight: "1.5",
    },
    perfParagraph("perf_top_p_0", 0, { math: true }),
  ];

  for (let index = 0; index < PERF_PROBLEM_COUNT; index += 1) {
    if (index % 5 === 0) {
      blocks.push({
        type: "heading",
        id: `perf_top_h_${index + 1}`,
        level: 2,
        children: [{ type: "text", text: `第${Math.floor(index / 5) + 1}節`, fontFamily: "serif" }],
        lineHeight: "1.5",
      });
    }
    // 問題ごとに本文段落を 1 つ挟む。図形のブロックアンカー先がここしかないので、
    // 節ごとにしか置かないと 500 個の図形が文書冒頭の数ブロックに集中してしまう。
    blocks.push(perfParagraph(`perf_top_p_${index + 1}`, index + 1, { math: true }));
    blocks.push(createProblem(index));
    if (index % 7 === 3) {
      blocks.push(createTopLevelLayoutSection(index));
    }
  }

  return blocks;
}

function createTopLevelLayoutSection(index: number): SigmaBlock {
  return {
    type: "layoutSection",
    id: `perf_top_ls_${index}`,
    layout: { columnCount: 2, columnGapMm: 8 },
    children: [
      perfParagraph(`perf_top_ls_${index}_a`, index + 2, { math: true }),
      perfParagraph(`perf_top_ls_${index}_b`, index + 5, { math: true }),
    ],
  };
}

function createProblem(index: number): ProblemNode {
  const framed = PERF_PROBLEM_FRAMED_INDEXES.includes(index);
  const oversized = `perf_problem_${index}` === PERF_PROBLEM_OVERSIZED_PROBLEM_ID;
  const promptBlocks = oversized ? OVERSIZED_PROMPT_BLOCKS : 3 + (index % 3);
  const solutionBlocks = oversized ? OVERSIZED_SOLUTION_BLOCKS : 2 + (index % 2);

  const prompt: ProblemAreaBlock[] = areaParagraphs(index, "prompt", promptBlocks, `(${index + 1}) `);
  if (index % 4 === 1) {
    prompt.push({
      type: "layoutSection",
      id: `${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_ls`,
      layout: { columnCount: 2, columnGapMm: 6 },
      children: [
        perfParagraph(`${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_ls_a`, index + 1, { math: true }),
        perfParagraph(`${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_ls_b`, index + 4, { math: true }),
      ],
    });
  }
  if (index % 3 === 2) {
    prompt.push({
      type: "list",
      id: `${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_list`,
      listType: "ordered",
      items: [0, 1, 2].map((item) => ({
        type: "listItem" as const,
        id: `${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_list_${item}`,
        children: [
          { type: "text" as const, text: perfSentence(index + item), fontFamily: "serif" },
          {
            type: "mathInline" as const,
            id: `${PERF_PROBLEM_PROMPT_ID_PREFIX}${index}_prompt_list_${item}_math`,
            tex: perfTex(index + item),
            display: "inline" as const,
          },
        ],
      })),
    });
  }

  return {
    type: "problem",
    id: `perf_problem_${index}`,
    tags: [`unit-${index % 5}`],
    // ページ超過問題の lead は空のまま (実データと同じ)。空でも 1 ユニットとして描かれ、
    // gap はこの空ユニットの marginTop として適用される。
    lead: oversized ? [] : areaParagraphs(index, "lead", 1),
    prompt,
    solution: areaParagraphs(index, "sol", solutionBlocks),
    hints: oversized ? [] : areaParagraphs(index, "hint", index % 2 === 0 ? 1 : 2),
    answer: { type: "math", expected: perfTex(index) },
    ...(oversized ? {} : {
      areaLayout: {
        prompt: { minHeightMm: 18 },
        solution: { minHeightMm: 24 },
        hints: { columnSpan: index % 6 === 4 ? "full" : "column" },
      },
    }),
    numbering: { enabled: true, value: index + 1 },
    ...(framed ? { frame: { enabled: true, styleId: "fancybox" } } : {}),
  };
}

function areaParagraphs(
  problemIndex: number,
  area: string,
  count: number,
  prefix = "",
): ProblemAreaBlock[] {
  return Array.from({ length: count }, (_, item) => perfParagraph(
    `${PERF_PROBLEM_PROMPT_ID_PREFIX}${problemIndex}_${area}_${item}`,
    problemIndex * 7 + item,
    { math: item % 3 !== 2, prefix: item === 0 ? prefix : "" },
  ));
}

function createGeoShapes(anchorBlockIds: readonly string[]): OverlayShape[] {
  return Array.from({ length: PERF_PROBLEM_GEO_SHAPES }, (_, index): OverlayShape => {
    const page = index % OVERLAY_PAGE_SPAN;
    const row = Math.floor(index / OVERLAY_PAGE_SPAN);
    const anchored = index < PERF_PROBLEM_BLOCK_ANCHORED_SHAPES && anchorBlockIds.length > 0;
    const shape: OverlayShape = {
      id: `perf_prob_geo_${index}`,
      type: "geo",
      x: 40 + (row % 5) * 110,
      y: 70 + page * PAGE_STRIDE_PX + Math.floor(row / 5) * 96,
      props: {
        w: 74,
        h: 46,
        geo: index % 3 === 0 ? "ellipse" : "rectangle",
        fill: index % 4 === 0 ? "solid" : "none",
        color: "#1f2937",
        fillColor: "#e5e7eb",
        labelColor: "#111827",
        dash: index % 5 === 0 ? "dashed" : "solid",
        size: "s",
        ...(index % 10 === 0 ? { label: `S${index}` } : {}),
      },
    };
    if (!anchored) {
      return shape;
    }
    return {
      ...shape,
      anchor: {
        type: "block",
        blockId: anchorBlockIds[index % anchorBlockIds.length],
        dy: 24 + (index % 7) * 12,
      },
    };
  });
}

function createImageShapes(assets: Record<string, OverlayAsset>): OverlayShape[] {
  return Array.from({ length: PERF_PROBLEM_IMAGE_SHAPES }, (_, index): OverlayShape => {
    const assetId = `perf_prob_asset_${index}`;
    assets[assetId] = createSvgAsset(assetId, index);
    const page = index % OVERLAY_PAGE_SPAN;
    return {
      id: `perf_prob_image_${index}`,
      type: "image",
      x: 340 + (index % 2) * 150,
      y: 250 + page * PAGE_STRIDE_PX + Math.floor(index / OVERLAY_PAGE_SPAN) * 120,
      props: { assetId, w: 96, h: 64 },
    };
  });
}

function createSvgAsset(id: string, index: number): OverlayAsset {
  const hue = (index * 47) % 360;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64">',
    `<rect width="96" height="64" rx="6" fill="hsl(${hue} 70% 88%)"/>`,
    `<path d="M8 48 L30 24 L46 38 L62 16 L88 48 Z" fill="hsl(${hue} 70% 45%)"/>`,
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
  return Array.from({ length: PERF_PROBLEM_GRAPH_SHAPES }, (_, index): OverlayShape => {
    const page = index % OVERLAY_PAGE_SPAN;
    return {
      id: `perf_prob_graph_${index}`,
      type: "graph2dShape",
      x: 70 + (index % 3) * 170,
      y: 520 + page * PAGE_STRIDE_PX,
      props: { w: 142, h: 112, spec: createGraphSpec(index) },
    };
  });
}

function createGraphSpec(index: number): Graph2DSpec {
  return {
    kind: "cartesian",
    title: `perf-graph-${index}`,
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
        id: `perf_prob_curve_${index}_linear`,
        expr: index % 2 === 0 ? "x" : "-x",
        color: "#1d4ed8",
        samples: 32,
      },
      {
        id: `perf_prob_curve_${index}_quad`,
        expr: "0.25*x^2-1",
        color: "#dc2626",
        dash: "dashed",
        samples: 32,
      },
    ],
    points: [
      {
        id: `perf_prob_point_${index}`,
        x: "1",
        y: "1",
        label: "P",
        color: "#111827",
        fill: "solid",
      },
    ],
  };
}

function createTableShapes(): OverlayShape[] {
  return Array.from({ length: PERF_PROBLEM_TABLE_SHAPES }, (_, index): OverlayShape => {
    const page = index % OVERLAY_PAGE_SPAN;
    return {
      id: `perf_prob_table_${index}`,
      type: "tableShape",
      x: 90 + (index % 2) * 200,
      y: 800 + page * PAGE_STRIDE_PX,
      props: { w: 260, h: 124, table: createTableSpec(index) },
    };
  });
}

function createTableSpec(index: number): SigmaTableSpec {
  const rows = [0, 1, 2].map((row) => ({
    id: `perf_prob_table_${index}_row_${row}`,
    height: { mode: "auto" as const, min: row === 0 ? 34 : 32 },
    role: row === 0 ? ("header" as const) : ("body" as const),
  }));
  const columns = [0, 1, 2].map((column) => ({
    id: `perf_prob_table_${index}_col_${column}`,
    width: { mode: "fr" as const, value: 1, min: 64 },
  }));
  const cells: SigmaTableCell[] = rows.flatMap((row, rowIndex) => columns.map((column, columnIndex) => ({
    id: `perf_prob_table_${index}_cell_${rowIndex}_${columnIndex}`,
    rowId: row.id,
    columnId: column.id,
    content: [{
      type: "paragraph" as const,
      id: `perf_prob_table_${index}_cell_${rowIndex}_${columnIndex}_p`,
      children: [{
        type: "text" as const,
        text: rowIndex === 0 ? `列${columnIndex + 1}` : `${index}-${rowIndex}-${columnIndex}`,
      }],
    }],
  })));

  return {
    version: 1,
    kind: "plain",
    columns,
    rows,
    cells,
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: {
      align: "center",
      verticalAlign: "middle",
      paddingX: 8,
      paddingY: 5,
      color: "#111827",
      fontSize: 15,
      fontWeight: "normal",
    },
  };
}
