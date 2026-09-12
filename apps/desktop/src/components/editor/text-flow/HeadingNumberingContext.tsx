"use client";

import { createContext, useContext, type ReactNode } from "react";

const HeadingNumberingContext = createContext<ReadonlyMap<string, string>>(new Map());

export function HeadingNumberingProvider({
  numbers,
  children,
}: {
  numbers: ReadonlyMap<string, string>;
  children: ReactNode;
}) {
  return <HeadingNumberingContext.Provider value={numbers}>{children}</HeadingNumberingContext.Provider>;
}

export function useHeadingNumber(blockId: string): string | undefined {
  return useContext(HeadingNumberingContext).get(blockId);
}
