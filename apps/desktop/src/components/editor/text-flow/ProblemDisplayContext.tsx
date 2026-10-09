"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ProblemDisplayFilter } from "@/features/rendering/core";

const ProblemDisplayContext = createContext<ProblemDisplayFilter | undefined>(undefined);

/**
 * 紙面に出している問題の領域 (設定 > 表示)。紙面に直に置いた問題はユニット分けが隠した領域を描かないが、
 * 箱の中の問題は箱の編集面が 4 つの領域をまとめて持つので、編集面がこれを読んで外した領域を畳む。
 * 絞っていなければ undefined。
 */
export function ProblemDisplayProvider({ display, children }: {
  display: ProblemDisplayFilter | undefined;
  children: ReactNode;
}) {
  return <ProblemDisplayContext.Provider value={display}>{children}</ProblemDisplayContext.Provider>;
}

export function useProblemDisplay(): ProblemDisplayFilter | undefined {
  return useContext(ProblemDisplayContext);
}
