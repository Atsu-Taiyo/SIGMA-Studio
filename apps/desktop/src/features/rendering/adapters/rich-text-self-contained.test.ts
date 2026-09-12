import type { CSSProperties } from "react";

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { RichTextBoxDecoration } from "@/features/rendering/core";

import {
  OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES,
  OVERLAY_TEXT_CONTENT_SELF_CONTAINED_STYLE,
  overlayTextBlockSelfContainedStyles,
} from "@/components/editor/text-flow/OverlayTextBlocksView";

import {
  boxedSelfContainedStyle,
  MATH_FRAME_SELF_CONTAINED_STYLE,
  underlineRunStyle,
  type RichTextDomStyle,
} from "./rich-text-dom";

/**
 * The exported SVG carries no stylesheet, so `rich-text-dom.ts` writes the document-surface
 * styling out as inline declarations. That output is *also* injected straight back into the app
 * (PrintPreview, running regions, the page canvas, the material preview), where inline styles beat
 * the stylesheet — so a value that drifts from the CSS does not merely look wrong in a standalone
 * file, it makes the SVG-rendered figure differ from the natively rendered one.
 *
 * A comment saying "keep these in sync" is exactly the failure mode this session is removing, so
 * the CSS is parsed here and compared declaration by declaration. Deliberate differences are
 * registered below with a reason and checked for staleness.
 */

const cssPath = path.resolve(import.meta.dirname, "../../../app/document-surface.css");
const documentSurfaceCss = readFileSync(cssPath, "utf8");

/**
 * Differences between a self-contained style and the CSS branch it mirrors. Every entry has to be
 * a real difference (see the staleness test) — an unexplained one is drift.
 */
const INTENTIONAL_DIVERGENCES: Record<string, string> = {};

/**
 * The boxed frame reads its custom properties with a fallback instead of re-declaring them.
 * Re-declaring `--boxed-text-border-width` inline would beat `[data-sigma-doc-boxed-variant=…]`
 * and freeze every box at the default frame. `.boxed-run-frame` uses the same form in the CSS.
 */
function applyCustomPropertyFallbacks(declarations: RichTextDomStyle): RichTextDomStyle {
  const defaults = ruleDeclarations(documentSurfaceCss, ".boxed-text");
  const withFallbacks: RichTextDomStyle = {};
  for (const [property, value] of Object.entries(declarations)) {
    if (property.startsWith("--")) {
      continue;
    }
    withFallbacks[property] = value.replace(/var\((--[a-z0-9-]+)\)/g, (match, name: string) => {
      const fallback = defaults[name];
      return fallback === undefined ? match : `var(${name}, ${fallback})`;
    });
  }
  return withFallbacks;
}

/** Every declaration the stylesheet applies to `selector`, in source order. */
function mergedRuleDeclarations(selector: string): RichTextDomStyle {
  const withoutComments = documentSurfaceCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const merged: RichTextDomStyle = {};
  let index = 0;
  while (index < withoutComments.length) {
    const open = withoutComments.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const close = findBlockEnd(withoutComments, open);
    const prelude = withoutComments.slice(index, open).trim();
    const selectors = prelude.split(",").map((entry) => entry.trim().replace(/\s+/g, " "));
    if (!prelude.startsWith("@") && selectors.includes(selector)) {
      Object.assign(merged, parseDeclarations(withoutComments.slice(open + 1, close)));
    }
    index = close + 1;
  }
  if (Object.keys(merged).length === 0) {
    throw new Error(`no rule for "${selector}"`);
  }
  return merged;
}

/** React inline styles as the CSS property names the stylesheet uses. */
function toCssDeclarations(style: Record<string, unknown> | CSSProperties | undefined): RichTextDomStyle {
  return Object.fromEntries(Object.entries((style ?? {}) as Record<string, unknown>).map(([property, value]) => [
    property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    String(value),
  ]));
}

/** Declarations of the top-level rule whose selector list contains `selector`, in source order. */
function ruleDeclarations(css: string, selector: string): RichTextDomStyle {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let index = 0;
  while (index < withoutComments.length) {
    const open = withoutComments.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const close = findBlockEnd(withoutComments, open);
    const prelude = withoutComments.slice(index, open).trim();
    const selectors = prelude.split(",").map((entry) => entry.trim().replace(/\s+/g, " "));
    if (!prelude.startsWith("@") && selectors.includes(selector)) {
      return parseDeclarations(withoutComments.slice(open + 1, close));
    }
    index = close + 1;
  }
  throw new Error(`no rule for "${selector}"`);
}

