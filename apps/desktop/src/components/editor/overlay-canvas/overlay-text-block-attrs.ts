import { Extension } from "@tiptap/core";

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
        },
      },
      {
        // `markerStyle` is the opposite case: it *must* reach the DOM. `document-surface.css`
        // selects the `(1)` counter style on `data-list-marker`, and the static renderer writes the
        // same attribute — without it here, focusing a shape would change its numbering, and the
        // style would be dropped from the schema and lost on the next save.
        types: ["orderedList"],
        attributes: {
          markerStyle: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-list-marker"),
            renderHTML: (attributes) => (
              attributes.markerStyle === "paren" ? { "data-list-marker": "paren" } : {}
            ),
          },
        },
      },
    ];
  },
});
