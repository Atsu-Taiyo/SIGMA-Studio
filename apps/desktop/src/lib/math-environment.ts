import type { MathFractionSizing } from "@/features/document";
import {
  DEFAULT_MATH_TYPESET_STYLE,
  resolveMathTypesetStyle,
  type MathTypesetStyle,
} from "@/features/rendering/core";
import { createMathMacroSet, DEFAULT_MATH_MACRO_SET, type MathMacroSet } from "@/lib/math-macros";

/**
 * TeX を描くのに要る**文書側の環境一式**。マクロ (前文 + Sigma 組み込み) と組版スタイルを
 * 1 つの値にまとめてある。
 *
 * 分けて持つと片方だけ渡し忘れる — 実際、静的描画にマクロが渡っていない経路と、組版スタイルが
 * 呼び出し側の省略で既定に落ちる経路がそれぞれ別のバグとして表面化した。描画 API はこの型を
 * **省略不可の引数**として受け取るので、環境の一部だけを落とすことは構造的にできない
 * (`architecture.test.ts` が省略可能化を禁じている)。
 */
export interface MathRenderEnvironment {
  macroSet: MathMacroSet;
  typesetStyle: MathTypesetStyle;
}

/** 文書コンテキストが無い面 (単体テスト・React 外の既定値) 用の環境。 */
export const DEFAULT_MATH_RENDER_ENVIRONMENT: MathRenderEnvironment = {
  macroSet: DEFAULT_MATH_MACRO_SET,
  typesetStyle: DEFAULT_MATH_TYPESET_STYLE,
};

/** `metadata.texPreamble` と `metadata.mathFractionSizing` から描画環境を作る。 */
export function createMathRenderEnvironment(
  preamble?: string,
  mathFractionSizing?: MathFractionSizing | null,
): MathRenderEnvironment {
  return {
    macroSet: createMathMacroSet(preamble),
    typesetStyle: resolveMathTypesetStyle(mathFractionSizing),
  };
}

/** 既存の環境の組版スタイルだけを差し替える (同じなら参照ごと使い回してメモ化を壊さない)。 */
export function withMathTypesetStyle(
  environment: MathRenderEnvironment,
  typesetStyle: MathTypesetStyle,
): MathRenderEnvironment {
  return environment.typesetStyle === typesetStyle ? environment : { ...environment, typesetStyle };
}

/**
 * 描画キャッシュのキー。打鍵ごとに文書中の全数式が引くので `JSON.stringify` は使わない
 * 区切りが `\u0000` なのは、マクロの signature が前文そのもの (任意のユーザー入力) で、
 * 可視文字区切りだと前文と TeX の境目が曖昧になるため。組版スタイルは閉じた列挙。
 */
export function mathRenderEnvironmentCacheKey(environment: MathRenderEnvironment, tex: string): string {
  return `${environment.typesetStyle}\u0000${environment.macroSet.signature}\u0000${tex}`;
}
