// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  HELD_BODY_SELECTION_HIGHLIGHT_NAME,
  setCustomHighlight,
  TEXT_RUN_SPAN_HIGHLIGHT_NAME,
} from "./custom-highlight";

describe("setCustomHighlight", () => {
  afterEach(() => {
    document.getElementById("sigma-custom-highlight-styles")?.remove();
  });

  it("injects ::highlight styles that LightningCSS would drop from globals.css", () => {
    setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, []);

    const style = document.getElementById("sigma-custom-highlight-styles");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(`::highlight(${TEXT_RUN_SPAN_HIGHLIGHT_NAME})`);
    expect(style?.textContent).toContain(`::highlight(${HELD_BODY_SELECTION_HIGHLIGHT_NAME})`);
    expect(style?.textContent).toContain("var(--editor-selection-background)");
  });

  it("leaves formulas to the atom's own background instead of painting each glyph", () => {
    // Range は数式の中の KaTeX の文字も含む。Highlight がそれも塗ると、選択した数式の背景
    // (`.inline-math-node.text-selected`) の上に記号ごとの四角が濃く重なり、2 色に見えた。
    setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, []);

    const css = document.getElementById("sigma-custom-highlight-styles")?.textContent ?? "";
    for (const name of [TEXT_RUN_SPAN_HIGHLIGHT_NAME, HELD_BODY_SELECTION_HIGHLIGHT_NAME]) {
      expect(css).toContain(`.inline-math-node ::highlight(${name})`);
    }
    expect(css).toMatch(/\.inline-math-node ::highlight\([^)]+\)[^{]*\{\s*background-color: transparent;/);
  });

  it("does not duplicate the injected stylesheet", () => {
    setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, []);
    setCustomHighlight(HELD_BODY_SELECTION_HIGHLIGHT_NAME, []);

    expect(document.querySelectorAll("#sigma-custom-highlight-styles")).toHaveLength(1);
  });
});
