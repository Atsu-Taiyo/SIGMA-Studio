import { useMemo } from "react";
import type { OverlaySnapshot } from "@/features/document";
import { embeddedDocumentFontCss } from "@/features/rendering/core";

export function EmbeddedDocumentFonts({ snapshot }: { snapshot?: OverlaySnapshot }) {
  // Register reference faces synchronously. document.fonts.ready and PageCanvas's
  // loadingdone listener must include the application resource load too.
  const css = useMemo(() => embeddedDocumentFontCss(snapshot), [snapshot]);
  return css ? <style data-sigma-embedded-fonts>{css}</style> : null;
}