function findBlockEnd(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return css.length;
}

function parseDeclarations(body: string): RichTextDomStyle {
  const declarations: RichTextDomStyle = {};
  let depth = 0;
  let buffer = "";
  const flush = () => {
    const separator = buffer.indexOf(":");
    if (separator > 0) {
      const property = buffer.slice(0, separator).trim();
      const value = buffer.slice(separator + 1).trim().replace(/\s+/g, " ");
      if (property && !property.startsWith("/")) {
        declarations[property] = value;
      }
    }
    buffer = "";
  };
  for (const character of body) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === ";" && depth === 0) {
      flush();
      continue;
    }
    buffer += character;
  }
  flush();
  return declarations;
}

/** Merges CSS rules in source order, the way the cascade would for a single element. */
function mergedRules(css: string, ...selectors: string[]): RichTextDomStyle {
  return applyCustomPropertyFallbacks(
    selectors.reduce<RichTextDomStyle>(
      (merged, selector) => Object.assign(merged, ruleDeclarations(css, selector)),
      {},
    ),
  );
}

const boxed = (overrides: Partial<RichTextBoxDecoration> = {}): RichTextBoxDecoration => ({
  type: "box",
  math: false,
  ...overrides,
});

const runSegment = {
  connectLeft: false,
  connectRight: false,
  runId: "run",
  segmentCount: 1,
  segmentId: "segment",
  segmentIndex: 0,
  styleKey: "key",
};

describe("the self-contained boxed style mirrors document-surface.css", () => {
  it("matches .boxed-text for plain boxed text", () => {
    expect(boxedSelfContainedStyle(boxed()))
      .toEqual(mergedRules(documentSurfaceCss, ".boxed-text"));
  });

  it("matches .boxed-text.boxed-inline-math for boxed math", () => {
    expect(boxedSelfContainedStyle(boxed({ math: true })))
      .toEqual(mergedRules(
        documentSurfaceCss,
        ".boxed-text",
        ".boxed-text.boxed-inline-math",
      ));
  });

  // Every segment of a boxed run carries `data-boxed-run-height-target`, whose rule comes after
  // the math rule in the stylesheet. PR #223 moved this branch to a baseline anchor; an
  // `align-items: center` here would silently put SVG-rendered runs back on the old behaviour.
  it("matches the height-target rule for a boxed run segment", () => {
    expect(boxedSelfContainedStyle(boxed({ run: runSegment })))
      .toEqual(mergedRules(
        documentSurfaceCss,
        ".boxed-text",
        '.boxed-text[data-boxed-run-height-target="true"]',
      ));
  });

  it("lets the height-target rule win over the math rule, as source order does", () => {
    const style = boxedSelfContainedStyle(boxed({ math: true, run: runSegment }));

    expect(style).toEqual(mergedRules(
      documentSurfaceCss,
      ".boxed-text",
      ".boxed-text.boxed-inline-math",
      '.boxed-text[data-boxed-run-height-target="true"]',
    ));
    expect(style["align-items"]).toBe("baseline");
    expect(style["line-height"]).toBe("1");
  });

  it("matches the connect rules for a joined run", () => {
    expect(boxedSelfContainedStyle(boxed({ connectLeft: true, connectRight: true, run: runSegment })))
      .toEqual(mergedRules(
        documentSurfaceCss,
        ".boxed-text",
        '.boxed-text[data-boxed-run-height-target="true"]',
        '.boxed-text[data-boxed-run-connect-right="true"]',
        '.boxed-text[data-boxed-run-connect-left="true"]',
      ));
  });

  it("reads the boxed custom properties with a fallback so variants keep working", () => {
    const style = boxedSelfContainedStyle(boxed());

    expect(style.border).toContain("var(--boxed-text-border-width, 1px)");
    expect(Object.keys(style).some((property) => property.startsWith("--"))).toBe(false);
  });
});

