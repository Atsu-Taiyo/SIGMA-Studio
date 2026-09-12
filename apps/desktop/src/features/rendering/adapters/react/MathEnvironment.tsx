"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { MathFractionSizing } from "@/features/document";
import { resolveMathTypesetStyle } from "@/features/rendering/core";
import {
  createMathRenderEnvironment,
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  withMathTypesetStyle,
  type MathRenderEnvironment,
} from "@/lib/math-environment";

const MathEnvironmentContext = createContext<MathRenderEnvironment>(DEFAULT_MATH_RENDER_ENVIRONMENT);

/**
 * 文書の数式描画環境 (前文マクロ + 組版スタイル) を配る。数式を描く面はここか、React 外なら
 * 明示的に受け取った環境を使う — 既定へ勝手に落ちる経路を残さないのがこの Provider の役目。
 */
export function MathEnvironmentProvider({
  children,
  mathFractionSizing,
  preamble,
}: {
  children: ReactNode;
  mathFractionSizing?: MathFractionSizing | null;
  preamble?: string;
}) {
  const value = useMemo(
    () => createMathRenderEnvironment(preamble, mathFractionSizing),
    [mathFractionSizing, preamble],
  );
  return <MathEnvironmentValueProvider environment={value}>{children}</MathEnvironmentValueProvider>;
}

/**
 * 既に組み立て済みの環境を配る低レベル版。React 外で環境を解決してから
 * `renderToStaticMarkup` する面 (SVG 書き出し) 用。
 */
export function MathEnvironmentValueProvider({
  children,
  environment,
}: {
  children: ReactNode;
  environment: MathRenderEnvironment;
}) {
  return <MathEnvironmentContext.Provider value={environment}>{children}</MathEnvironmentContext.Provider>;
}

export function useMathEnvironment(): MathRenderEnvironment {
  return useContext(MathEnvironmentContext);
}

/**
 * 組版設定を prop で受け取る面のための解決口。文書メタデータは prop でも context でも届くので、
 * **prop が明示されていればそれを、無ければ context を**使って 1 つの環境に畳む
 * (両方を別々に読むと、片方だけ差し替わったときに静的と編集中が食い違う)。
 */
export function useMathRenderEnvironment(
  mathFractionSizing?: MathFractionSizing | null,
): MathRenderEnvironment {
  const environment = useMathEnvironment();
  return useMemo(() => (
    mathFractionSizing === undefined || mathFractionSizing === null
      ? environment
      : withMathTypesetStyle(environment, resolveMathTypesetStyle(mathFractionSizing))
  ), [environment, mathFractionSizing]);
}
