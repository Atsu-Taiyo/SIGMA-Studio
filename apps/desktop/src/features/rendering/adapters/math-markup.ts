import { TRUSTED_SIGMA_MATH_CLASSES } from "@/lib/math-macros";

import { escapeHtml } from "./rich-text-html";

/**
 * 数式 markup の無害化。
 *
 * MathLive は text モード (`\text` `\mbox` `\textbf` `\textit` `\textrm` `\texttt` `\textsf`
 * `\textup` `\textnormal` `\operatorname`) の中身を**無加工で** markup へ書き出す。
 * その markup は `dangerouslySetInnerHTML` / `element.innerHTML` / SVG の `<foreignObject>` へ
 * 入るので、教材データ (import・クラウド共有・AI 生成・MCP) 由来の TeX がそのままスクリプトに
 * なりうる。`lib/math-tex.ts` の `normalizeMathTextRuns` は日本語の連続を自動で `\text{}` に
 * 包むため、日本語教材ではこの経路を運用で避けることはできない。
 *
 * 方式は「許可リストに厳密一致したタグだけ残し、それ以外は**除去ではなくエスケープ**」。
 * mXSS の主経路は「サニタイザが除去して再直列化した結果をブラウザが別解釈する」ことなので、
 * ここでは何も除去せず必ずエスケープする。結果としてテキスト位置に生の `<` `>` `&` が
 * 1 文字も残らず、後段の文字列連結 (`rich-text-html.ts` の `mathBody`) で新しいタグが
 * 生えることもない。副次的に、MathLive が `a<b` に吐く裸の `<` が消えるので
 * `<foreignObject>` を含む SVG 書き出しが XML として妥当になる。
 *
 * 入口 (TeX) 側で危険な文字を弾く方式は採らない。`<` `>` `&` は `$a<b$` や
 * `\begin{aligned}…&…\end{aligned}` のようにごく普通の数学で出るため、防御ではなく機能破壊になる。
 */

export interface SanitizedMathMarkup {
  /** 無害化済みの markup。`safe` が false でも「エスケープ済みで安全」な文字列である。 */
  html: string;
  /**
   * タグの入れ子が閉じている (= 元の markup が構造として壊れていない) か。
   * false のとき呼び出し側は素の TeX 表示へ落とす。
   */
  safe: boolean;
}

/**
 * 許可タグ。前半 4 つは MathLive / KaTeX に非退行コーパスを流して**実測**した集合
 * (`math-html.security.test.ts` が「実測 ⊆ この集合」を門番として固定している)。
 * 後半は同族の SVG 図形と `<br>` で、版上げで新しい図形が出たときに数式が丸ごと
 * 生 TeX 表示へ落ちないための余裕分。
 *
 * `a` `img` `iframe` `script` `style` `link` `form` `foreignObject` `use` `animate` などは
 * 意図的に含めない。含めないタグは削除されずエスケープされ、可視テキストになる。
 */
export const MATH_MARKUP_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "span",
  "svg",
  "path",
  "line",
  "br",
  "circle",
  "ellipse",
  "g",
  "polygon",
  "polyline",
  "rect",
]);

/**
 * 許可属性。`class` `style` `part` `aria-hidden` と SVG の幾何属性のみ。
 * `href` / `xlink:href` / `src` / `id` / `data-*` / `on*` は入れない
 * (`\href` `\cssId` `\htmlData` の産物を落とすため)。大文字小文字は区別する
 * — `viewBox` / `preserveAspectRatio` は SVG で大小が意味を持ち、
 * `ONERROR` のような大文字化での回避は「一致しない = 落ちる」で閉じる。
 */
export const MATH_MARKUP_ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "aria-hidden",
  "class",
  "part",
  "style",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "height",
  "opacity",
  "points",
  "preserveAspectRatio",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "transform",
  "vector-effect",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
]);

/** HTML の void 要素のうち許可リストに含まれるもの。閉じタグを取らず入れ子の数にも入らない。 */
const VOID_TAGS: ReadonlySet<string> = new Set(["br"]);

/**
 * 厳密なタグ文法だけを走査する。属性値は二重引用符・一重引用符・引用符なしの 3 形を受ける
 * — MathLive は伸縮矢印の SVG で `style=height:0.522em` `width=400em` と**引用符なし**で吐くので、
 * 二重引用符しか受けないと正当な数式が丸ごとエスケープされて画面に生タグが出る (実測)。
 * 引用符付きの値に `>` を許すのはブラウザのトークナイザに合わせるため。値の検査は後段で行う。
 */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'`=<>]+))?)*)\s*(\/?)>/y;

const ATTRIBUTE_PATTERN = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s"'`=<>]+)))?/g;

/**
 * XML の定義済み実体と数値文字参照だけをそのまま残す。名前付き実体 (`&nbsp;` など) は
 * `&` をエスケープして落とし、出力を常に XML 妥当に保つ。
 *
 * 数値文字参照を残すのは安全 — HTML パーサはテキスト位置の実体参照を「文字」に戻すだけで
 * 再パースしないので、`&#60;img&#62;` がタグになることはない。
 */
const PRESERVED_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g;

/**
 * 許可する CSS プロパティ。MathLive / KaTeX に非退行コーパスを流して**実測**した集合に、
 * 版上げの余裕として無害な組版プロパティを足したもの
 * (`math-html.security.test.ts` が「実測 ⊆ この集合」を門番として固定している)。
 *
 * プロパティを許可制にするのは、スクリプトが実行できなくても**画面を覆えれば十分に危険**なため。
 * `position:fixed` + 不透明な背景 + 大きな `z-index` があれば、他人が作った教材がアプリの
 * クロームごと覆い隠して偽の UI を出せる (クリックジャッキング / 白画面に見える事故)。
 * 許可外のプロパティは**その宣言だけ**落ちるので、版上げで新しい宣言が出ても数式が丸ごと
 * 生 TeX 表示になることはない (fail-closed の罠を避ける)。
 */
