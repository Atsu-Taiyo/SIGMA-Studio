import type { BoxBlockNode, InlineNode, SigmaBlock } from "@/features/document";
import { BOOK_MATH_FONT_FAMILY, kyotsuChoicesFrame } from "@/lib/reference-book-box-styles";

import { GOTHIC, LATIN_SERIF, MINCHO, TemplateBuilder, type OfficialTemplateBuild, runningRegion, templateDocument } from "./build";

/**
 * 大学入学共通テスト (数学I，数学A) の問題冊子の様式。大学入試センターが公開している令和8年度
 * 本試験の問題冊子 PDF から寸法を測った。紙は B5 (182×257mm)、本文は明朝 10.5pt、行送りは広め。
 *
 * 解答欄は答えの桁ごとにカタカナを入れた枠 (数値は一重、選択肢は二重)。選択肢は細い罫の
 * 「解答群」の枠に ⓪①… で2列に並べる。ページの右上に科目名、下に「— n —」。
 */

const LINE = "1.75";

export function createKyotsuTestTemplate(): OfficialTemplateBuild {
  const b = new TemplateBuilder("tpl_kyotsu", { font: MINCHO, size: 10.5 }, BOOK_MATH_FONT_FAMILY);
  const gothic = (text: string, style: { bold?: boolean; size?: number } = {}) => b.text(text, { font: GOTHIC, ...style });

  /** 数値の解答欄 (一重の枠) と、解答群から選ぶ解答欄 (二重の枠)。 */
  const blank = (letters: string) => b.text(`　${letters}　`, { font: GOTHIC, bold: true, size: 10.5, boxed: "frame" });
  const choice = (letters: string) => b.text(`　${letters}　`, { font: GOTHIC, bold: true, size: 10.5, boxed: "double" });
  const line = (children: InlineNode[] | string, spaceAfterPx = 6) => b.p(children, { lineHeight: LINE, spaceAfterPx });
  const display = (source: string) => b.p(`　　　${source}`, { lineHeight: LINE, spaceAfterPx: 8 });
  /** 〔１〕の下の本文。問題冊子と同じく〔１〕より2字下げ、折り返しもその位置で揃える。 */
  const body = (blocks: SigmaBlock[]) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: "#ffffff",
    cornerStyle: "sharp",
    paddingPx: { top: 0, right: 0, bottom: 0, left: 42 },
  }, blocks, { styleId: "fancybox" });
  /** 科目名。問題冊子は「数学」をゴシック、ⅠとAを欧文の太いセリフで組む。 */
  const subjectName = (size: number) => [
    gothic("数学", { bold: true, size }),
    b.text(" I", { font: LATIN_SERIF, bold: true, size }),
    gothic("，数学", { bold: true, size }),
    b.text("A", { font: LATIN_SERIF, bold: true, size }),
  ];
  const continued = (problem: string) => b.p([gothic(`（数学Ⅰ，数学A${problem}は次ページに続く。）`, { bold: true, size: 9 })], { align: "right" });

  /** 組み込みの「解答群（共通テスト型）」と同じ枠。 */
  const answerGroup = (choices: string[]) => b.box(kyotsuChoicesFrame(), [
    b.columns([
      choices.filter((_, index) => index % 2 === 0).map((item, index) => b.p([gothic(circled(index * 2), { bold: true, size: 12 }), ...b.rich(`　${item}`)], { lineHeight: "2" })),
      choices.filter((_, index) => index % 2 === 1).map((item, index) => b.p([gothic(circled(index * 2 + 1), { bold: true, size: 12 }), ...b.rich(`　${item}`)], { lineHeight: "2" })),
    ], { gapMm: 6 }),
  ], { styleId: "kyotsu-choices", spaceAfterPx: 14 });

  const title = b.p(subjectName(22), { align: "center", lineHeight: "1.4" });
  const subtitle = b.p([gothic("（全　問　必　答）", { bold: true, size: 12 })], { align: "center", spaceAfterPx: 24 });

  let answerGroupSample!: BoxBlockNode;
  const problem1 = b.problem({
    lead: [b.p([gothic("第１問", { bold: true, size: 15 }), b.text("　（配点　30）", { size: 10 })], { spaceAfterPx: 14 })],
    prompt: [
      line("　〔１〕　全体集合 $U$ を $1$ 以上 $12$ 以下の自然数全体の集合とする。すなわち", 10),
      body([
      display("$U=\\{1,\\ 2,\\ 3,\\ \\cdots,\\ 12\\}$"),
      line("である。"),
      line("　$U$ の部分集合 $A$，$B$ を"),
      display("$A=\\{k\\mid k\\in U,\\ k\\ \\text{は}\\ 3\\ \\text{の倍数}\\}$"),
      display("$B=\\{k\\mid k\\in U,\\ k\\ \\text{は}\\ 4\\ \\text{の倍数}\\}$"),
      line("とする。", 18),
      line([b.text("(1)　"), ...b.rich("$A\\cap B=$ "), choice("ア"), b.text("，　"), ...b.rich("$A\\cup B$ の要素の個数は "), blank("イ"), b.text(" である。")], 14),
      line([choice("ア"), b.text(" の解答群")], 4),
      answerGroupSample = answerGroup(["$\\{12\\}$", "$\\{3,\\ 12\\}$", "$\\{4,\\ 12\\}$", "$\\{3,\\ 4,\\ 12\\}$", "$\\{6,\\ 12\\}$", "$\\varnothing$"]),
      line([b.text("(2)　"), ...b.rich("$\\overline{A}\\cap B$ の要素をすべて足すと "), blank("ウエ"), b.text(" である。")], 14),
      ]),
      continued("第１問"),
    ],
  });

  const problem1b = b.problem({
    breakBefore: true,
    prompt: [
      line("　〔２〕　$a$ を定数とし，$x$ の2次関数", 10),
      body([
      display("$y=x^2-2ax+a^2+2a-3$　…… ①"),
      line("を考える。", 14),
      line([b.text("(1)　2次関数 ① のグラフの頂点の座標は　("), b.math("a"), b.text("，"), blank("オ"), b.math("a-"), blank("カ"), b.text(")　である。")], 14),
      line([b.text("(2)　"), ...b.rich("2次関数 ① のグラフが $x$ 軸と異なる2点で交わるのは，$a<$ "), blank("キ"), ...b.rich(" のときである。")], 14),
      line([b.text("(3)　"), ...b.rich("$0\\leqq x\\leqq 2$ における ① の最小値が $1$ となるような $a$ の値は "), blank("ク"), b.text(" であり，そのときの最大値は "), blank("ケコ"), b.text(" である。")], 14),
      line([b.text("(4)　"), ...b.rich("2次関数 ① のグラフについて述べた文として正しいものは "), choice("サ"), b.text(" である。")], 4),
      line([choice("サ"), b.text(" の解答群")], 4),
      answerGroup([
        "$a$ の値によらず，頂点は直線 $y=2x-3$ 上にある。",
        "$a$ の値によらず，頂点は直線 $y=-2x+3$ 上にある。",
        "$a$ が増加すると，頂点の $y$ 座標は減少する。",
        "$a$ の値によらず，グラフは点 $(0,\\,-3)$ を通る。",
      ]),
      ]),
    ],
  });

  const tags = ["共通テスト", "大学入学共通テスト", "入試", "マーク"];
  b.part("problem", { name: "共通テスト型 大問", description: "第１問の見出し・解答欄・解答群をまとめた問題", tags }, problem1);
  b.part("choices", { name: "共通テスト型 解答群", description: "細い罫の枠に ⓪①… を2列に並べた解答群", tags }, answerGroupSample);

  return {
    parts: b.parts,
    document: templateDocument({
      docId: "official_template_kyotsu_test",
      title: "共通テスト型 数学Ⅰ，数学A",
      pageLayout: {
        preset: "B5",
        pageSize: { widthMm: 182, heightMm: 257 },
        marginsMm: { top: 26, right: 24, bottom: 22, left: 23 },
        header: runningRegion([b.p(subjectName(13), { align: "right" })], { heightMm: 8, offsetMm: 15, showOnFirstPage: false }),
        footer: runningRegion([b.p([b.text("— {page} —", { size: 11 })], { align: "center" })], { heightMm: 8, offsetMm: 12 }),
      },
      content: [title, subtitle, problem1, problem1b],
    }),
  };
}

/** 解答群の番号。⓪ から ⑨ まで。 */
function circled(index: number): string {
  return index === 0 ? "⓪" : String.fromCodePoint(0x2460 + index - 1);
}
