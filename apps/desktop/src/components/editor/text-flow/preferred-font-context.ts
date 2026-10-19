"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { applyPreferredFontToEmptyParagraph } from "@/components/tiptap/preferred-font";

/** The host's last chosen font, independent of the font under the caret. */
export const PreferredFontContext = createContext<{
  fontFamily: string;
  getFontFamily: () => string;
  rememberFontFamily: (fontFamily: string) => void;
} | null>(null);

export function usePreferredFontSeed() {
  const preferredFont = useContext(PreferredFontContext);
  const preferredFontRef = useRef(preferredFont);
  useLayoutEffect(() => { preferredFontRef.current = preferredFont; }, [preferredFont]);
  const seedPreferredFont = useCallback((editor: Editor) => {
    applyPreferredFontToEmptyParagraph(editor, preferredFontRef.current?.getFontFamily());
  }, []);
  const rememberFontFamily = useCallback((fontFamily: string) => {
    preferredFontRef.current?.rememberFontFamily(fontFamily);
  }, []);
  return { preferredFont, seedPreferredFont, rememberFontFamily };
}