export const MATH_MARKUP_ALLOWED_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  // 実測で出るもの
  "--bg-color",
  "background-color",
  "border",
  "border-bottom-width",
  "border-radius",
  "border-right-width",
  "border-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-sizing",
  "color",
  "display",
  "font-size",
  "height",
  "left",
  "line-height",
  "margin-left",
  "margin-right",
  "margin-top",
  "min-width",
  "opacity",
  "overflow",
  "padding-left",
  "padding-right",
  "pointer-events",
  "position",
  "top",
  "vertical-align",
  "width",
  "z-index",
  // 余裕分 (同族の組版プロパティ)
  "border-bottom",
  "border-color",
  "border-left",
  "border-left-width",
  "border-right",
  "border-top",
  "font-family",
  "font-style",
  "font-weight",
  "letter-spacing",
  "margin-bottom",
  "max-height",
  "max-width",
  "min-height",
  "padding-bottom",
  "padding-top",
  "right",
  "text-align",
  "text-decoration",
  "visibility",
  "white-space",
]);

/** 実測値は `relative` / `absolute` のみ。`fixed` / `sticky` はビューポートを覆えるので通さない。 */
const SAFE_CSS_POSITION_VALUES: ReadonlySet<string> = new Set(["absolute", "relative", "static"]);

/**
 * 宣言の値に現れてよい大きさ。単位は **ルート em 換算** (`CSS_UNIT_IN_EM`)。既定は実測最大
 * (`top` の 4.55em) の余裕分で、実測がそれを超えるプロパティだけ個別に緩める
 * (`math-html.security.test.ts` が実測を固定する)。
 *
 * 位置指定そのものは MathLive の `ML__prompt` が `position:absolute` を必要とするので禁じられない。
 * 代わりに寸法を抑えて「画面を覆える大きさの箱」を作れなくする。20em ≒ 320px は、被覆判定の
 * しきい値 (`math-html.security.test.ts` の `SCREEN_COVERING_EM = 50`) の十分下。
 */
const CSS_VALUE_MAGNITUDE_LIMITS: Readonly<Record<string, number>> = {
  "z-index": 10,
};
const CSS_DEFAULT_MAGNITUDE_LIMIT = 20;

/**
 * 1 単位あたりのルート em 換算。**未知の単位は宣言ごと落とす** (fail-closed)。
 *
 * 単位を見ずに数値だけを比べていたときは `width:100in` (= 9600px) や `width:calc(400em - 399px)`
 * (畳み込み値 1・実効 6001px) が上限を素通りした。`%` は 100% = 1 (= 親/コンテナ 1 個分) として
 * 数える — `font-size:207.4%` が 2.074 と読め、`width:calc(100% * 100)` が 100 と読める。
 */
const CSS_UNIT_IN_EM: Readonly<Record<string, number>> = {
  "": 1, em: 1, rem: 1, pc: 1, ex: 0.5, ch: 0.5,
  px: 1 / 16, pt: 1 / 12, cm: 2.3622, mm: 0.23622, q: 0.05906, in: 6,
};

/**
 * `%` の em 換算はプロパティで変わる。`font-size:207.4%` は親フォントの 2.074 倍なので 0.01/%
 * が正しく、`position:absolute` と一緒に出る `width:100%` (`\bbox` の枠と伸縮矢印の実出力) も
 * この換算でなければ落ちてしまう。一方 **高さ**の百分率は包含ブロック — 位置指定の祖先が無ければ
 * 初期包含ブロック = ビューポート — に対して解かれるので、`height:100%` は 1 宣言で画面を覆える。
 * 実測に高さの百分率は 1 件も無いので、こちらだけ「ビューポート相当」で数える。
 */
const PERCENT_IN_EM_DEFAULT = 0.01;
const PERCENT_IN_EM_VIEWPORT = 0.5;
const CSS_VIEWPORT_PERCENT_PROPERTIES: ReadonlySet<string> = new Set([
  "height", "max-height", "min-height",
  // 縦の百分率パディング/マージンは包含ブロックの **幅** に対して解かれ、背景はパディング
  // ボックスまで塗られる。実測に百分率のパディング/マージンは 1 件も無い。
  "margin-bottom", "margin-left", "margin-right", "margin-top",
  "padding-bottom", "padding-left", "padding-right", "padding-top",
]);

/**
 * font-size の累積倍率を **掛けない** プロパティ。純数・キーワード・色だけを取るものの列挙で、
 * ここに載っていない許可プロパティはすべて長さとして扱う (fail-closed) — 「長さの一覧」を
 * 持つ形にすると、許可リストに `border-width` を足した瞬間に倍率も `var()` 禁止も静かに外れる。
 */
const CSS_UNSCALED_PROPERTIES: ReadonlySet<string> = new Set([
  "--bg-color", "background-color", "border-color", "border-style", "box-sizing", "color",
  "display", "font-family", "font-style", "font-weight", "line-height", "opacity", "overflow",
  "pointer-events", "position", "text-align", "text-decoration", "visibility", "white-space",
  "z-index",
]);

/**
 * `font-size` の **累積** 上限 (ルート em)。1 宣言ずつ見ていると `font-size:999em` の中に
 * `width:20em` を置くだけで実効 20000em になる (`em` は自分自身の font-size に対して解くため)。
 * サニタイザは開いているタグを追えるので、累積倍率も同じスタックで持てる。
 */
const CSS_FONT_SCALE_LIMIT = 20;

/** SVG 要素自身の `height` 属性の上限 (ルート em 換算)。実測最大は 0.548em。 */
const SVG_HEIGHT_ATTRIBUTE_LIMIT = 20;

