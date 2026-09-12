import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { cssTextFromDeclarations, INHERITED_TEXT_FONT_ATTRIBUTE, textBlockTypographyVars } from "@/features/rendering/adapters";
import { resolveTextBlockTypography, type TextBlockFontRun } from "@/features/rendering/core";
import { parseCssFontSizeToPt } from "@/lib/font-size-units";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

interface InlineFontRun extends TextBlockFontRun {
  from: number;
  to: number;
}

interface BlockTypography {
  style: string | undefined;
  inheritedRuns: InlineFontRun[];
}

// PM nodes are immutable. A keystroke only revisits the changed block's inline runs; moving a
// block, changing the selection, and repainting never re-scan its text or measure the DOM.
const blockTypographyCache = new WeakMap<ProseMirrorNode, BlockTypography>();

function blockTypography(node: ProseMirrorNode): BlockTypography {
  const cached = blockTypographyCache.get(node);
  if (cached) return cached;
  const runs: InlineFontRun[] = [];
  node.forEach((child, offset) => {
    if (!child.isText && child.type.name !== "mathInline") return;
    runs.push({
      from: offset + 1,
      to: offset + 1 + child.nodeSize,
      hasContent: child.type.name === "mathInline" || Boolean(child.text?.length),
      fontSizePt: parseCssFontSizeToPt(child.marks.find((mark) => mark.type.name === "styledText")?.attrs.fontSize),
    });
  });
  const typography = {
    style: cssTextFromDeclarations(textBlockTypographyVars(resolveTextBlockTypography(runs))),
    inheritedRuns: runs.filter((run) => run.fontSizePt === undefined),
  };
  blockTypographyCache.set(node, typography);
  return typography;
}

export function createTextBlockTypographyDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  countDecorationBlockWalk();
  doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      const typography = blockTypography(node);
      if (typography.style) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: typography.style }));
        for (const run of typography.inheritedRuns) {
          decorations.push(Decoration.inline(pos + run.from, pos + run.to, {
            nodeName: "span",
            [INHERITED_TEXT_FONT_ATTRIBUTE]: "",
          }));
        }
      }
    }
    return !node.isTextblock && !node.isLeaf;
  });
  return DecorationSet.create(doc, decorations);
}

const typographyPluginKey = new PluginKey<DecorationSet>("textBlockTypography");

export function createTextBlockTypographyPlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: typographyPluginKey,
    state: {
      init: (_config, state) => createTextBlockTypographyDecorations(state.doc),
      apply: (transaction, previous) => transaction.docChanged
        ? createTextBlockTypographyDecorations(transaction.doc)
        : previous,
    },
    props: {
      decorations: (state) => typographyPluginKey.getState(state) ?? DecorationSet.empty,
    },
  });
}
