"use client";

import { useCallback, useEffect, useState } from "react";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopCustomFont } from "@/types/desktop";

export function useCustomFonts(): {
  customFonts: DesktopCustomFont[];
  reloadCustomFonts: () => void;
} {
  const [customFonts, setCustomFonts] = useState<DesktopCustomFont[]>([]);

  const reloadCustomFonts = useCallback(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.fonts) {
      return;
    }
    bridge.fonts.list()
      .then((result) => {
        if (result.ok) {
          setCustomFonts(result.fonts);
        }
      })
      .catch((error) => {
        console.warn("Failed to load custom fonts", error);
      });
  }, []);

  useEffect(() => {
    reloadCustomFonts();
  }, [reloadCustomFonts]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const styleId = "sigma-custom-font-faces";
    let styleElement = window.document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleElement) {
      styleElement = window.document.createElement("style");
      styleElement.id = styleId;
      window.document.head.appendChild(styleElement);
    }
    styleElement.textContent = customFonts.map((font) => (
      `@font-face{font-family:${font.cssFamily};src:url("${font.url}") format("${fontFormatForUrl(font.url)}");font-display:swap;}`
    )).join("\n");
  }, [customFonts]);

  return { customFonts, reloadCustomFonts };
}

function fontFormatForUrl(url: string): string {
  const pathname = url.split("?")[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".otf")) {
    return "opentype";
  }
  if (pathname.endsWith(".woff2")) {
    return "woff2";
  }
  if (pathname.endsWith(".woff")) {
    return "woff";
  }
  return "truetype";
}
