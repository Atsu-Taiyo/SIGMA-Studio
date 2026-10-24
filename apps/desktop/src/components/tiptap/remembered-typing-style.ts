import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type TypingStyle = { fontFamily: string | null; fontSize: number | null };
// Editors belonging to one window share the last typed style. The document model
// remains authoritative for existing text; this only seeds an empty insertion point.
const preferences = new WeakMap<Document, TypingStyle>();

function styleAt(state: EditorState): TypingStyle {
  const mark = (state.storedMarks ?? state.selection.$from.marks()).find(mark => mark.type.name === "styledText");
  return { fontFamily: mark?.attrs.fontFamily ?? null, fontSize: mark?.attrs.fontSize ?? null };
}

function seed(view: EditorView) {
  const { state } = view;
  const { $from, empty } = state.selection;
  const type = state.schema.marks.styledText;
  const remembered = preferences.get(view.dom.ownerDocument);
  if (!remembered || !type || !empty || !$from.parent.isTextblock || !$from.parent.type.allowsMarkType(type) || $from.parent.content.size > 0) return;
  const marks = state.storedMarks ?? $from.marks();
  const current = marks.find(mark => mark.type === type);
  // A toolbar choice at this insertion point always wins over the remembered style.
  const attrs = { ...remembered, ...Object.fromEntries(Object.entries(current?.attrs ?? {}).filter(([, value]) => value !== null)) };
  const mark = type.create(attrs);
  if (current?.eq(mark)) return;
  view.dispatch(state.tr.setStoredMarks(mark.addToSet(marks)).setMeta("addToHistory", false));
}

export const RememberedTypingStyle = Extension.create({
  name: "rememberedTypingStyle",
  addProseMirrorPlugins() {
    let ownerDocument: Document | null = null;
    return [new Plugin({
      key: new PluginKey("rememberedTypingStyle"),
      state: {
        init: () => null,
        apply: (transaction, value, previous, next) => {
          if (!ownerDocument || transaction.getMeta("preventUpdate") || !next.selection.$from.parent.type.allowsMarkType(next.schema.marks.styledText)) return value;
          if (transaction.docChanged && next.selection.$from.parent.content.size > 0) {
            preferences.set(ownerDocument, styleAt(next));
          } else if (transaction.storedMarksSet && next.storedMarks && transaction.doc === previous.doc) {
            preferences.set(ownerDocument, styleAt(next));
          }
          return value;
        },
      },
      view: view => { ownerDocument = view.dom.ownerDocument; return {}; },
      appendTransaction: (transactions, _previous, next) => {
        if (!ownerDocument || transactions.some(transaction => transaction.getMeta("preventUpdate"))) return null;
        const remembered = preferences.get(ownerDocument);
        const type = next.schema.marks.styledText;
        const { $from, empty } = next.selection;
        if (!remembered || !type || !empty || !$from.parent.isTextblock || !$from.parent.type.allowsMarkType(type) || $from.parent.content.size > 0) return null;
        const marks = next.storedMarks ?? $from.marks();
        const current = marks.find(mark => mark.type === type);
        const attrs = { ...remembered, ...Object.fromEntries(Object.entries(current?.attrs ?? {}).filter(([, value]) => value !== null)) };
        const mark = type.create(attrs);
        if (current?.eq(mark)) return null;
        return next.tr.setStoredMarks(mark.addToSet(marks)).setMeta("addToHistory", false);
      },
      props: {
        handleDOMEvents: {
          beforeinput: view => { seed(view); return false; },
          focus: view => { seed(view); return false; },
        },
      },
    })];
  },
});
