/**
 * 絶対値の縦棒をベクトルに合わせて描く。**描画用の TeX だけ**を書き換え、保存する TeX は変えない。
 *
 * `\left|\vv{AB}\right|` の縦棒は、TeX も MathLive も数式の軸 (0.25em) を中心に上下対称に伸ばす。
 * 中身は矢印の分だけ上に高いので、縦棒はベースラインの下へも同じだけ垂れ、行が下へ広がる。
 * 教科書の |AB→| は、縦棒がふつうの | と同じ下端から矢印の上までなので、その形にそろえる。
 *
 * 対象は、ベクトル (`\vv` `\vec` `\overrightarrow` など) を含む 1 行の中身を囲む
 * `\left| … \right|` (`\vert` `\lvert`/`\rvert` の綴りも) だけ。分数・根号・総和・行列などの
 * 積み重なる中身、添字の中、コメントを含む式はこれまでどおり自動の大きさにする。
 *
 * 縦棒の決め方:
 * - 覆う範囲は [-max(中身の深さ, | の深さ), max(中身の高さ, | の高さ)]。下端はふつうの | にそろう。
 * - ふつうの | が中身の上端 (矢印の先) まで届くとき (`\vec{a}` など) は書き換えない。TeX の
 *   `\delimiterfactor` (90.1%) の決まりでは |a→| もふつうの | で足りるが、それでは矢印の先が縦棒から
 *   はみ出し、隣の |b→| と縦棒の高さもそろわない。
 * - 届かないときの大きさは `\big` `\Big` `\bigg` `\Bigg` のうち、90.1% で範囲を覆う最小のもの
 *   (|a→| も |AB→| も `\big`)。`\Bigg` でも足りないときは書き換えない。
 * - 字形の下端を範囲の下端まで持ち上げる。MathLive の `\raisebox` は持ち上げた分を深さに足して
 *   報告するので、字形は `\smash` し、実際の範囲は幅 0 の `\rule` が持つ。
 * 寸法は呼び出し側が渡す `measure` (静的描画と同じ MathLive の箱) で測る。
 */

export interface MathBoxEm {
  height: number;
  depth: number;
}

export type MeasureMathBox = (tex: string) => MathBoxEm | undefined;

/** TeX の `\delimiterfactor` = 901: 区切り記号は中身の 90.1% を覆えばよい。 */
const DELIMITER_FACTOR = 0.901;
/** MathLive が書く高さの刻み (0.01em) の半分。 */
const REACH_TOLERANCE = 0.005;
const SIZES = ["big", "Big", "bigg", "Bigg"] as const;
type Size = (typeof SIZES)[number];

const LEFT_BARS: ReadonlySet<string> = new Set(["|", "\\vert", "\\lvert"]);
const RIGHT_BARS: ReadonlySet<string> = new Set(["|", "\\vert", "\\rvert"]);
const VECTOR = /\\(?:vv|vec|overrightarrow|overleftarrow|overleftrightarrow)(?![A-Za-z])/;
/** 軸を中心に組む中身 (分数・根号・大型演算子・行列…) や、大きさを自分で決めた中身。 */
const STACKED = /\\(?:[dtc]?frac|genfrac|[dt]?binom|sqrt|root|begin|end|sum|prod|coprod|int|iint|iiint|oint|lim|limsup|liminf|max|min|sup|inf|overset|underset|stackrel|substack|overbrace|underbrace|left|right|middle|phantom|vphantom|smash|raisebox|rule|boxed|fbox|bbox|displaystyle|textstyle|scriptstyle|scriptscriptstyle|big|Big|bigg|Bigg)(?![A-Za-z])|\\\\|&/;
/** 引数を添字の大きさで組むコマンドと、その引数の数。 */
const REDUCED_ARGUMENTS: Readonly<Record<string, number>> = { tfrac: 2, tbinom: 2, overset: 1, underset: 1, stackrel: 1, substack: 1 };
const REDUCING_SWITCHES: ReadonlySet<string> = new Set(["scriptstyle", "scriptscriptstyle"]);

interface Open {
  start: number;
  end: number;
  delimiter: string;
  reduced: boolean;
  depth: number;
}

