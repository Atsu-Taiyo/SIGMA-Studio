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

  it("does not duplicate the injected stylesheet", () => {
    setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, []);
    setCustomHighlight(HELD_BODY_SELECTION_HIGHLIGHT_NAME, []);

    expect(document.querySelectorAll("#sigma-custom-highlight-styles")).toHaveLength(1);
  });
});
