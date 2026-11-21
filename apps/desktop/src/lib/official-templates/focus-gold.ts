import type { LayoutSectionChildBlock, SigmaBlock } from "@/features/document";
import {
  BOOK_MATH_FONT_FAMILY,
  FOCUS_GOLD_COLORS,
  focusGoldExampleFrame,
  focusGoldExampleLabel,
  focusGoldExampleTitle,
  focusGoldFocusFrame,
  focusGoldFocusTitle,
} from "@/lib/reference-book-box-styles";

import { GOTHIC, LATIN_SERIF, MINCHO, TemplateBuilder, type OfficialTemplateBuild, runningRegion, templateDocument } from "./build";

/**
 * Focus Gold (啓林館) の例題ページの様式。啓林館の公開資料 (2026 Focus シリーズ 指導用データ
 * 紹介資料の紙面データ見本、6th Edition) から色と形を測った。紙は A5、本文は明朝 9pt。
 *
 * 角の丸い黒い枠に黒い「例題」の札、難易度は＊。考え方は淡い桃色の地、要点は桃色の蛍光。
 * 解答の右には水色の◀で補足を並べ、最後に黒い札の Focus 枠でまとめる。
 */

const { ink: INK, cyan: CYAN, pinkFill: PINK_FILL, pinkMark: PINK_MARK } = FOCUS_GOLD_COLORS;

