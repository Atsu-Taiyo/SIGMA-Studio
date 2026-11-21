import { GOTHIC, MINCHO, TemplateBuilder, type OfficialTemplateBuild, runningRegion, templateDocument } from "./build";

/**
 * 東京大学 前期日程 (数学) の問題冊子の様式。大学は問題冊子を公開していないので、ブログに載った 2026 年第1問の写しで形を確かめた。
 * 紙は A4、1問を1ページに置き、見出しは中央に字間を空けた「第　１　問」。設問は (1) (2) の
 * ぶら下げで、本文は明朝 11pt、別行の式は中央。問題の下は計算に使う余白として空けておく。
 */

export function createTodaiTemplate(): OfficialTemplateBuild {
  const b = new TemplateBuilder("tpl_todai", { font: MINCHO, size: 11 });
  const heading = (number: string) => b.p([b.text(`第　　${number}　　問`, { font: GOTHIC, bold: true, size: 13 })], { align: "center", spaceAfterPx: 30 });
  const center = (source: string) => b.p(source, { align: "center", lineHeight: "2", spaceAfterPx: 10 });
  const body = (source: string, spaceAfterPx = 10) => b.p(source, { lineHeight: "1.9", spaceAfterPx });
  const items = (sources: string[]) => b.list(sources, { markerStyle: "paren", itemSpaceAfterPx: 14 });

  const problems = [
    b.problem({
      lead: [heading("１")],
      prompt: [
        items([
          "関数 $f(x)=x^3-3x+1$ の区間 $-2\\leqq x\\leqq 2$ における最大値 $M$ および最小値 $m$ を求めよ。",
          "(1) で定めた $M$，$m$ に対し，次の不等式を示せ。",
        ]),
        center("$m<\\int_{0}^{1} f(x)\\,dx<M$"),
      ],
    }),
    b.problem({
      breakBefore: true,
      lead: [heading("２")],
      prompt: [
        body("座標平面上に点 $\\mathrm{A}(1,\\,0)$ をとる。正の実数 $t$ に対し，放物線 $y=x^2$ 上の点 $\\mathrm{P}(t,\\,t^2)$ における接線を $\\ell$ とし，点 $\\mathrm{A}$ から $\\ell$ に下ろした垂線の足を $\\mathrm{H}$ とする。", 16),
        items([
          "点 $\\mathrm{H}$ の座標を $t$ を用いて表せ。",
          "$t$ が正の実数全体を動くとき，線分 $\\mathrm{AH}$ の長さの最小値を求めよ。",
        ]),
      ],
    }),
    b.problem({
      breakBefore: true,
      lead: [heading("３")],
      prompt: [
        body("$n$ を2以上の整数とする。1から $n$ までの番号を1つずつ書いた $n$ 枚のカードがある。これらをよくまぜて1枚ずつ順に取り出し，取り出した順に並べる。$k$ 番目に取り出したカードの番号が $k$ であるとき，$k$ を「一致」とよぶ。", 16),
        items([
          "一致が1つもない確率を $p_n$ とする。$p_2$，$p_3$，$p_4$ を求めよ。",
          "$n\\geqq 3$ のとき，$p_n$ を $p_{n-1}$ と $p_{n-2}$ を用いて表せ。",
        ]),
      ],
    }),
  ];

  const tags = ["東大", "東京大学", "入試", "二次試験"];
  b.part("problem", { name: "東大型 大問", description: "中央の「第　１　問」と (1) (2) の設問", tags }, problems[0]!);

  return {
    parts: b.parts,
    document: templateDocument({
      docId: "official_template_todai",
      title: "東大型 数学 問題冊子",
      pageLayout: {
        preset: "A4",
        pageSize: { widthMm: 210, heightMm: 297 },
        marginsMm: { top: 28, right: 25, bottom: 28, left: 25 },
        footer: runningRegion([b.p([b.text("— {page} —", { size: 10.5 })], { align: "center" })], { heightMm: 8, offsetMm: 12 }),
      },
      content: problems,
    }),
  };
}
