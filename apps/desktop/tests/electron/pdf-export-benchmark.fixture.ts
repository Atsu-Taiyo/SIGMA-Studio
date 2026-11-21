import { createCanvas } from "@napi-rs/canvas";
import type { OverlayAsset, OverlayShape, ParagraphNode, SigmaDocument } from "@/features/document";

export const BENCHMARK_TIKZ = {
  source: String.raw`\begin{tikzpicture}\draw[->] (-1,0)--(3,0);\draw[->] (0,-1)--(0,2);\draw[thick,blue] (0,0)--(1,1)--(2,0);\end{tikzpicture}`,
  environment: { packages: "", libraries: "", preamble: "" },
};

/** Deterministic synthetic A4 workbook. No external assets or user data. */
export function pdfBenchmarkFixture(pages: number, tikz: { src: string; width: number; height: number }): SigmaDocument {
  const canvas = createCanvas(960, 480);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f1f5f9"; ctx.fillRect(0, 0, 960, 480);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgb(${(i * 29) % 256},${(i * 13) % 256},${(i * 7) % 256})`;
    ctx.fillRect(i * 12, 50 + (i * 31) % 300, 10, 90);
  }
  const png = canvas.toDataURL("image/png");
  const assets: Record<string, OverlayAsset> = {};
  for (const [id, src, w, h, mimeType] of [
    ["tikz", tikz.src, tikz.width, tikz.height, "image/svg+xml"],
    ["png", png, 960, 480, "image/png"],
  ] as const) assets[id] = { id, type: "image", props: { src, w, h, mimeType, name: id, fileSize: src.length, isAnimated: false } };
  const shapes: OverlayShape[] = [];
  const para = (page: number, row: number): ParagraphNode => ({
    type: "paragraph", id: `p_${page}_${row}`, lineHeight: "1.5", children: [
      { type: "text", text: `${row < 6 ? "問題" : "解説"}${row + 1}　式を整理して値を求め、途中式を確認する。`, fontSize: 11 },
      { type: "mathInline", id: `m_${page}_${row}_a`, display: "inline", fontSize: 11, tex: String.raw`\frac{x^2+${page + 1}}{${row + 2}}+\sqrt{a^2+1}` },
      { type: "text", text: " より ", fontSize: 11 },
      { type: "mathInline", id: `m_${page}_${row}_b`, display: "inline", fontSize: 11, tex: String.raw`\sum_{k=1}^{${row + 2}} k=\frac{n(n+1)}{2}` },
    ],
  });
  const content: SigmaDocument["content"] = [];
  for (let page = 0; page < pages; page++) {
    content.push({ type: "problem", id: `problem_${page}`, tags: ["合成教材"], ...(page ? { pagination: { break: true } } : {}),
      lead: [{ type: "paragraph", id: `label_${page}`, children: [{ type: "text", text: `BENCH-${page + 1}: 数学演習 問題と解説`, fontSize: 14 }] }],
      prompt: Array.from({ length: 6 }, (_, row) => para(page, row)),
      solution: Array.from({ length: 4 }, (_, row) => para(page, row + 6)), hints: [],
    });
    const y = 0;
    const anchor = { type: "block" as const, blockId: `label_${page}`, dy: 850 };
    shapes.push({ id: `tikz_${page}`, type: "image", x: 80, y, anchor: { ...anchor, dx: 10 }, props: { assetId: "tikz", w: 170, h: 95, tikz: BENCHMARK_TIKZ } });
    shapes.push({ id: `png_${page}`, type: "image", x: 285, y, anchor: { ...anchor, dx: 215 }, props: { assetId: "png", w: 170, h: 85 } });
    shapes.push({ id: `table_${page}`, type: "tableShape", x: 480, y, anchor: { ...anchor, dx: 410 }, props: { w: 220, h: 95, table: {
      version: 1, kind: "plain", columns: [0, 1, 2].map(i => ({ id: `c${i}`, width: { mode: "fixed", value: 70 } })),
      rows: [0, 1, 2].map(i => ({ id: `r${i}`, height: { mode: "fixed", value: 30 } })),
      cells: Array.from({ length: 9 }, (_, i) => ({ id: `cell${i}`, rowId: `r${Math.floor(i / 3)}`, columnId: `c${i % 3}`, content: [{ type: "paragraph", id: `cellp${i}`, children: [{ type: "text", text: String(i + page) }] }] })),
      grid: { borderColor: "#334155", borderWidth: 1 }, defaultCellStyle: { fontSize: 10 },
    } } });
  }
  return { version: "2.0", docId: `pdf_benchmark_${pages}`, metadata: { title: `PDF性能計測 ${pages}ページ`, styleUnits: { fontSize: "pt" } }, content,
    outputProfiles: { student: { showSolutions: false }, teacher: { showSolutions: true }, answerBook: { showSolutions: true, onlySolutions: true } },
    pageLayout: { preset: "A4", orientation: "portrait", pageSize: { widthMm: 210, heightMm: 297 }, marginsMm: { top: 16, right: 16, bottom: 16, left: 16 }, flow: { type: "columns", columnCount: 1, columnGapMm: 8 }, overlay: { overlaySnapshot: { version: 1, shapes, assets } } },
  };
}
