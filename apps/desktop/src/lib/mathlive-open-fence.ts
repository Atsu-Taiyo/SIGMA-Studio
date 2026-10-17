/**
 * 閉じ括弧を消した括弧 (`(x`) を、MathLive が `(x.` と書き出すのを直す。
 *
 * MathLive 0.111 は、打った `(` を括弧の原子 (leftright) にし、閉じ括弧を Backspace で消すと
 * その原子の右区切りを `"."` (区切りなし) にする。`\left(x\right.` 形ならこれは正しい TeX だが、
 * `(` 形の原子は右区切りをそのまま後ろへ付けるので `(x.` になる。入力欄には `(x` と出ているのに、
 * 保存される式・グラフへ渡る式には `.` が混ざり、読み直すと文字の `.` になって残る。
 *
 * MathLive の公開 API からは原子の構造が見えない。入力欄の中に括弧の原子を見つけたとき、その型の
 * 書き出しだけを包み、`(` 形で右区切りが `"."` のときに限って末尾の `.` を落とす。型は全入力欄で
 * 共通なので、包むのはページで 1 回。括弧が 1 つも無い入力欄では、そもそもこの書き出しは起きない。
 */

interface LeftRightAtomLike {
  variant?: string;
  rightDelim?: string;
}

type Serialize = (this: LeftRightAtomLike, options: unknown) => string;

const WRAPPED_MARKER = "__sigmaOpenFenceLatex";

/** 一度包めば、以降の読み出しで原子をたどらない (入力のたびに呼ばれる)。 */
let installed = false;

/** `\left…\right` 形と `\mleft…\mright` 形。右区切りの `.` は TeX として正しいので触らない。 */
const COMMAND_FENCE_VARIANTS: ReadonlySet<string> = new Set(["left...right", "mleft...mright"]);

/** 括弧の原子 1 つ分の書き出しから、`(` 形の「区切りなし」の右区切り `.` を落とす。 */
export function stripOpenFenceRightDelimiter(latex: string, atom: LeftRightAtomLike): string {
  if (atom.rightDelim !== "." || COMMAND_FENCE_VARIANTS.has(atom.variant ?? "")) {
    return latex;
  }
  return latex.endsWith(".") ? latex.slice(0, -1) : latex;
}

/**
 * 入力欄の中の括弧の原子から型を見つけ、その書き出しを `stripOpenFenceRightDelimiter` で包む。
 * 包めたか (すでに包まれていたか) を返す。MathLive の内部 (`_mathfield.model.atoms`) が変わって
 * 見つからないときは何もしない (MathLive のままの書き出しになる)。
 */
export function installMathLiveOpenFenceLatex(mathField: unknown): boolean {
  if (installed) {
    return true;
  }
  const atoms = (mathField as { _mathfield?: { model?: { atoms?: unknown } } } | null)?._mathfield?.model?.atoms;
  if (!Array.isArray(atoms)) {
    return false;
  }
  const fence: unknown = atoms.find((atom) => (atom as { type?: unknown } | null)?.type === "leftright");
  if (!fence) {
    return false;
  }
  const prototype = Object.getPrototypeOf(fence) as { _serialize?: Serialize } | null;
  const serialize = prototype?._serialize;
  if (!prototype || typeof serialize !== "function") {
    return false;
  }
  if ((serialize as unknown as Record<string, unknown>)[WRAPPED_MARKER]) {
    installed = true;
    return true;
  }
  const wrapped: Serialize = function serializeWithoutOpenFenceDelimiter(this: LeftRightAtomLike, options: unknown) {
    return stripOpenFenceRightDelimiter(serialize.call(this, options), this);
  };
  Object.defineProperty(wrapped, WRAPPED_MARKER, { value: true });
  prototype._serialize = wrapped;
  installed = true;
  return true;
}
