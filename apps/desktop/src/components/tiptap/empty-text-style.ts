import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** The attribute is a PM projection of an existing empty SigmaDoc text run, not a new save field. */
export const EmptyTextStyle = Extension.create({
  name: "emptyTextStyle",
  addGlobalAttributes() {
    return [{ types: ["paragraph", "heading"], attributes: {
      emptyTextStyle: { default: null, renderHTML: () => ({}), parseHTML: () => null },
    } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("emptyTextStyle"),
      appendTransaction(transactions, previous, next) {
        if (transactions.some(tr => tr.getMeta("preventUpdate") || isHistoryTransaction(tr))) return null;
        const { $from, empty } = next.selection;
        const node = $from.parent;
        const type = next.schema.marks.styledText;
        if (!empty || !["paragraph", "heading"].includes(node.type.name) || !type) return null;
        const explicit = transactions.some(tr => tr.storedMarksSet || tr.docChanged);
        if (node.content.size !== 0) return null;
        if (!explicit && node.attrs.emptyTextStyle && !next.storedMarks) {
          return next.tr.setStoredMarks([type.create(node.attrs.emptyTextStyle)]).setMeta("addToHistory", false);
        }
        if (!explicit) return null;
        // A selection-only move never rewrites a blank line. Enter and toolbar changes do.
        const mark = (next.storedMarks ?? $from.marks()).find(mark => mark.type === type);
        const style = mark && (mark.attrs.fontSize || mark.attrs.fontFamily) ? {
          ...(mark.attrs.fontSize ? { fontSize: mark.attrs.fontSize } : {}),
          ...(mark.attrs.fontFamily ? { fontFamily: mark.attrs.fontFamily } : {}),
        } : null;
        if (JSON.stringify(style) === JSON.stringify(node.attrs.emptyTextStyle)) return null;
        // Restoring a document or undo must preserve the stored run, not reuse a previous caret.
        if (transactions.every(tr => !tr.storedMarksSet) && previous.doc === next.doc) return null;
        return next.tr.setNodeAttribute($from.before(), "emptyTextStyle", style).setStoredMarks(next.storedMarks);
      },
    })];
  },
});
