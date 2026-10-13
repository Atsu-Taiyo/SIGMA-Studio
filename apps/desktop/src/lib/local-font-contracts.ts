import type { DesktopCustomFont } from "@/types/desktop";

export interface LocalFontFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}
export interface LocalFontCatalog {
  ok: boolean;
  systemFonts: LocalFontFace[];
  fonts: DesktopCustomFont[];
}
export interface LocalFontBridge {
  list(): Promise<LocalFontCatalog>;
}
export function getLocalFontBridge(): LocalFontBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sigmaLocalFonts?: LocalFontBridge }).sigmaLocalFonts ?? null;
}