/**
 * SVG 子要素の幾何値を `viewBox` の範囲の何倍まで許すか。
 *
 * `overflow:visible` (MathLive の伸縮グリフが実出力する) は SVG ビューポートのクリップを外すので、
 * 子要素は svg の箱の**外側**へ描かれる。`<svg width="1em" height="1em">` の中の
 * `<rect width="99999" height="99999">` は、`<svg height>` の上限も CSS の寸法上限も迂回して
 * 画面を覆う。実寸は `ユーザー単位 × (svg の CSS 寸法 / viewBox 範囲)` なので、**viewBox 範囲に
 * 対する倍率**で縛れば、描かれる実寸は svg 自身の寸法の定数倍に収まる。
 *
 * 実測 (`\overrightarrow` `\xrightarrow` `\enclose` `\sqrt` 等の全 svg) の最大比は 1.0000 ちょうど
 * なので、2 倍は 2 倍の余裕がある。svg の高さは 20em 上限なので、描かれる高さは 40em 以下に収まる
 * (`math-html.security.test.ts` の被覆しきい値 50em の下)。
 */
const SVG_USER_SPACE_BUDGET_RATIO = 2;

/** `viewBox` を持たない svg のユーザー単位は CSS px。実測は全 svg が viewBox を持つ。 */
const SVG_USER_SPACE_FALLBACK_BUDGET = 320;

/** ユーザー単位で書かれる幾何属性。数値だけを見る (単位は付かない)。 */
const SVG_PATH_ATTRIBUTES: ReadonlySet<string> = new Set(["d", "points", "transform"]);

/** 単一の長さを取る幾何属性。ユーザー単位にも CSS 単位にもなり得る。 */
const SVG_SCALAR_GEOMETRY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "cx", "cy", "height", "r", "rx", "ry", "width", "x", "x1", "x2", "y", "y1", "y2",
]);

/** ユーザー単位の生の数値 (path データは `v40` のように直前が英字なので lookbehind を使わない)。 */
const SVG_USER_SPACE_NUMBER = /-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;

/** 塗りではなく線で面を作る経路。ユーザー単位なので幾何値と同じ予算に載せる。 */
const SVG_STROKE_ATTRIBUTES: ReadonlySet<string> = new Set(["stroke-width", "stroke-dasharray"]);

/** x 軸・y 軸のどちらの予算で測るか。 */
const SVG_X_AXIS_ATTRIBUTES: ReadonlySet<string> = new Set(["cx", "rx", "width", "x", "x1", "x2"]);
const SVG_Y_AXIS_ATTRIBUTES: ReadonlySet<string> = new Set(["cy", "height", "ry", "y", "y1", "y2"]);

interface SvgUserSpaceBudget {
  /** `d` / `points` は軸が静的に決まらないので、大きい方の範囲で測る。 */
  extent: number;
  x: number;
  y: number;
}

/**
 * 16 進カラーの中の数字を長さと読み違えないよう、直前が `#` や英数字の並びは数えない。
 * 指数部を **1 トークンとして** 読むのが要点で、これが無いと `1e5em` は `1` だけが上限判定に
 * 載り (`5` は直前が `e` = `\w` なので lookbehind で捨てられる)、実効 100000em が素通りする。
 */
