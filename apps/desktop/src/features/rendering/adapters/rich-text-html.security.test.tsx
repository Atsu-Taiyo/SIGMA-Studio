import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverlayTextBlocksView } from "@/components/editor/text-flow/OverlayTextBlocksView";
import type { OverlayTextBlock } from "@/features/document";

import { cssTextFromDeclarations } from "./boxed-inline-dom";

/**
 * The static renderers get their own defence, independent of the document normalization boundary.
 * This matters for reasons that are not symmetric with `overlay-snapshot.ts`:
 *
 * - Body (non-overlay) inline nodes never pass through overlay normalization at all — the schema
 *   keeps their `color` / `backgroundColor` / `fontFamily` as plain `z.string().optional()`, and
 *   Tiptap's `renderHTML` reaches the DOM through `cssTextFromDeclarations`.
 * - Composite declaration values (`1px solid <color>`) embed a document string inside a larger
 *   value, so a color-shaped check cannot see them.
 *
 * Every case below therefore feeds the serializer directly, with no normalization in front.
 */
const INJECTED =
  "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

function styledDocument(style: Record<string, string>): OverlayTextBlock[] {
  return [{
    type: "paragraph",
    id: "p_styled",
    children: [{ type: "text", text: "式", ...style }],
  }] as OverlayTextBlock[];
}

function renderBlocks(blocks: OverlayTextBlock[]): string {
  return renderToStaticMarkup(<OverlayTextBlocksView blocks={blocks} selfContained />);
}

/**
 * Every `style="..."` on an inline run, split into declarations (HTML entities decoded).
 *
 * Scoped to `<span>` on purpose: the block element carries the shape's own typography (alignment,
 * the self-contained margin reset), which is written by this codebase and not by the document.
 */
function styleDeclarations(html: string): string[] {
  return [...html.matchAll(/<span[^>]*style="([^"]*)"/g)]
    .flatMap((match) => match[1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&").split(";"))
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0);
}

describe("the static block renderer CSS injection defence", () => {
  it("drops an inline color that would append declarations", () => {
    const html = renderBlocks(styledDocument({ color: INJECTED }));

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("z-index");
    expect(styleDeclarations(html).filter((declaration) => declaration.startsWith("color:"))).toEqual([]);
  });

  it("drops an inline backgroundColor and fontFamily that would close the rule", () => {
    const html = renderBlocks(
      styledDocument({ backgroundColor: INJECTED, fontFamily: "serif;}html{display:none" }),
    );

    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("display:none");
    expect(styleDeclarations(html)).toEqual([]);
  });

  it("keeps the inline styling the settings UI produces", () => {
    const html = renderBlocks(styledDocument({
      color: "#1f2937",
      backgroundColor: "rgb(255, 255, 0)",
      fontFamily: "KaTeX_Main, \"M PLUS 1p\", serif",
    }));

    expect(styleDeclarations(html)).toEqual([
      "color:#1f2937",
      "background-color:rgb(255, 255, 0)",
      "font-family:KaTeX_Main, \"M PLUS 1p\", serif",
      "--sigma-math-text-font-family:KaTeX_Main, \"M PLUS 1p\", serif",
    ]);
  });
});

describe("Tiptap style attribute CSS injection", () => {
  it("drops a body inline color that would append declarations", () => {
    // Body inline nodes reach ProseMirror's `renderHTML` through this helper without ever
    // touching the overlay normalization boundary.
    expect(cssTextFromDeclarations({ color: INJECTED })).toBeUndefined();
    expect(cssTextFromDeclarations({ color: INJECTED, "font-size": "10.5pt" })).toBe("font-size: 10.5pt");
  });

  it("keeps the declarations the editor legitimately emits", () => {
    expect(cssTextFromDeclarations({
      color: "#1f2937",
      "background-color": "rgb(255, 255, 0)",
      "font-family": "KaTeX_Main, \"M PLUS 1p\", serif",
      "font-size": "10.5pt",
    })).toBe(
      "color: #1f2937; background-color: rgb(255, 255, 0); font-family: KaTeX_Main, \"M PLUS 1p\", serif; font-size: 10.5pt",
    );
  });

  it("keeps composite and calc() values whole", () => {
    expect(cssTextFromDeclarations({ "border-top": "1px solid #1f2937" })).toBe("border-top: 1px solid #1f2937");
    expect(cssTextFromDeclarations({ "line-height": "calc(1.78em + 6px)" })).toBe("line-height: calc(1.78em + 6px)");
  });
});
