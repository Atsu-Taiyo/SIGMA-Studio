"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { MathFractionSizing } from "@/features/document";
import {
  createMathRenderEnvironment,
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  type MathRenderEnvironment,
} from "@/lib/math-environment";

const MathEnvironmentContext = createContext<MathRenderEnvironment>(DEFAULT_MATH_RENDER_ENVIRONMENT);

/**
 * 文書の数式描画環境 (前文マクロ + 組版スタイル) を配る。数式を描く面はここか、React 外なら
 * 明示的に受け取った環境を使う — 既定へ勝手に落ちる経路を残さないのがこの Provider の役目。
 */
export function MathEnvironmentProvider({
  children,
  preamble,
}: {
  children: ReactNode;
  /** @deprecated Accepted for compatibility; ignored. */
  mathFractionSizing?: MathFractionSizing | null;
  preamble?: string;
}) {
  const value = useMemo(
    () => createMathRenderEnvironment(preamble),
    [preamble],
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

/** 旧 prop は互換性のため受け付けるだけで、数式の描画環境には影響しない。 */
export function useMathRenderEnvironment(
  _legacyFractionSizing?: MathFractionSizing | null,
): MathRenderEnvironment {
  void _legacyFractionSizing; // Keep the legacy call signature without changing context.
  return useMathEnvironment();
}
