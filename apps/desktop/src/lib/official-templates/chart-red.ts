import type { InlineNode, LayoutSectionChildBlock, SigmaBlock } from "@/features/document";
import { FRAME_PRESETS } from "@/lib/frame-presets";
import { BOOK_MATH_FONT_FAMILY, chartRedExampleFrame, chartRedExampleLabel, chartRedExampleTitle } from "@/lib/reference-book-box-styles";

import { GOTHIC, LATIN_SERIF, MINCHO, NUMERAL, TemplateBuilder, type OfficialTemplateBuild, customFrame, runningRegion, templateDocument } from "./build";

/**
 * 赤チャート (チャート式 数学) の例題ページの様式。数研出版の公開見本 (2025年版 数学I+A の
 * 紙面サンプル) から色と寸法を測った。紙は A5、本文は明朝 9pt。
 *
 * 例題の格で見出しの色が変わる: 例 (青紫) / 例題 (赤) / 重要例題 (臙脂)。
 */

const EMPHASIS = "#e5604e";

const LEVELS = {
  basic: { id: "chart-red-rei", label: "例" },
  standard: { id: "chart-red-reidai", label: "例題" },
  important: { id: "chart-red-juyo", label: "重要例題" },
} as const;

type Level = keyof typeof LEVELS;

/**
 * CHART の枠。右上の角を斜めに落とした赤い罫で、枠の見本「角を落とした赤罫（CHART）」と同じ絵
 * (角の部品は伸びないので、どの大きさでも切り口の形が保たれる)。
 */
const CHART_FRAME = customFrame(
  FRAME_PRESETS.find((preset) => preset.id === "cut-corner")!.drawing.svg,
  { slice: 24, borderPx: 8, paddingPx: 4 },
);