describe("the self-contained underline mirrors document-surface.css", () => {
  it("matches the text-only branch", () => {
    expect(underlineRunStyle(false))
      .toEqual(mergedRules(documentSurfaceCss, ".sigma-underline-run:not(:has(.math-preview))"));
  });

  it("matches the has-math branch", () => {
    expect(underlineRunStyle(true))
      .toEqual(mergedRules(documentSurfaceCss, ".sigma-underline-run:has(.math-preview)"));
  });

  // `.sigma-underline-run:has(.math-preview) * { text-decoration: none }` has no self-contained
  // counterpart because the projection never puts a decoration on a descendant of such a run:
  // the run's wrapper span owns the underline, so no member carries one of its own.
  it("emits no decorated descendant that the has-math branch would have to neutralise", () => {
    const style = underlineRunStyle(true);

    expect(style["text-decoration"]).toBe("none");
    expect(ruleDeclarations(documentSurfaceCss, ".sigma-underline-run:has(.math-preview) *"))
      .toEqual({ "text-decoration": "none" });
  });
});

describe("the self-contained margins mirror the app rules", () => {
  it("zeroes the inline-math margin the way .overlay-text-shape .inline-math-node does", () => {
    // The overlay shape rules moved into the shared file when the running region started drawing
    // React shapes: `packages/viewer` loads only `document-surface.css`.
    expect(MATH_FRAME_SELF_CONTAINED_STYLE)
      .toEqual(ruleDeclarations(documentSurfaceCss, ".overlay-text-shape .inline-math-node"));
  });

  /**
   * A shape's block typography is now a real rule rather than an inline-only reset, so the export
   * and the app can be held to the same values instead of the export being allowed to differ.
   */
  it("matches the shape's block rules", () => {
    // Everything the stylesheet applies to that element, not just the first rule that names it:
    // the list geometry is deliberately a second rule on top of the shared margin reset.
    const paragraphRules = mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content p");
    const headingRules = mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content h1");
    const listRules = mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content ul");

    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.paragraph)).toEqual(paragraphRules);
    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.heading)).toEqual(headingRules);
    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.list)).toEqual(listRules);
  });

  /**
   * The three blocks a shape gained. A `blockquote`, a `pre` and an `hr` carry heavier UA defaults
   * than a paragraph does — a 40px indent, a monospace size of its own, an inset rule — so a shape
   * holding one would come out of the SVG export a different shape than the one on screen unless
   * every declaration travels with it.
   */
  it("carries the shape's quote, code and divider typography inline", () => {
    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.quote))
      .toEqual(mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content blockquote"));
    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.code))
      .toEqual(mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content pre"));
    expect(toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.divider))
      .toEqual(mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content hr"));
  });

  /**
   * The theme is a second rule keyed on an attribute, and an inline style beats it — so unless the
   * inline styles carry the choice too, a dark code block draws dark on the canvas and light in
   * print, in the material thumbnail and in the exported SVG.
   */
  it("carries the dark code theme inline as well as the light one", () => {
    const dark = overlayTextBlockSelfContainedStyles({
      type: "codeBlock",
      id: "code_dark",
      theme: "dark",
      children: [],
    });

    expect(toCssDeclarations(dark.code)).toEqual({
      ...toCssDeclarations(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.code),
      ...mergedRuleDeclarations('.overlay-text-shape .overlay-text-shape-content pre[data-code-theme="dark"]'),
    });
    // A light block keeps the shared map, so the two surfaces agree there too.
    expect(overlayTextBlockSelfContainedStyles({ type: "codeBlock", id: "code_light", children: [] }))
      .toBe(OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES);
  });

  it("matches the shape's content-box wrapping rules", () => {
    const contentRule = mergedRuleDeclarations(".overlay-text-shape .overlay-text-shape-content");

    expect(contentRule["overflow-wrap"]).toBe("anywhere");
    expect(contentRule["white-space"]).toBe("pre-wrap");
    expect(toCssDeclarations(OVERLAY_TEXT_CONTENT_SELF_CONTAINED_STYLE)).toEqual({
      "overflow-wrap": contentRule["overflow-wrap"],
      "white-space": contentRule["white-space"],
    });
  });

  it("keeps the divergence list free of stale entries", () => {
    expect(Object.keys(INTENTIONAL_DIVERGENCES)).toEqual([]);
  });
});