export function createFocusGoldTemplate(): OfficialTemplateBuild {
  const b = new TemplateBuilder("tpl_focus_gold", { font: MINCHO, size: 9 }, BOOK_MATH_FONT_FAMILY);
  const gothic = (text: string, style: { bold?: boolean; color?: string; size?: number; background?: string; boxed?: "frame" | "oval" } = {}) =>
    b.text(text, { font: GOTHIC, ...style });

  /** 例題の枠は組み込みの「例題（Focus Gold型）」と同じ。＊の難易度は帯の右端。 */
  const example = (number: number, heading: string, level: number, body: SigmaBlock[]) => b.box(focusGoldExampleFrame(), body, {
    styleId: "focus-gold-reidai",
    subtitle: focusGoldExampleLabel("例 題", String(number)),
    title: focusGoldExampleTitle(heading, level),
    spaceAfterPx: 6,
  });

  /** 考え方: 淡い桃色の地。囲みの札を左の欄に置き、(1) (2) は札の右で揃える。 */
  const approach = (blocks: LayoutSectionChildBlock[]) => b.box({
    titleVisible: false,
    borderWidthPx: 0,
    borderColor: "transparent",
    borderStyle: "none",
    backgroundColor: PINK_FILL,
    cornerStyle: "sharp",
    paddingPx: { top: 5, right: 8, bottom: 5, left: 8 },
  }, [
    b.columns([[b.p([gothic("考え方", { bold: true, size: 8.5, boxed: "frame" })], { lineHeight: "1.5" })], blocks], { widths: [0.14, 0.86], gapMm: 1 }),
  ], { styleId: "fancybox", spaceAfterPx: 8 });
  const mark = (source: string) => b.rich(source, { background: PINK_MARK });

  const answerLabel = () => gothic(" 解答 ", { bold: true, color: "#ffffff", background: INK, size: 8.5 });
  const note = (source: string) => b.p([b.text("◀", { color: CYAN, size: 9 }), ...b.rich(source, { size: 8 })], { lineHeight: "1.55" });
  const answer = (body: LayoutSectionChildBlock[], notes: LayoutSectionChildBlock[]) => b.columns(
    [body, [b.sideNotes(notes, INK)]],
    { widths: [0.71, 0.29], gapMm: 3, spaceAfterPx: 10 },
  );

  /** 組み込みの「Focus（Focus Gold型）」と同じ枠。 */
  const focus = (line: string) => b.box(focusGoldFocusFrame(), [b.p(b.rich(line, { bold: true, font: GOTHIC, size: 10 }), { lineHeight: "1.6" })], {
    styleId: "focus-gold-focus",
    title: focusGoldFocusTitle("Focus"),
    spaceAfterPx: 14,
  });

  const practice = (number: number, items: string[]) => [
    b.p([
      gothic(" 練習 ", { bold: true, size: 9, boxed: "oval" }),
      b.text(`${number} `, { font: LATIN_SERIF, size: 11, boxed: "oval" }),
      b.text("　"),
      ...b.rich(items[0]!),
    ], { lineHeight: "1.6" }),
    ...items.slice(1).map((item) => b.p(`　　　　　${item}`, { lineHeight: "1.6" })),
    b.p([gothic(" ＊", { size: 9 })], { spaceAfterPx: 10 }),
  ];

  const problem1 = b.problem({
    prompt: [
      example(1, "多項式の加法・減法", 1, [
        b.list([
          "$A=3x^2-2x+1$，$B=x^2+4x-5$ のとき，$2A-3B$ を計算せよ。",
          "$A=x^2-xy+2y^2$，$B=2x^2+xy-y^2$ のとき，等式 $X+A=3(X-B)$ を満たす多項式 $X$ を求めよ。",
        ], { markerStyle: "paren", itemSpaceAfterPx: 2 }),
      ]),
    ],
    hints: [
      approach([
        b.p([b.text("(1)　直接代入しないで，"), ...mark("まず求める式を簡単にしてから代入する．")], { lineHeight: "1.5" }),
        b.p("(2)　まず等式を $X$ について整理する．左辺に $X$，右辺に $A$，$B$ を移項する．", { lineHeight: "1.5" }),
      ]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("　(1)　$2A-3B$")], { lineHeight: "1.6" }),
        b.p("　　　　$=2(3x^2-2x+1)-3(x^2+4x-5)$", { lineHeight: "1.6" }),
        b.p("　　　　$=6x^2-4x+2-3x^2-12x+15$", { lineHeight: "1.6" }),
        b.p([b.text("　　　　"), b.math("=3x^2-16x+17", { bold: true })], { lineHeight: "1.6" }),
        b.p("　　(2)　$X+A=3X-3B$ より　$2X=A+3B$", { lineHeight: "1.6" }),
        b.p("　　　　$2X=(x^2-xy+2y^2)+3(2x^2+xy-y^2)$", { lineHeight: "1.6" }),
        b.p("　　　　　$=7x^2+2xy-y^2$", { lineHeight: "1.6" }),
        b.p([b.text("　　　　よって，"), b.math("X=\\dfrac{7}{2}x^2+xy-\\dfrac{1}{2}y^2", { bold: true })], { lineHeight: "1.6" }),
      ], [
        note("括弧を忘れない．"),
        note("同類項をまとめる．"),
        note("代入する前に，与えられた式を整理する．"),
      ]),
      focus("代入する前に与えられた式を整理せよ"),
      ...practice(1, [
        "$A=2x^2-3x+1$，$B=-x^2+x-4$ のとき，$3A-2(A-B)$ を計算せよ．",
      ]),
    ],
  });

  const problem2 = b.problem({
    prompt: [
      example(2, "展開の工夫", 2, [
        b.p("次の式を展開せよ．", { lineHeight: "1.5" }),
        b.columns([
          [b.p("(1)　$(x+y-2)(x+y+3)$")],
          [b.p("(2)　$(x+1)(x+2)(x-1)(x-2)$")],
        ], { gapMm: 4 }),
      ]),
    ],
    hints: [
      approach([
        b.p([b.text("(1)　"), ...mark("共通な部分を1つの文字におき換える．")], { lineHeight: "1.5" }),
        b.p("(2)　組み合わせを工夫して，共通な式をつくる．", { lineHeight: "1.5" }),
      ]),
    ],
    solution: [
      answer([
        b.p([answerLabel(), ...b.rich("　(1)　$x+y=t$ とおくと")], { lineHeight: "1.6" }),
        b.p("　　　　$(t-2)(t+3)=t^2+t-6$", { lineHeight: "1.6" }),
        b.p([b.text("　　　　"), b.math("=x^2+2xy+y^2+x+y-6", { bold: true })], { lineHeight: "1.6" }),
      ], [
        note("$x+y$ をひとまとめにみる．"),
      ]),
      focus("共通な部分はおき換えて，式の形をとらえよ"),
    ],
  });

  const tags = ["Focus Gold", "フォーカスゴールド", "参考書", "例題"];
  b.part("problem", { name: "Focus Gold型 例題一式", description: "例題の枠・考え方・解答・Focus・練習をまとめた問題", tags }, problem1);
  b.part("header", { name: "Focus Gold型 例題の枠", description: "角の丸い黒枠に黒い「例題」の札と＊の難易度", tags }, problem1.prompt[0]!);
  b.part("approach", { name: "Focus Gold型 考え方", description: "淡い桃色の地に囲みの「考え方」の札", tags }, problem1.hints[0]!);
  b.part("answer", { name: "Focus Gold型 解答と補足", description: "黒い「解答」の札と、右の欄に水色の◀の補足", tags }, problem1.solution[0]!);
  b.part("focus", { name: "Focus Gold型 Focus", description: "黒い札の Focus 枠", tags }, problem1.solution[1]!);

  return {
    parts: b.parts,
    document: templateDocument({
      docId: "official_template_focus_gold",
      title: "Focus Gold型 例題ページ",
      pageLayout: {
        pageSize: { widthMm: 148, heightMm: 210 },
        marginsMm: { top: 15, right: 13, bottom: 13, left: 14 },
        header: runningRegion([b.p([gothic("1　多項式の計算・因数分解　　{page}", { size: 9.5 })], { align: "right" })], { heightMm: 6, offsetMm: 7 }),
      },
      content: [problem1, problem2],
    }),
  };
}