const CSS_NUMBER_TOKEN = /(?<![#\w.])([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(%|[a-z]+)?/gi;

/** `packages/viewer/src/viewer-safety.ts` の `isSafeCssScalar` と同じ思想の宣言単位の検査。 */
const CSS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const CSS_ESCAPE_OR_DELIMITER = /[\\;{}<>]/u;
// ビューポート単位も落とす。`100vw`/`100vh` は数式の組版には現れず、画面を覆う唯一の寸法手段。
// `calc(` と `var(` は **禁止しない**: MathLive の SSR ビルドが `\enclose` / `\bbox` に
// `width:calc(100% - 2 * <padding>)` や `left:calc(-1 * <n> - <o>em)` を、`\placeholder` に
// `var(--correct-color, …)` を実出力し、KaTeX も accent の skew 補正に `calc(100% - <2*skew>em)`
// を出す。禁止すると囲み記号の位置と寸法が黙って変わる (`math-html.security.test.ts` の
// 「実測 ⊆ 受理集合」門番が赤くなる)。代わりに `calc()` は畳み込んで上限判定に載せる。
// `min(` / `max(` / `clamp(` / `attr(` / `env(` は実出力 0 件なので禁止できる。
const CSS_UNSAFE_TOKEN = /(?:url\s*\(|min\s*\(|max\s*\(|clamp\s*\(|attr\s*\(|env\s*\(|@import\b|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|\/\*|\d\s*(?:[sldp]?v(?:h|w|i|b|min|max)|cq(?:w|h|i|b|min|max))\b)/iu;
/** `calc()` の入れ子の深さ上限。超えたら評価せず宣言ごと落とす。 */
const CSS_CALC_MAX_DEPTH = 16;
/**
 * 値に現れてよい関数。**禁止リストではなく許可リスト**にするのが要点で、`min(`/`max(`/`clamp(`
 * を数え上げる方式だと `calc-size(` `round(` `hypot(` `abs(` `pow(` のようにブラウザへ新しい
 * 数学関数が入るたびに穴が開く (実測: `calc-size(0px, 100em * 100)` は上限判定を素通りして
 * 160000px を描く)。未知の関数が 1 つでも残っていれば宣言ごと落とす。
 */
const CSS_FUNCTION_TOKEN = /(?<![\w-])(-webkit-|-moz-)?([a-z][a-z0-9-]*)\s*\(/gi;
const CSS_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(["calc", "var"]);
/** `var()` は中身が静的に読めないので、寸法系プロパティでは許さない (上限判定が空振りする)。 */
const CSS_CALC_FUNCTION = /(?<![\w-])(?:-webkit-|-moz-)?calc\s*\(/gi;
const STYLE_ATTRIBUTE_LENGTH_LIMIT = 2048;

/**
 * 許可するクラストークン。**文字種ではなくトークンそのものを許可制にする**。
 *
 * 文字種だけを見ていると、教材の TeX がアプリ自身の CSS クラスを名指しできてしまう。
 * `globals.css` は素のグローバルスタイルシートで `position: fixed` の規則を多数持ち、
 * 例えば `.startup-splash` は `position:fixed; inset:0; z-index:10000; background:#fff` なので、
 * `\text{<span class=startup-splash>…</span>}` だけでアプリ全体を覆う偽の画面が作れる。
 * インライン `style` をいくら絞ってもこの経路は閉じない (クラスを借りるので `style` を使わない)。
 * しかも教材タイトルはクラウド共有の一覧で**開かなくても**描画される。
 *
 * 集合は MathLive / KaTeX の実測 (`math-html.security.test.ts` の門番テストが
 * 「実測 ⊆ ここで受理されるもの」を固定する)。許可外のトークンは**そのトークンだけ**落ちるので、
 * 版上げで新しいクラスが出ても数式が丸ごと生 TeX 表示になることはない。
 */
const SAFE_CLASS_TOKEN_PATTERNS: readonly RegExp[] = [
  /^ML__[A-Za-z0-9_-]+$/,
  /^katex(?:-[a-z]+)*$/,
  /^(?:reset-)?size\d{1,2}$/,
  /^delim-size\d$/,
  /^col-align-[a-z]$/,
  /^slice-\d+-of-\d+$/,
];

/** パターンに乗らない KaTeX のクラス (実測)。 */
const SAFE_CLASS_TOKENS: ReadonlySet<string> = new Set([
  ...TRUSTED_SIGMA_MATH_CLASSES,
  "accent", "accent-body", "allowbreak", "amsrm", "arraycolsep", "base", "boxpad",
  "brace-center", "brace-left", "brace-right", "cjk_fallback", "colorbox", "delimcenter",
  "delimsizing", "fbox", "fix", "frac-line", "hide-tail", "hline", "inner", "large-op", "lcGreek",
  "mathbb", "mathbf", "mathcal", "mathdefault", "mathfrak", "mathit", "mathnormal", "mathrm",
  "mathscr", "mathsf", "mathtt", "mbin", "mclose", "mfrac", "minner", "mop", "mopen", "mord",
  "mover", "mpunct", "mrel", "mspace", "msupsub", "mtable", "mtight", "mult", "munder",
  "newline", "nobreak", "nulldelimiter", "op-limits", "op-symbol", "overlay", "overline",
  "overline-line", "pstrut", "rlap", "root", "rule", "sizing", "small-op", "smash", "sout",
  "sqrt", "sqrt-line", "sqrt-sign", "stretchy", "strut", "svg-align", "text", "textbf",
  "textit", "textrm", "textsf", "texttt", "textup", "thinbox", "underline", "underline-line",
  "vbox", "vertical-separator", "vlist", "vlist-r", "vlist-s", "vlist-t", "vlist-t2",
  "x-arrow", "x-arrow-pad",
]);

const SAFE_CLASS_VALUE = /^[\w\-. ]*$/;

/** XML 1.0 が禁じる制御文字 (タブ・改行・復帰は除く)。`d` の path データは改行を含む。 */
const ATTRIBUTE_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

export function sanitizeMathMarkup(markup: string): SanitizedMathMarkup {
  let html = "";
  let cursor = 0;
  let balanced = true;
  let svgDepth = 0;
  const openTags: string[] = [];
  // 開いている要素ごとの font-size 累積倍率 (ルート em に対する倍率)。`em` は要素自身の
  // font-size で解かれるので、1 宣言ずつ上限を見るだけでは入れ子で掛け算されて逃げられる。
  const fontScales: number[] = [];
  // 開いている `<svg>` ごとの子要素幾何値の予算 (ユーザー単位)。`viewBox` から決まる。
  const svgUserSpaceBudgets: SvgUserSpaceBudget[] = [];

  while (cursor < markup.length) {
    const tagStart = markup.indexOf("<", cursor);
    if (tagStart < 0) {
      html += escapeMathText(markup.slice(cursor));
      break;
    }
    html += escapeMathText(markup.slice(cursor, tagStart));

    TAG_PATTERN.lastIndex = tagStart;
    const match = TAG_PATTERN.exec(markup);
    if (!match) {
      // タグ文法に一致しない `<` は文字として扱う。ブラウザのトークナイザも
      // `a<b` の `<` をタグの開始とは読まない。
      html += "&lt;";
      cursor = tagStart + 1;
      continue;
    }

    const [raw, closingSlash, rawName, rawAttributes, selfClosingSlash] = match;
    cursor = tagStart + raw.length;
    const name = rawName.toLowerCase();

    if (!MATH_MARKUP_ALLOWED_TAGS.has(name)) {
      html += escapeMathText(raw);
      continue;
    }

    if (closingSlash) {
      if (VOID_TAGS.has(name)) {
        html += escapeMathText(raw);
        continue;
      }
      if (openTags.pop() !== name) {
        balanced = false;
      }
      fontScales.pop();
      if (name === "svg") {
        svgDepth = Math.max(0, svgDepth - 1);
        svgUserSpaceBudgets.pop();
      }
      html += `</${name}>`;
      continue;
    }

    const inheritedFontScale = fontScales[fontScales.length - 1] ?? 1;
    const parentBudget = svgUserSpaceBudgets[svgUserSpaceBudgets.length - 1] ?? null;
    const { fontScale, serialized: attributes, viewBox } = serializeAttributes(
      rawAttributes,
      name,
      inheritedFontScale,
      // 最も外側の `<svg>` 自身の幾何だけは CSS 側の規則で見る。入れ子の `<svg>` の幾何は
      // 親のユーザー座標系の値なので、親の予算で測らないと予算が丸ごと無効になる。
      name === "svg" && parentBudget === null ? null : parentBudget,
    );
    // HTML では非 void 要素の `/>` は無視され開始タグになる。SVG (foreign content) の中だけ
    // 自己閉じが効くので、そこだけ `/>` を保つ。`<foreignObject>` は XML なので閉じ忘れは即不正。
    const selfClosed = selfClosingSlash === "/" && (svgDepth > 0 || name === "svg");
    if (VOID_TAGS.has(name) || selfClosed) {
      html += `<${name}${attributes}/>`;
      continue;
    }
    html += `<${name}${attributes}>`;
    openTags.push(name);
    fontScales.push(fontScale);
    if (name === "svg") {
      svgDepth += 1;
      // **出力に残った** `viewBox` から決める。生の属性文字列から読むと、大文字小文字違いや
      // 別名 (`data-viewBox=…`) の囮で「出力には無い viewBox」から予算を作れてしまう。
      svgUserSpaceBudgets.push(svgUserSpaceBudget(viewBox));
    }
  }

  return { html, safe: balanced && openTags.length === 0 };
}

function serializeAttributes(
  rawAttributes: string,
  tagName: string,
  inheritedFontScale: number,
  userSpaceBudget: SvgUserSpaceBudget | null,
): {
  fontScale: number;
  serialized: string;
  viewBox: string | null;
} {
  if (!rawAttributes.trim()) {
    return { fontScale: inheritedFontScale, serialized: "", viewBox: null };
  }

  ATTRIBUTE_PATTERN.lastIndex = 0;
  const attributes = [...rawAttributes.matchAll(ATTRIBUTE_PATTERN)];
  // `style` は他の属性より先に解く: この要素の font-size は自分の長さにも `<svg height>` にも
  // 子孫の長さにも効くので、判定を属性の並び順に依存させない。
  const rawStyle = attributes.find((attribute) => attribute[1] === "style");
  const styleValue = rawStyle?.[2] ?? rawStyle?.[3] ?? rawStyle?.[4] ?? "";
  const style = rawStyle && !hasUnsafeAttributeCharacters(styleValue)
    ? checkStyleAttribute(styleValue, inheritedFontScale)
    : { fontScale: inheritedFontScale, safe: false };
  // 落ちた `style` の倍率は引き継がない (描画にも効かない)。1 未満へも下げない — 小さな
  // font-size で子孫の上限を緩められること自体が抜け道になる。
  const fontScale = Math.max(1, style.safe ? style.fontScale : inheritedFontScale);

  const seen = new Set<string>();
  let serialized = "";
  let viewBox: string | null = null;
  // `<svg>` に高さの指定が全く無いと、Chromium は `viewBox` の縦横比と **上限の無い `width`** から
  // 高さを導く。実測に高さ無しの svg は 1 件も無いので、その場合は導かれる高さを上限に載せる。
  const declaresHeight = tagName !== "svg"
    || attributes.some((attribute) => attribute[1] === "height")
    || /(?:^|;)\s*height\s*:/i.test(styleValue);
  for (const attribute of attributes) {
    const name = attribute[1];
    if (!MATH_MARKUP_ALLOWED_ATTRIBUTES.has(name) || seen.has(name)) {
      continue;
    }
    const rawValue = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    // 値は必ず二重引用符で囲み直すので、`<` `>` `&` `"` を含む値は属性ごと落とす。**すべての
    // 属性で先に**行う: `style` だけこの検査を飛ばすと、単引用符で囲まれた値の中の `"` が属性を
    // 閉じて後ろに `onmouseover=` を生やせる (属性ブレイクアウト)。
    if (hasUnsafeAttributeCharacters(rawValue)) {
      continue;
    }
    if (name === "style") {
      // `<svg>` の中の要素の `style` は実測 0 件。SVG 2 の幾何プロパティ (`width`/`height`) が
      // CSS 側から効いてしまい、ユーザー単位の予算が丸ごと迂回されるので受け付けない。
      if (!style.safe || userSpaceBudget !== null) {
        continue;
      }
      seen.add(name);
      serialized += ` ${name}="${rawValue}"`;
      continue;
    }
    if (name === "viewBox" && tagName === "svg") {
      viewBox = rawValue;
    }
    if (!isSafeAttributeValue(name, rawValue, tagName, fontScale, userSpaceBudget, declaresHeight)) {
      // 値は書き換えず属性ごと落とす。書き換えると二重エスケープや意図しない値の変質を招く。
      continue;
    }
    // `class` だけはトークン単位で選別する (許可外クラス 1 つで組版全体を捨てないため)。
    const value = name === "class" ? sanitizeClassValue(rawValue) : rawValue;
    if (value === null) {
      continue;
    }
    seen.add(name);
    serialized += ` ${name}="${value}"`;
  }
  return { fontScale, serialized, viewBox };
}

/**
 * `<svg>` の `viewBox` から、その中の要素が使ってよいユーザー単位の予算を決める。
 * `viewBox` が無ければユーザー単位は CSS px なので、小さな固定値へ倒す (fail-closed)。
 */
function svgUserSpaceBudget(viewBox: string | null): SvgUserSpaceBudget {
  const fallback: SvgUserSpaceBudget = {
    extent: SVG_USER_SPACE_FALLBACK_BUDGET,
    x: SVG_USER_SPACE_FALLBACK_BUDGET,
    y: SVG_USER_SPACE_FALLBACK_BUDGET,
  };
  if (!viewBox) {
    return fallback;
  }
  const numbers = viewBox.trim().split(/[\s,]+/).map(Number);
  // 負や 0 の範囲は SVG としてエラーで、Chromium は `viewBox` ごと無視する (= ユーザー単位 = px)。
  // `Math.abs` で拾うと「ブラウザが使わない座標系」から予算を作ってしまう。
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))
    || numbers[2] <= 0 || numbers[3] <= 0) {
    return fallback;
  }
  return {
    extent: Math.max(numbers[2], numbers[3]) * SVG_USER_SPACE_BUDGET_RATIO,
    x: numbers[2] * SVG_USER_SPACE_BUDGET_RATIO,
    y: numbers[3] * SVG_USER_SPACE_BUDGET_RATIO,
  };
}

/**
 * `<svg>` の中の幾何値。**ユーザー単位の生の数値だけ**を受け付け、軸ごとの予算で縛る。
 *
 * 単位付きの値と百分率は受け付けない (実測 0 件): SVG では単位付き長さもユーザー単位へ変換されて
 * から viewBox の倍率が掛かるため、em 換算の上限で測ると倍率のぶんだけ素通りする。
 */
function isSafeSvgGeometryValue(
  name: string,
  value: string,
  budget: SvgUserSpaceBudget,
): boolean {
  if (name === "transform") {
    // 実測 0 件。ユーザー単位そのものを拡大・移動でき、予算の前提を壊す。
    return false;
  }
  // `d` / `points` はコマンド文字を含むので、単位の拒否は単一の長さを取る属性にだけ課す。
  if (!SVG_PATH_ATTRIBUTES.has(name) && /[a-z%]/i.test(value)) {
    return false;
  }
  const limit = SVG_X_AXIS_ATTRIBUTES.has(name)
    ? budget.x
    : SVG_Y_AXIS_ATTRIBUTES.has(name) ? budget.y : budget.extent;
  SVG_USER_SPACE_NUMBER.lastIndex = 0;
  for (const token of value.matchAll(SVG_USER_SPACE_NUMBER)) {
    const magnitude = Math.abs(Number(token[0]));
    if (!Number.isFinite(magnitude) || magnitude > limit) {
      return false;
    }
  }
  return true;
}

/** 値を二重引用符で囲み直せなくなる文字。属性ごと落とす。 */
function hasUnsafeAttributeCharacters(value: string): boolean {
  return /[<>&"]/.test(value) || ATTRIBUTE_CONTROL_CHARACTER.test(value);
}

function isSafeAttributeValue(
  name: string,
  value: string,
  tagName: string,
  fontScale: number,
  userSpaceBudget: SvgUserSpaceBudget | null,
  declaresHeight: boolean,
): boolean {
  if (tagName === "svg" && name === "transform") {
    // 実測 0 件。`<svg transform="scale(…)">` は自分の中身ごと拡大するので予算の外側に立つ。
    return false;
  }
  if (userSpaceBudget !== null && (
    SVG_PATH_ATTRIBUTES.has(name)
    || SVG_SCALAR_GEOMETRY_ATTRIBUTES.has(name)
    || SVG_STROKE_ATTRIBUTES.has(name)
  )) {
    return isSafeSvgGeometryValue(name, value, userSpaceBudget);
  }
  if (tagName === "svg" && name === "width" && !declaresHeight) {
    // 高さ指定が無い svg の高さは `width` から導かれる。`width` に上限は無い (伸縮矢印の
    // `width="400em"` が実出力) ので、この場合だけ幅を高さと同じ物差しで測る。
    const magnitude = cssValueMagnitude(value.trim().toLowerCase(), PERCENT_IN_EM_VIEWPORT);
    return magnitude !== null && magnitude * fontScale <= SVG_HEIGHT_ATTRIBUTE_LIMIT;
  }
  if (tagName === "svg" && name === "height") {
    // `<svg>` の `width`/`height` はレイアウト上の箱そのもの。CSS を 1 文字も使わずに
    // `<svg width=9999 height=9999>` で不透明な面を描けるので、高さだけ上限を課す
    // (幅は MathLive の伸縮矢印が `width=400em` を実出力するため課せない — 帯にはなるが
    // 覆いにはならない)。
    const magnitude = cssValueMagnitude(value.trim().toLowerCase(), PERCENT_IN_EM_VIEWPORT);
    // 属性の `em` も要素自身の font-size で解かれるので、CSS 側と同じ累積倍率を掛ける。
    return magnitude !== null && magnitude * fontScale <= SVG_HEIGHT_ATTRIBUTE_LIMIT;
  }
  return true;
}

/** 許可外のクラストークンだけを落とす。1 つも残らなければ属性ごと落とす。 */
function sanitizeClassValue(value: string): string | null {
  if (!SAFE_CLASS_VALUE.test(value)) {
    return null;
  }
  const tokens = value.split(" ").filter((token) => token && isSafeClassToken(token));
  return tokens.length > 0 ? tokens.join(" ") : null;
}

function isSafeClassToken(token: string): boolean {
  return SAFE_CLASS_TOKENS.has(token) ||
    SAFE_CLASS_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

/**
 * `style` 属性の検査と、その要素以下へ引き継ぐ font-size 累積倍率の算出。
 *
 * `fontScale` は「この要素の `em` がルート em の何倍か」。要素自身の `font-size` は自分の
 * `width`/`height` にも効くので、まず自分の `font-size` を解いてから残りの宣言を判定する。
 */
function checkStyleAttribute(value: string, inheritedFontScale: number): {
  fontScale: number;
  safe: boolean;
} {
  if (value.length > STYLE_ATTRIBUTE_LENGTH_LIMIT) {
    return { fontScale: inheritedFontScale, safe: false };
  }
  const declarations = value.split(";");
  const fontScale = inheritedFontScale * ownFontScale(declarations, inheritedFontScale);
  return {
    fontScale,
    safe: declarations.every((declaration) => isSafeStyleDeclaration(declaration, {
      // `font-size` 自身は「親に対する倍率」なので祖先ぶんだけで測る (自分を二重に掛けない)。
      // それ以外の長さは、自分の `font-size` も効くので累積倍率で測る。
      effective: fontScale,
      inherited: inheritedFontScale,
    })),
  };
}

/**
 * 宣言列の `font-size` からこの要素自身の倍率を読む。読めない / 累積上限を超えるものは 1 を返す
 * — その `font-size` 宣言自体は `isSafeStyleDeclaration` が落とすので、実際の描画も倍率 1 になる。
 */
function ownFontScale(declarations: readonly string[], inheritedFontScale: number): number {
  let scale = 1;
  // **最後の** `font-size` が効く (カスケード)。先頭で return すると、囮の `font-size:1em` を
  // 前に置くだけで倍率の追跡を丸ごと欺ける。
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator <= 0 || declaration.slice(0, separator).trim().toLowerCase() !== "font-size") {
      continue;
    }
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    const magnitude = hasNumericToken(value)
      ? cssValueMagnitude(value, PERCENT_IN_EM_DEFAULT)
      : null;
    scale = magnitude === null || magnitude <= 0
      || inheritedFontScale * magnitude > CSS_FONT_SCALE_LIMIT
      ? 1
      : magnitude;
  }
  return scale;
}

/**
 * `font-size` は数値でしか受け付けない。`larger` / `xxx-large` は数値トークンが 0 個なので
 * 大きさが 0 と読め、判定を素通りしたうえで入れ子で実際に掛け算される。
 */
function hasNumericToken(value: string): boolean {
  return /\d/.test(value);
}

interface FontScales {
  effective: number;
  inherited: number;
}

function isSafeStyleDeclaration(declaration: string, fontScales: FontScales): boolean {
  const trimmed = declaration.trim();
  if (!trimmed) {
    // MathLive は `min-width:1.6em;` のように末尾セミコロンを付けることがある。
    return true;
  }
  if (CSS_CONTROL_CHARACTER.test(trimmed) ||
    CSS_ESCAPE_OR_DELIMITER.test(trimmed) ||
    CSS_UNSAFE_TOKEN.test(trimmed)) {
    return false;
  }

  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    return false;
  }
  const property = trimmed.slice(0, separator).trim().toLowerCase();
  const propertyValue = trimmed.slice(separator + 1).trim().toLowerCase();
  if (!MATH_MARKUP_ALLOWED_STYLE_PROPERTIES.has(property) || !propertyValue) {
    return false;
  }
  if (property === "position") {
    return SAFE_CSS_POSITION_VALUES.has(propertyValue);
  }
  if (property === "z-index") {
    // 実測は 0 / 1 / 2。負の値も含め、数式が重なり順を動かす理由が無い。
    const layer = Number(propertyValue);
    if (!Number.isInteger(layer) || layer < 0) {
      return false;
    }
  }

  const isLength = !CSS_UNSCALED_PROPERTIES.has(property);
  if (isLength && /(?<![\w-])var\s*\(/i.test(propertyValue)) {
    // `var()` の中身は静的に読めないので、数値トークンが 1 つも無い値として上限判定が
    // 空振りする (`--bg-color:19in` + `width:var(--bg-color)` で 1824px が通っていた)。
    return false;
  }

  const magnitude = cssValueMagnitude(propertyValue, percentInEm(property));
  if (magnitude === null) {
    return false;
  }
  if (property === "font-size") {
    return hasNumericToken(propertyValue)
      && magnitude > 0
      && magnitude * fontScales.inherited <= CSS_FONT_SCALE_LIMIT;
  }
  const limit = CSS_VALUE_MAGNITUDE_LIMITS[property] ?? CSS_DEFAULT_MAGNITUDE_LIMIT;
  return magnitude * (isLength ? fontScales.effective : 1) <= limit;
}

/**
 * 値に現れる数値の **ルート em 換算での最大絶対値**。読めなければ `null` (呼び出し元が宣言を落とす)。
 *
 * 1. 未知の関数が残っていれば `null` (許可リストは `calc` / `var` のみ)
 * 2. `calc(...)` (ベンダー別名込み) を実効値へ畳み込む
 * 3. 残った `<number><unit>` を単位ごとに em 換算し、その最大値を返す
 */
function percentInEm(property: string): number {
  return CSS_VIEWPORT_PERCENT_PROPERTIES.has(property)
    ? PERCENT_IN_EM_VIEWPORT
    : PERCENT_IN_EM_DEFAULT;
}

function cssValueMagnitude(value: string, percent: number): number | null {
  CSS_FUNCTION_TOKEN.lastIndex = 0;
  for (const call of value.matchAll(CSS_FUNCTION_TOKEN)) {
    if (!CSS_ALLOWED_FUNCTIONS.has(call[2].toLowerCase())) {
      return null;
    }
  }

  const folded = foldCssCalc(value, percent);
  if (folded === null) {
    return null;
  }

  let magnitude = 0;
  CSS_NUMBER_TOKEN.lastIndex = 0;
  for (const token of folded.matchAll(CSS_NUMBER_TOKEN)) {
    const unit = (token[2] ?? "").toLowerCase();
    const scale = unit === "%" ? percent : CSS_UNIT_IN_EM[unit];
    if (scale === undefined) {
      return null;
    }
    const scaled = Math.abs(Number(token[1]) * scale);
    if (!Number.isFinite(scaled)) {
      return null;
    }
    magnitude = Math.max(magnitude, scaled);
  }
  return magnitude;
}

/**
 * 値の中の `calc(...)` をすべて評価済みの数値へ置き換える。1 つでも評価できなければ `null`。
 * 置き換え後の文字列はそのまま `CSS_NUMBER_TOKEN` の走査に載る。
 */
function foldCssCalc(value: string, percent: number): string | null {
  let folded = "";
  let cursor = 0;
  for (;;) {
    CSS_CALC_FUNCTION.lastIndex = cursor;
    const call = CSS_CALC_FUNCTION.exec(value);
    if (!call) {
      return folded + value.slice(cursor);
    }
    // 開き括弧の位置は一致全体の末尾。`-webkit-calc(` のようなベンダー別名も同じ扱いにする
    // — Blink は `calc()` の完全な別名として評価するので、畳み込みを飛ばすと式が丸ごと
    // 未評価のまま上限判定に載る (実測: `-webkit-calc(99em * 99)` が 156816px を描いた)。
    const open = call.index + call[0].length - 1;
    const end = findMatchingParenthesis(value, open);
    if (end < 0) {
      return null;
    }
    const evaluated = evaluateCssCalc(value.slice(open + 1, end), percent);
    if (evaluated === null) {
      return null;
    }
    folded += `${value.slice(cursor, call.index)}${evaluated}`;
    cursor = end + 1;
  }
}

function findMatchingParenthesis(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === "(") {
      depth += 1;
    } else if (value[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

interface CssCalcScanner {
  index: number;
  percent: number;
  text: string;
}

/**
 * `calc()` の中身を `+ - * / ( )` と `<number><unit>` の再帰下降で評価する **total 関数**。
 *
 * 数値は **ルート em 換算** で採る (`2em` → 2、`5px` → 0.3125、`100%` → 1)。単位を読み捨てると
 * `calc(400em - 399px)` が 1 に見えて上限を素通りする (実効 6001px) ため、換算は必須。
 * 未知の単位・未知トークン・深さ超過・0 除算・非有限はすべて `null` を返し、呼び出し元が宣言を落とす。
 *
 * **決して throw しない**: `renderMathHtml` が throw すると React が描画中にツリーごと捨てて
 * 画面が真っ白になる (`math-html.ts` の不変条件、`"never throws"` テストが担保)。
 */
function evaluateCssCalc(body: string, percent: number): number | null {
  const scanner: CssCalcScanner = { index: 0, percent, text: body };
  const value = parseCssCalcSum(scanner, 0);
  if (value === null) {
    return null;
  }
  skipCssCalcSpace(scanner);
  return scanner.index === body.length && Number.isFinite(value) ? value : null;
}

function parseCssCalcSum(scanner: CssCalcScanner, depth: number): number | null {
  let left = parseCssCalcProduct(scanner, depth);
  if (left === null) {
    return null;
  }
  for (;;) {
    skipCssCalcSpace(scanner);
    const operator = scanner.text[scanner.index];
    if (operator !== "+" && operator !== "-") {
      return left;
    }
    scanner.index += 1;
    const right = parseCssCalcProduct(scanner, depth);
    if (right === null) {
      return null;
    }
    left = operator === "+" ? left + right : left - right;
  }
}

function parseCssCalcProduct(scanner: CssCalcScanner, depth: number): number | null {
  let left = parseCssCalcValue(scanner, depth);
  if (left === null) {
    return null;
  }
  for (;;) {
    skipCssCalcSpace(scanner);
    const operator = scanner.text[scanner.index];
    if (operator !== "*" && operator !== "/") {
      return left;
    }
    scanner.index += 1;
    const right = parseCssCalcValue(scanner, depth);
    if (right === null || (operator === "/" && right === 0)) {
      return null;
    }
    left = operator === "*" ? left * right : left / right;
  }
}

function parseCssCalcValue(scanner: CssCalcScanner, depth: number): number | null {
  if (depth > CSS_CALC_MAX_DEPTH) {
    return null;
  }
  skipCssCalcSpace(scanner);
  const rest = scanner.text.slice(scanner.index);
  const group = /^(?:-webkit-|-moz-)?calc\s*\(/i.exec(rest) ?? /^\(/.exec(rest);
  if (group) {
    scanner.index += group[0].length;
    const value = parseCssCalcSum(scanner, depth + 1);
    if (value === null) {
      return null;
    }
    skipCssCalcSpace(scanner);
    if (scanner.text[scanner.index] !== ")") {
      return null;
    }
    scanner.index += 1;
    return value;
  }
  const number = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
  if (!number) {
    return null;
  }
  scanner.index += number[0].length;
  const unit = /^(?:%|[a-z]+)/i.exec(scanner.text.slice(scanner.index));
  if (unit) {
    scanner.index += unit[0].length;
  }
  const unitName = (unit?.[0] ?? "").toLowerCase();
  const scale = unitName === "%" ? scanner.percent : CSS_UNIT_IN_EM[unitName];
  if (scale === undefined) {
    return null;
  }
  const parsed = Number(number[0]) * scale;
  return Number.isFinite(parsed) ? parsed : null;
}

function skipCssCalcSpace(scanner: CssCalcScanner): void {
  while (scanner.index < scanner.text.length && /\s/.test(scanner.text[scanner.index])) {
    scanner.index += 1;
  }
}

function escapeMathText(text: string): string {
  let escaped = "";
  let cursor = 0;
  PRESERVED_ENTITY_PATTERN.lastIndex = 0;
  for (const entity of text.matchAll(PRESERVED_ENTITY_PATTERN)) {
    escaped += escapeHtml(text.slice(cursor, entity.index));
    escaped += entity[0];
    cursor = entity.index + entity[0].length;
  }
  return escaped + escapeHtml(text.slice(cursor));
}
