import { Extension } from "@tiptap/core";

import {
  BLOCK_SPACE_AFTER_ATTRIBUTE,
  LIST_INDENT_ATTRIBUTE,
  LIST_ITEM_LEADING_SPACE_AFTER_ATTRIBUTE,
  LIST_ITEM_SPACE_AFTER_ATTRIBUTE,
  ORDERED_LIST_MARKER_STYLE_ATTRIBUTE,
} from "@/components/tiptap/block-space-after-attributes";

/**
 * The block attributes a shape's editing surface has to carry, and where each of them belongs.
 *
 * A shape's blocks are the body's blocks, so the converters keyed on `sigmaDocId`
 * (`overlay-tiptap-adapter.ts`) need the attribute to survive a round trip through the editor —
 * without it every keystroke would hand each block a new id, and everything keyed on that id
 * (React subtrees, comment anchors, the boxed-run measurement map) would be rebuilt each time.
 *
 * The difference from the body's own `SigmaDocTextAttrs` is the whole point of this extension:
 * there, `renderHTML` writes `id` and `data-sigma-doc-id` onto the element. Here it must not.
 * That attribute is how the page surface finds a *body* block — `MEASURABLE_BLOCK_SELECTOR` for
 * anchor candidates and pagination measurement, and the page-window index — and a paragraph drawn
 * inside a figure is not one. The static twin omits it for the same reason (`omitBlockIds`), so
 * the editing and display surfaces agree on that too.
 *
 * `spaceAfterPx` (the space under a block) is the other attribute that has to ride along: the
 * converters keep it per block, so an editor that dropped it would erase the spacing the author
 * set the first time the shape is typed in. Unlike the id it *does* reach the DOM, as the same
 * inline custom property the static twin writes — `document-surface.css` turns it into padding for
 * both. The definitions are the body's (`block-space-after-attributes.ts`), not a copy.
 */
export const OverlayTextBlockAttrs = Extension.create({
  name: "overlayTextBlockAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList"],
        attributes: {
          sigmaDocId: {
            default: null,
            // No `parseHTML`/`renderHTML`: the id lives in the ProseMirror document only. Pasted
            // HTML carries no shape block ids, and the adapter mints one for anything without.
            renderHTML: () => ({}),
          },
          sigmaDocType: {
            default: null,
            renderHTML: () => ({}),
          },
          spaceAfterPx: BLOCK_SPACE_AFTER_ATTRIBUTE,
        },
      },
      {
        // A list item keeps its space on the leading paragraph (it owns the item id) and draws it
        // through the `li`'s own variable — the same split the body uses, so a copied item and a
        // reloaded one agree.
        types: ["listItem"],
        attributes: {
          spaceAfterPx: LIST_ITEM_SPACE_AFTER_ATTRIBUTE,
        },
      },
      {
        types: ["paragraph", "heading"],
        attributes: {
          listItemSpaceAfterPx: LIST_ITEM_LEADING_SPACE_AFTER_ATTRIBUTE,
        },
      },
      {
        // `markerStyle` is the opposite case: it *must* reach the DOM. `document-surface.css`
        // selects the `(1)` counter style on `data-list-marker`, and the static renderer writes the
        // same attribute — without it here, focusing a shape would change its numbering, and the
        // style would be dropped from the schema and lost on the next save.
        types: ["orderedList"],
        attributes: {
          markerStyle: ORDERED_LIST_MARKER_STYLE_ATTRIBUTE,
        },
      },
      {
        types: ["bulletList", "orderedList"],
        attributes: {
          indentEm: LIST_INDENT_ATTRIBUTE,
        },
      },
    ];
  },
});
