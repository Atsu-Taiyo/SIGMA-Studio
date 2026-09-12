import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  cssTextFromDeclarations,
  LIST_MARKER_TYPOGRAPHY_ATTRIBUTE,
  listMarkerTypographyVars,
} from "@/features/rendering/adapters";
import {
  listMarkerRunHasGlyph,
  resolveListMarkerTypography,
  type ListMarkerRun,
} from "@/features/rendering/core";
import { parseCssFontSizeToPt } from "@/lib/font-size-units";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

const LIST_ITEM_NODE_NAME = "listItem";
const MATH_INLINE_NODE_NAME = "mathInline";
const STYLED_TEXT_MARK_NAME = "styledText";
const BOLD_MARK_NAME = "bold";
const ITALIC_MARK_NAME = "italic";

/**
 * The typography of the item's first run, projected onto the `li` for `::marker` to read.
 *
 * The editing surface and the static renderer disagree about where `data-sigma-doc-id` lives (the
 * inner `p` here, the `li` there), so this has to be a node decoration on the `listItem` itself:
 * anything emitted on the paragraph never reaches the marker.
 *
 * Nothing is written to the document. The values are derived from the runs that are already there,
 * which is why changing the first character's font updates the marker with no extra bookkeeping.
 */
export function createListMarkerTypographyDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  countDecorationBlockWalk();
  doc.descendants((node, pos) => {
    // A textblock or a leaf cannot contain a list item, and descending into inline content on
    // every document change is what made typing slow in this editor before.
    if (node.isTextblock || node.isLeaf) {
      return false;
    }
    if (node.type.name !== LIST_ITEM_NODE_NAME) {
      return true;
    }

    const style = cssTextFromDeclarations(
      listMarkerTypographyVars(resolveListMarkerTypography(listItemMarkerRuns(node))),
    );
    if (style) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, {
        [LIST_MARKER_TYPOGRAPHY_ATTRIBUTE]: "",
        // ProseMirror concatenates this onto the element's `cssText`, so it carries no trailing
        // semicolon and no newline — same shape as the column-flow layout decorations.
        style,
      }));
    }
    // Keep descending: a nested list inside this item has its own items to decorate.
    return true;
  });

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * The item's runs, stopping at the first one that draws something.
 *
 * `resolveListMarkerTypography` only looks at that run, so there is no reason to describe the rest
 * of the paragraph on every document change.
 */
function listItemMarkerRuns(item: ProseMirrorNode): ListMarkerRun[] {
  const paragraph = item.firstChild;
  if (!paragraph || !paragraph.isTextblock) {
    return [];
  }

  const runs: ListMarkerRun[] = [];
  for (let index = 0; index < paragraph.childCount; index += 1) {
    const run = markerRun(paragraph.child(index));
    if (!run) {
      continue;
    }
    runs.push(run);
    if (run.hasGlyph) {
      break;
    }
  }
  return runs;
}

/**
 * One inline node as a run description, or `undefined` for nodes that draw no glyph of their own.
 *
 * A `hardBreak` is skipped, and `listMarkerRunHasGlyph` drops the `\n` that the same break is
 * stored as on the SigmaDoc side — the two halves together are what make both surfaces pick the
 * same first run for an item that starts with a line break.
 */
function markerRun(node: ProseMirrorNode): ListMarkerRun | undefined {
  const isMath = node.type.name === MATH_INLINE_NODE_NAME;
  if (!isMath && !node.isText) {
    return undefined;
  }

  const styled = node.marks.find((mark) => mark.type.name === STYLED_TEXT_MARK_NAME);
  const fontFamily = styled?.attrs.fontFamily;
  const color = styled?.attrs.color;
  return {
    kind: isMath ? "math" : "text",
    hasGlyph: listMarkerRunHasGlyph(isMath ? String(node.attrs.tex ?? "") : node.text ?? ""),
    fontFamily: typeof fontFamily === "string" && fontFamily.length > 0 ? fontFamily : undefined,
    // `parseCssFontSizeToPt` is what the `styledText` mark's own `renderHTML` normalizes with, so
    // the marker and the run cannot disagree about what `24px` means.
    fontSizePt: parseCssFontSizeToPt(styled?.attrs.fontSize),
    color: typeof color === "string" && color.length > 0 ? color : undefined,
    // 太字・斜体は SigmaDoc では `marks` の値、編集面では別々の mark。どちらの経路も
    // `resolveListMarkerTypography` に同じ形で渡すことで、判断が 1 箇所に留まる。
    bold: node.marks.some((mark) => mark.type.name === BOLD_MARK_NAME),
    italic: node.marks.some((mark) => mark.type.name === ITALIC_MARK_NAME),
  };
}

const listMarkerTypographyPluginKey = new PluginKey<DecorationSet>("listMarkerTypography");

/**
 * Makes the editing surface draw list markers in the typography of the item's first run.
 *
 * Off by default in `createRichTextEngineExtensions`: only the body surface has a static twin that
 * draws lists, and enabling it where there is none would make the editing surface differ from what
 * is printed.
 */
export const ListMarkerTypographyExtension = Extension.create({
  name: "listMarkerTypography",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: listMarkerTypographyPluginKey,
        state: {
          init: (_config, state) => createListMarkerTypographyDecorations(state.doc),
          // `props.decorations` runs on every update, so the set is kept in plugin state and only
          // rebuilt when the document actually changed.
          apply: (transaction, previous) => (
            transaction.docChanged
              ? createListMarkerTypographyDecorations(transaction.doc)
              : previous
          ),
        },
        props: {
          decorations: (state) => listMarkerTypographyPluginKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
