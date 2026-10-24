"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getExtensionBridge } from "@/lib/extension-contracts";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopCustomFont } from "@/types/desktop";
import { getLocalFontBridge, type LocalFontFace } from "@/lib/local-font-contracts";
import { getBrowserLocalFonts, type BrowserFontAccess } from "@/lib/browser-local-fonts";

export function useCustomFonts(): {
  customFonts: DesktopCustomFont[];
  systemFonts: LocalFontFace[] | null;
  reloadCustomFonts: () => void;
  browserFontAccess: BrowserFontAccess | null;
  requestSystemFonts: () => void;
} {
  const [customFonts, setCustomFonts] = useState<DesktopCustomFont[]>([]);
  const [systemFonts, setSystemFonts] = useState<LocalFontFace[] | null>(null);
  const [browserFontAccess, setBrowserFontAccess] = useState<BrowserFontAccess | null>(null);

  const loadRevision = useRef(0);
  const reloadCustomFonts = useCallback(() => {
    const revision = ++loadRevision.current;
    const local = getLocalFontBridge();
    if (local) {
      void local.list().then(result => {
        if (revision === loadRevision.current && result.ok) { setCustomFonts(result.fonts); setSystemFonts(result.systemFonts); }
      }).catch(error => console.warn("Failed to load local fonts", error));
      return;
    }
    const bridge = getDesktopBridge();
    if (!bridge?.fonts) {
      if (!bridge) void getBrowserLocalFonts().refresh();
      return;
    }
    bridge.fonts.list()
      .then((result) => {
        if (revision === loadRevision.current && result.ok) {
          setCustomFonts(result.fonts);
        }
      })
      .catch((error) => {
        console.warn("Failed to load custom fonts", error);
      });
  }, []);

  useEffect(() => {
    if (getLocalFontBridge() || getDesktopBridge()) return;
    const fonts = getBrowserLocalFonts();
    const update = () => {
      const catalog = fonts.getSnapshot();
      setSystemFonts(catalog.systemFonts);
      setBrowserFontAccess(catalog.status);
    };
    const unsubscribe = fonts.subscribe(update);
    update();
    return unsubscribe;
  }, []);

  const requestSystemFonts = useCallback(() => {
    if (!getLocalFontBridge() && !getDesktopBridge()) void getBrowserLocalFonts().request();
  }, []);

  useEffect(() => {
    reloadCustomFonts();
    const unsubscribe = getExtensionBridge()?.onMenuChange(() => reloadCustomFonts());
    window.addEventListener("focus", reloadCustomFonts);
    return () => {
      loadRevision.current += 1;
      unsubscribe?.();
      window.removeEventListener("focus", reloadCustomFonts);
    };
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

  return { customFonts, systemFonts, reloadCustomFonts, browserFontAccess, requestSystemFonts };
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
