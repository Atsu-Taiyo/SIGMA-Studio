import type { MacroDictionary } from "mathlive";

/**
 * MathLive 標準のマクロ表 (`\iff` `\pmod` `\bra` `\ket` `\Bbb` …) を、静的描画へ引き継ぐための窓口。
 *
 * **`macros` を渡すと標準の表は置き換わる。** `convertLatexToMarkup(tex, { macros })` は渡された辞書で
 * 標準の表を丸ごと差し替える (`{}` を渡しても同じ。MathLive の `mf.macros` の説明にも
 * 「`...mf.macros` で既存を引き継がないと全マクロが置き換わる」とある)。静的描画は Sigma 組み込みと
 * 前文のマクロだけを渡していたので、標準マクロで書かれた `\iff` `\pmod` が「未定義」になり、
 * その式だけ別エンジンの KaTeX へ落ちていた。KaTeX は既定 CSS が 1.21em と MathLive より大きく、
 * 箱の高さも違うので、同じ文字サイズ指定でも数式ごとに大きさが変わって見えた。
 * 編集中の `math-field` は `{ ...mathField.macros, ...custom }` で引き継いでいる (`mathlive-config.ts`)
 * ので、編集中は MathLive・静的表示だけ KaTeX、という食い違いにもなっていた。
 *
 * 標準の表は MathLive の内部 (`getMacros`) にしか無く公開 API から取れない。取り出せるのは
 * マウント済みの `<math-field>` の `.macros` だけなので、画面外に 1 度だけ立てて読み、すぐ外す。
 * DOM が無い環境 (Node の単体テスト / SSR / Electron main の stub) では空の表を返し、
 * これまでどおり Sigma 組み込みと前文のマクロだけになる。
 */
export type MathLiveMacroDictionary = Readonly<MacroDictionary>;

const MATH_FIELD_TAG = "math-field";

interface MacroReadableField extends HTMLElement {
  macros?: MathLiveMacroDictionary;
}

// undefined = まだ読んでいない。DOM が無い間は読めていないので確定させない (後から DOM が生えたら読む)。
let defaultMacros: MathLiveMacroDictionary | undefined;
const mergedByCustomMacros = new WeakMap<MathLiveMacroDictionary, MathLiveMacroDictionary>();

function readFromMountedField(): MathLiveMacroDictionary {
  const FieldElement = globalThis.customElements?.get(MATH_FIELD_TAG);
  if (!FieldElement) {
    return {};
  }

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = "position:fixed;top:0;left:-9999px;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
  const field = new FieldElement() as MacroReadableField;
  host.append(field);
  document.body.append(host);
  try {
    // マウント前は throw する ("Mathfield not mounted")。読めなければ空へ倒し、描画は止めない。
    return { ...field.macros };
  } catch {
    return {};
  } finally {
    host.remove();
  }
}

/**
 * MathLive 標準のマクロ表。1 回読んだら使い回す。DOM がまだ無く読めないときは `null`
 * (確定させないので、DOM が生えた後の呼び出しで読み直す)。
 */
export function readMathLiveDefaultMacros(): MathLiveMacroDictionary | null {
  if (defaultMacros) {
    return defaultMacros;
  }
  if (typeof document === "undefined" || !document.body) {
    return null;
  }
  defaultMacros = readFromMountedField();
  return defaultMacros;
}

/**
 * 標準の表の上に、Sigma 組み込み / 前文のマクロを重ねる。同名は後者が勝つ (編集中の
 * `math-field` と同じ順序)。同じ辞書からは同じ結果の参照を返し、式ごとの組み直しを避ける。
 */
export function withMathLiveDefaultMacros(customMacros: MathLiveMacroDictionary): MathLiveMacroDictionary {
  const defaults = readMathLiveDefaultMacros();
  if (!defaults) {
    // DOM 前で標準の表が読めない。混ぜた結果を作らないので、結果のキャッシュもしない。
    return customMacros;
  }
  const cached = mergedByCustomMacros.get(customMacros);
  if (cached) {
    return cached;
  }
  const merged = { ...defaults, ...customMacros };
  mergedByCustomMacros.set(customMacros, merged);
  return merged;
}
