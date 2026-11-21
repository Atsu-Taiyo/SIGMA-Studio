import type { InlineNode, LayoutSectionChildBlock, SigmaBlock } from "@/features/document";
import {
  BOOK_MATH_FONT_FAMILY,
  CHART_BLUE_COLORS,
  chartBlueExampleFrame,
  chartBlueExampleLabel,
  chartBlueExampleTitle,
} from "@/lib/reference-book-box-styles";

import { GOTHIC, MINCHO, NUMERAL, TemplateBuilder, type OfficialTemplateBuild, runningRegion, templateDocument } from "./build";

/**
 * 青チャート (チャート式 基礎からの数学) の例題ページの様式。数研出版の公開見本 (改訂版
 * 数学I+A の紙面サンプル) から色を測った。紙は A5、本文は明朝 9pt。
 *
 * 赤い札の「基本例題」と桃色の見出し帯、右端の白い欄に難易度の丸。問題は赤い罫で囲み、
 * 指針は淡い橙の地に置き、末尾に CHART の札を添える。
 */

const { red: RED, frame: FRAME, guideFill: GUIDE_FILL, emphasis: EMPHASIS } = CHART_BLUE_COLORS;

export function createChartBlueTemplate(): OfficialTemplateBuild {
  const b = new TemplateBuilder("tpl_chart_blue", { font: MINCHO, size: 9 }, BOOK_MATH_FONT_FAMILY);
  const gothic = (text: string, style: { bold?: boolean; color?: string; size?: number; background?: string; boxed?: "frame" | "oval" } = {}) =>
    b.text(text, { font: GOTHIC, ...style });
  const red = (source: string) => b.rich(source, { color: EMPHASIS, bold: true, font: GOTHIC });

  /** 見出しの箱は組み込みの「基本例題（青チャート型）」と同じ枠。難易度の丸は帯の右端。 */
  const example = (label: string, number: number, heading: string, level: number, body: SigmaBlock[]) => b.box(chartBlueExampleFrame(), body, {
    styleId: "chart-blue-kihon",
    subtitle: chartBlueExampleLabel(label),
    title: chartBlueExampleTitle(String(number), heading, level),
    spaceAfterPx: 8,
  });

  /** 指針: 淡い橙の地。赤い札を左の欄に置き、本文は札の右で揃える。 */
  const guide = (blocks: LayoutSectionChildBlock[]) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: GUIDE_FILL,
    cornerStyle: "sharp",
    paddingPx: { top: 8, right: 10, bottom: 8, left: 10 },
  }, [
    b.columns([[b.p([gothic(" 指針 ", { bold: true, color: "#ffffff", background: RED, size: 8.5 })])], blocks], { widths: [0.09, 0.91], gapMm: 1 }),
  ], { styleId: "fancybox", spaceAfterPx: 14 });
  const chartLine = (topic: string, rule: string) => b.p([
    gothic(" CHART ", { bold: true, color: "#ffffff", background: RED, size: 9, boxed: "oval" }),
    gothic(`　${topic}　`, { bold: true, size: 9 }),
    ...b.rich(rule, { color: EMPHASIS, bold: true, font: GOTHIC, size: 10.5 }),
  ], { lineHeight: "1.9" });

  const answer = (body: LayoutSectionChildBlock[], notes: LayoutSectionChildBlock[]) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: "#ffffff",
    cornerStyle: "sharp",
    paddingPx: { top: 0, right: 0, bottom: 0, left: 12 },
    decorations: [{ type: "leftBar", widthPx: 1.2, color: FRAME }],
  }, [
    b.columns([body, [b.sideNotes(notes, "#8a8a8a")]], { widths: [0.7, 0.3], gapMm: 3 }),
  ], { styleId: "leftbar", spaceAfterPx: 12 });
  const answerLabel = () => gothic("✎解答 ", { bold: true, color: EMPHASIS, size: 8.5 });
  const note = (source: string) => b.p([gothic("◀ ", { color: EMPHASIS, size: 8 }), ...b.rich(source, { size: 8 })], { lineHeight: "1.5" });

  const practice = (number: number, body: InlineNode[]) => b.p([
    gothic(" 練習 ", { bold: true, color: "#ffffff", background: "#3a3a3a", size: 8 }),
    b.text(` ${number}`, { font: NUMERAL, bold: true, size: 11 }),
    b.text("　"),
    ...body,
  ], { lineHeight: "1.6", spaceAfterPx: 10 });

  const problem1 = b.problem({
    prompt: [
      example("基本例題", 42, "絶対値を含む不等式", 3, [
        b.p("次の不等式を解け。", { lineHeight: "1.5" }),
        b.columns([
          [b.p("(1)　$|x-3|<2x$")],
          [b.p("(2)　$|x+1|+|x-2|\\leqq 5$")],
        ], { gapMm: 4 }),
      ]),
    ],
    hints: [
      guide([
        b.p([b.text("絶対値", { bold: true, font: GOTHIC }), b.text(" を含む不等式は，絶対値を含む方程式と同様に "), ...red("場合に分ける"), b.text(" が原則である。")], { lineHeight: "1.5" }),
        b.p("(1)　$x-3\\geqq 0$，$x-3<0$ の場合に分けて解く。", { lineHeight: "1.5" }),
        b.p("(2)　絶対値記号内の式が $0$ となる $x$ の値は $x=-1,\\ 2$", { lineHeight: "1.5" }),
        b.p("　　→ $x<-1$，$-1\\leqq x<2$，$2\\leqq x$ の3つの場合に分けて解く。", { lineHeight: "1.5" }),
        b.p("絶対値を含む不等式では，場合分けの条件との共通範囲をとる。", { lineHeight: "1.5" }),
        chartLine("絶対値", "場合に分ける"),
      ]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("(1)　[1]　$x\\geqq 3$ のとき，不等式は　$x-3<2x$")], { lineHeight: "1.6" }),
        b.p("　　　　　これを解いて　$x>-3$", { lineHeight: "1.6" }),
        b.p("　　　　　$x\\geqq 3$ との共通範囲は　$x\\geqq 3$　…… ①", { lineHeight: "1.6" }),
        b.p("　　　[2]　$x<3$ のとき，不等式は　$-(x-3)<2x$", { lineHeight: "1.6" }),
        b.p("　　　　　これを解いて　$x>1$", { lineHeight: "1.6" }),
        b.p("　　　　　$x<3$ との共通範囲は　$1<x<3$　…… ②", { lineHeight: "1.6" }),
        b.p([b.text("　　求める解は，① と ② を"), ...red("合わせた範囲"), b.text("で　"), b.math("x>1", { bold: true })], { lineHeight: "1.6" }),
      ], [
        note("場合分けの条件を必ず確認する。"),
        note("共通範囲をとる。"),
        note("最後に合わせる。"),
      ]),
      practice(42, b.rich("次の不等式を解け。　(1)　$|2x-1|<x+4$　　(2)　$|x|+|x-3|>5$")),
    ],
  });

  const problem2 = b.problem({
    prompt: [
      example("基本例題", 43, "2次方程式の解と係数", 2, [
        b.p("2次方程式 $x^2+mx+m+3=0$ が異なる2つの実数解をもつような定数 $m$ の値の範囲を求めよ。", { lineHeight: "1.5" }),
      ]),
    ],
    hints: [
      guide([
        b.p([...b.rich("2次方程式 $ax^2+bx+c=0$ の判別式を $D=b^2-4ac$ とすると")], { lineHeight: "1.5" }),
        b.p([b.text("　　"), ...red("異なる2つの実数解をもつ $\\iff D>0$")], { lineHeight: "1.5" }),
        chartLine("実数解の個数", "判別式 $D$ の符号を調べよ"),
      ]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("判別式を $D$ とすると")], { lineHeight: "1.6" }),
        b.p("　　$D=m^2-4(m+3)=(m+2)(m-6)$", { lineHeight: "1.6" }),
        b.p("　　$D>0$ から　$(m+2)(m-6)>0$", { lineHeight: "1.6" }),
        b.p([b.text("　　よって　"), b.math("m<-2,\\ 6<m", { bold: true })], { lineHeight: "1.6" }),
      ], [
        note("$D>0$ の条件。"),
      ]),
    ],
  });

  const tags = ["青チャート", "チャート式", "参考書", "例題"];
  b.part("problem", { name: "青チャート型 例題一式", description: "基本例題の見出し・指針・CHART・解答・練習をまとめた問題", tags }, problem1);
  b.part("header", { name: "青チャート型 基本例題の見出し枠", description: "赤い「基本例題」の札と桃色の見出し帯、赤い罫の枠", tags }, problem1.prompt[0]!);
  b.part("guide", { name: "青チャート型 指針と CHART", description: "淡い橙の地に赤い「指針」の札、末尾に CHART", tags }, problem1.hints[0]!);
  b.part("answer", { name: "青チャート型 解答と補足", description: "赤い縦罫の解答と、右の欄に◀の補足", tags }, problem1.solution[0]!);

  return {
    parts: b.parts,
    document: templateDocument({
      docId: "official_template_chart_blue",
      title: "青チャート型 例題ページ",
      pageLayout: {
        pageSize: { widthMm: 148, heightMm: 210 },
        marginsMm: { top: 14, right: 13, bottom: 13, left: 15 },
        header: runningRegion([b.p([b.text("{page}", { font: NUMERAL, size: 10 })])], { heightMm: 6, offsetMm: 6 }),
      },
      content: [problem1, problem2],
    }),
  };
}
