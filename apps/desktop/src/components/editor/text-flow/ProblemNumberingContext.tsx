"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

const ProblemNumberingContext = createContext<ReadonlyMap<string, number>>(new Map());

export function ProblemNumberingProvider({ numbers, children }: {
  numbers: ReadonlyMap<string, number>;
  children: ReactNode;
}) {
  // Body typing creates a new SigmaDoc, but must not refresh every text surface's numbering.
  const key = JSON.stringify([...numbers]);
  const value = useMemo(() => new Map(JSON.parse(key) as Array<[string, number]>), [key]);
  return <ProblemNumberingContext.Provider value={value}>{children}</ProblemNumberingContext.Provider>;
}

export function useProblemNumbers(): ReadonlyMap<string, number> {
  return useContext(ProblemNumberingContext);
}
