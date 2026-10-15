import type { DesktopCustomFont } from "@/types/desktop";

export interface LocalFontFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}
export interface LocalFontCatalog {
  ok: boolean;
  /** このPCの書体の名前の一覧。読めないとき (非対応・失敗) は null で、書体メニューは固定のままにする。 */
  systemFonts: LocalFontFace[] | null;
  fonts: DesktopCustomFont[];
}
export interface LocalFontBridge {
  list(): Promise<LocalFontCatalog>;
}
export function getLocalFontBridge(): LocalFontBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sigmaLocalFonts?: LocalFontBridge }).sigmaLocalFonts ?? null;
}