interface Pair {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

/** `\left` / `\right` の後ろの区切り記号 (空白を挟んでよい)。 */
function readDelimiter(tex: string, from: number): { delimiter: string; end: number } | null {
  let index = from;
  while (/\s/.test(tex[index] ?? "")) index += 1;
  const command = /^\\(?:[A-Za-z]+|.)/.exec(tex.slice(index));
  if (command) return { delimiter: command[0], end: index + command[0].length };
  return index < tex.length ? { delimiter: tex[index], end: index + 1 } : null;
}

function containsTexComment(tex: string): boolean {
  for (let index = 0; index < tex.length; index += 1) {
    if (tex[index] === "\\") index += 1;
    else if (tex[index] === "%") return true;
  }
  return false;
}

/** 添字の大きさで組まれない、ベクトルを含む 1 行の中身を囲む `\left| … \right|` の組。 */
function findVectorAbsolutePairs(tex: string): Pair[] {
  const pairs: Pair[] = [];
  const opens: Open[] = [];
  // 波括弧の入れ子ごとに、その中が添字の大きさか。
  const reduced: boolean[] = [false];
  let pendingReduced: { depth: number; count: number } | null = null;
  let previous = "";
  for (let index = 0; index < tex.length; index += 1) {
    const char = tex[index];
    if (char === "\\") {
      const command = /^\\([A-Za-z]+|.)/.exec(tex.slice(index));
      const name = command?.[1] ?? "";
      const tokenEnd = index + (command?.[0].length ?? 1);
      if (name === "left" || name === "right") {
        const read = readDelimiter(tex, tokenEnd);
        if (!read) return [];
        const depth = reduced.length - 1;
        if (name === "left") {
          opens.push({ start: index, end: read.end, delimiter: read.delimiter, reduced: reduced[depth], depth });
        } else {
          const open = opens.pop();
          if (!open) return [];
          const body = tex.slice(open.end, index);
          if (open.depth === depth && !open.reduced && LEFT_BARS.has(open.delimiter) && RIGHT_BARS.has(read.delimiter)
            && VECTOR.test(body) && !STACKED.test(body)) {
            pairs.push({ start: open.start, bodyStart: open.end, bodyEnd: index, end: read.end });
          }
        }
        index = read.end - 1;
        previous = "delimiter";
        continue;
      }
      if (REDUCING_SWITCHES.has(name)) reduced[reduced.length - 1] = true;
      if (name in REDUCED_ARGUMENTS) pendingReduced = { depth: reduced.length - 1, count: REDUCED_ARGUMENTS[name] };
      index = tokenEnd - 1;
      previous = "command";
      continue;
    }
    if (char === "{") {
      const depth = reduced.length - 1;
      const argument = pendingReduced !== null && pendingReduced.depth === depth && pendingReduced.count > 0;
      if (argument) pendingReduced!.count -= 1;
      reduced.push(reduced[depth] || previous === "^" || previous === "_" || argument);
    } else if (char === "}") {
      if (reduced.length === 1) return [];
      reduced.pop();
    }
    if (!/\s/.test(char)) previous = char;
  }
  return opens.length === 0 && reduced.length === 1 ? pairs : [];
}

const em = (value: number) => `${Number(value.toFixed(3))}em`;

/** 下端を `bottom` em だけベースラインの下に置いた、大きさ `size` の縦棒。 */
function seatedBar(size: Size, side: "l" | "r", glyph: MathBoxEm, bottom: number): string {
  const bar = `\\${size}${side}\\${side}vert`;
  const raise = glyph.depth - bottom;
  if (Math.abs(raise) < 0.005) return `\\math${side === "l" ? "open" : "close"}{${bar}}`;
  const total = glyph.height + glyph.depth;
  return `\\math${side === "l" ? "open" : "close"}{\\smash{\\raisebox{${em(raise)}}{$${bar}$}}\\rule[${em(-bottom)}]{0em}{${em(total)}}}`;
}

function seatPair(body: string, measure: MeasureMathBox): string | null {
  const content = measure(body);
  const normal = measure("\\lvert");
  if (!content || !normal) return null;
  const bottom = Math.max(content.depth, normal.depth);
  const top = Math.max(content.height, normal.height);
  // ふつうの | が矢印の先まで届き、下も足りる: 自動の大きさも同じ字形になる。書き換えない。
  if (content.height <= normal.height + REACH_TOLERANCE && content.depth <= normal.depth + REACH_TOLERANCE) return null;
  const span = top + bottom;
  for (const size of SIZES) {
    const left = measure(`\\${size}l\\lvert`);
    const right = measure(`\\${size}r\\rvert`);
    if (!left || !right) return null;
    if (left.height + left.depth >= DELIMITER_FACTOR * span - 1e-9) {
      // 波括弧で 1 つの塊にする: 後ろの `^2` は `\right|` と同じく式全体に付く。
      return `{${seatedBar(size, "l", left, bottom)}${body}${seatedBar(size, "r", right, bottom)}}`;
    }
  }
  return null; // `\Bigg` より高い中身は、自動の伸びる縦棒のまま。
}

/** ベクトルを囲む `\left| … \right|` を、ベースラインに座らせた縦棒に替えた描画用の TeX。 */
export function seatVectorAbsoluteBars(tex: string, measure: MeasureMathBox): string {
  if (!tex.includes("\\left") || !VECTOR.test(tex) || containsTexComment(tex)) return tex;
  let result = tex;
  for (const pair of findVectorAbsolutePairs(tex).sort((a, b) => b.start - a.start)) {
    const seated = seatPair(tex.slice(pair.bodyStart, pair.bodyEnd), measure);
    if (seated) result = `${result.slice(0, pair.start)}${seated}${result.slice(pair.end)}`;
  }
  return result;
}