export function createChartRedTemplate(): OfficialTemplateBuild {
  const b = new TemplateBuilder("tpl_chart_red", { font: MINCHO, size: 9 }, BOOK_MATH_FONT_FAMILY);
  const gothic = (text: string, style: { bold?: boolean; color?: string; size?: number; background?: string } = {}) =>
    b.text(text, { font: GOTHIC, ...style });
  const red = (source: string) => b.rich(source, { color: EMPHASIS, bold: true, font: GOTHIC });

  /** 見出しの箱は組み込みの「例／例題／重要例題（赤チャート型）」と同じ枠。★は帯の右端。 */
  const exampleBox = (level: Level, number: number, heading: string, stars: number, body: SigmaBlock[]) => {
    const { id, label } = LEVELS[level];
    return b.box(chartRedExampleFrame(id), body, {
      styleId: id,
      title: chartRedExampleTitle(id, String(number), heading, stars),
      subtitle: chartRedExampleLabel(label),
      spaceAfterPx: 12,
    });
  };

  /** 指針: 濃い灰色の札と、左に引いた淡い縦帯。 */
  /** 指針: 濃い灰色の札を左の欄に置き、本文は札の右で揃える。札の下には淡い縦帯。 */
  const guide = (blocks: LayoutSectionChildBlock[]) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: "#ffffff",
    cornerStyle: "sharp",
    paddingPx: { top: 0, right: 0, bottom: 4, left: 0 },
    decorations: [{ type: "leftBar", widthPx: 8, color: "#e2e3ec" }],
  }, [
    b.columns([[b.p([gothic(" 指針 ", { bold: true, color: "#ffffff", background: "#5c5c60", size: 8.5 })])], blocks], { widths: [0.085, 0.915], gapMm: 1 }),
  ], { styleId: "leftbar", spaceAfterPx: 14 });

  const chart = (topic: string, lines: InlineNode[]) => b.box({
    custom: CHART_FRAME,
    titleFontWeight: "normal",
    titleFontFamily: GOTHIC,
  }, [b.p(lines, { align: "center", lineHeight: "1.6" })], {
    styleId: "custom",
    title: [
      b.text(" CHART ", { font: LATIN_SERIF, bold: true, color: "#ffffff", background: "#ef725f", size: 8 }),
      gothic("》", { bold: true, color: "#ef725f", size: 9 }),
      gothic(` ${topic}`, { size: 9.5 }),
    ],
    spaceAfterPx: 12,
  });

  const answerLabel = () => gothic(" 解答 ", { bold: true, color: EMPHASIS, background: "#fde4df", size: 8.5 });
  const note = (source: string) => b.p([gothic("◀ ", { color: EMPHASIS, size: 8 }), ...b.rich(source, { size: 8 })], { lineHeight: "1.5" });
  const answer = (body: LayoutSectionChildBlock[], notes: LayoutSectionChildBlock[]) => b.columns(
    [body, [b.sideNotes(notes, "#9a9a9a")]],
    { widths: [0.72, 0.28], gapMm: 3, spaceAfterPx: 14 },
  );

  const practice = (number: number, source: string, source2?: string) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: "#ffffff",
    cornerStyle: "sharp",
    paddingPx: { top: 2, right: 0, bottom: 2, left: 0 },
  }, [
    b.p([gothic(" 練習 ", { bold: true, color: "#ffffff", background: "#2c3c88", size: 8.5 }), b.text("　"), ...b.rich(source)]),
    b.p([b.text(` ${number} `, { font: NUMERAL, bold: true, color: "#2c3c88", background: "#e0e0ec", size: 11 }), b.text("　"), ...(source2 ? b.rich(source2) : [])]),
  ], { styleId: "fancybox", spaceAfterPx: 8 });

  const problem1 = b.problem({
    prompt: [
      exampleBox("basic", 37, "2次関数の最大・最小 (実数全体が定義域)", 1, [
        b.p("次の関数に最大値，最小値があれば，それを求めよ。", { lineHeight: "1.5" }),
        b.columns([
          [b.p("(1)　$y=2x^2-8x+5$")],
          [b.p("(2)　$y=-\\dfrac{1}{2}x^2+3x-1$")],
        ], { gapMm: 4 }),
      ]),
    ],
    hints: [
      guide([
        b.p([b.text("まずは，"), ...red("基本形 $y=a(x-p)^2+q$ に変形。")], { lineHeight: "1.5" }),
        b.p("定義域は実数全体であるから，上に凸か下に凸かに注目。", { lineHeight: "1.5" }),
        b.p([b.text("　　"), ...red("下に凸"), b.text(" の放物線 ⟶ "), b.text("頂点で最小，最大値はない。", { bold: true, font: GOTHIC })], { lineHeight: "1.5" }),
        b.p([b.text("　　"), ...red("上に凸"), b.text(" の放物線 ⟶ "), b.text("頂点で最大，最小値はない。", { bold: true, font: GOTHIC })], { lineHeight: "1.5" }),
        b.p("最大値・最小値を求める問題で，それらがない場合は「〜はない」と忘れずに答えるようにする。", { lineHeight: "1.5" }),
      ]),
      chart("2次関数の問題", [
        ...red("2次式は　基本形 $y=a(x-p)^2+q$ に直せ"),
      ]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("　(1)　$y=2x^2-8x+5$")], { lineHeight: "1.6" }),
        b.p("　　　　$=2(x-2)^2-3$", { lineHeight: "1.6" }),
        b.p("　　よって，$y$ は $x=2$ で最小値 $-3$ をとる。", { lineHeight: "1.6" }),
        b.p([b.text("　　"), b.text("最大値はない。", { bold: true, font: GOTHIC })], { lineHeight: "1.6" }),
        b.p("　(2)　$y=-\\dfrac{1}{2}(x-3)^2+\\dfrac{7}{2}$", { lineHeight: "1.6" }),
        b.p([b.text("　　"), ...b.rich("$x=3$ で最大値 $\\dfrac{7}{2}$，", { bold: true, font: GOTHIC }), b.text("最小値はない。", { bold: true, font: GOTHIC })], { lineHeight: "1.6" }),
      ], [
        note("$x^2$ の係数 $2$ でくくる。"),
        note("$a>0$ → 下に凸"),
        note("$a<0$ → 上に凸"),
      ]),
    ],
  });

  const problem2 = b.problem({
    prompt: [
      exampleBox("standard", 38, "条件つきの最大・最小", 3, [
        b.p("変数 $x$，$y$ が条件 $x+2y=4$ を満たすとき，次のものを求めよ。", { lineHeight: "1.5" }),
        b.columns([
          [b.p("(1)　$x^2+y^2$ の最小値")],
          [b.p("(2)　$x\\geqq 0$，$y\\geqq 0$ のとき，$xy$ の最大値")],
        ], { widths: [0.4, 0.6], gapMm: 4 }),
        b.p([b.text("◀", { color: "#6f74b0" }), gothic("例 37", { size: 8.5 })], { align: "right" }),
      ]),
    ],
    hints: [
      guide([
        b.p([b.text("変数は少ない方が扱いやすいから，"), ...red("文字の消去"), b.text(" を考える。")], { lineHeight: "1.5" }),
        b.p("条件の式から $x=4-2y$ として代入すると，$y$ の2次関数の問題になる。", { lineHeight: "1.5" }),
        b.p([b.text("　"), ...red("消去した文字の条件 ($x\\geqq 0$) を，残る文字 ($y$) の条件におき換えておく")], { lineHeight: "1.5" }),
      ]),
      chart("条件の式", [...red("文字を減らす方針で使え　　変域にも注意")]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("　(1)　$x=4-2y$ を代入すると")], { lineHeight: "1.6" }),
        b.p("　　$x^2+y^2=(4-2y)^2+y^2=5\\left(y-\\dfrac{8}{5}\\right)^2+\\dfrac{16}{5}$", { lineHeight: "1.6" }),
        b.p([b.text("　　よって　"), ...b.rich("$x=\\dfrac{4}{5}$，$y=\\dfrac{8}{5}$ のとき最小値 $\\dfrac{16}{5}$", { bold: true, font: GOTHIC })], { lineHeight: "1.6" }),
        b.p("　(2)　$x\\geqq 0$ から $0\\leqq y\\leqq 2$", { lineHeight: "1.6" }),
        b.p("　　$xy=(4-2y)y=-2(y-1)^2+2$", { lineHeight: "1.6" }),
        b.p([b.text("　　よって　"), ...b.rich("$x=2$，$y=1$ のとき最大値 $2$", { bold: true, font: GOTHIC })], { lineHeight: "1.6" }),
      ], [
        note("$x$ を消去する。"),
        note("変域を忘れずに。"),
      ]),
      practice(38, "$2x+y=3$，$0\\leqq x\\leqq 2$ のとき，$x^2-y^2$ の最大値と最小値を求めよ。"),
    ],
  });

  const tags = ["赤チャート", "チャート式", "参考書", "例題"];
  b.part("problem", { name: "赤チャート型 例題一式", description: "見出し帯の例題・指針・CHART・解答をまとめた問題", tags }, problem1);
  b.part("header_basic", { name: "赤チャート型 例の見出し枠", description: "青紫の「例」の札と見出し帯、問題文の枠", tags }, problem1.prompt[0]!);
  b.part("header_standard", { name: "赤チャート型 例題の見出し枠", description: "赤い「例題」の札と見出し帯、問題文の枠", tags }, problem2.prompt[0]!);
  b.part("guide", { name: "赤チャート型 指針", description: "灰色の「指針」の札と淡い縦帯", tags }, problem1.hints[0]!);
  b.part("chart", { name: "赤チャート型 CHART", description: "右上を落とした赤い罫の CHART 枠", tags }, problem1.hints[1]!);
  b.part("answer", { name: "赤チャート型 解答と補足", description: "解答の札と、右の欄に◀の補足", tags }, problem1.solution[0]!);

  return {
    parts: b.parts,
    document: templateDocument({
      docId: "official_template_chart_red",
      title: "赤チャート型 例題ページ",
      pageLayout: {
        pageSize: { widthMm: 148, heightMm: 210 },
        marginsMm: { top: 14, right: 13, bottom: 13, left: 15 },
        header: runningRegion([b.p([b.text("{page}", { font: NUMERAL, bold: true, size: 11 })])], { heightMm: 6, offsetMm: 6 }),
      },
      content: [problem1, problem2],
    }),
  };
}
