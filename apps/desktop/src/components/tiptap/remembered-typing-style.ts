import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { readProblemFontFamily, resolveBoxFontContext } from "./text-format-controller";

type TypingStyle = { fontFamily: string | null; fontSize: number | null };
// Editors belonging to one window share the last typed style. The document model
// remains authoritative for existing text; this only seeds an empty insertion point.
const preferences = new WeakMap<Document, TypingStyle>();

function styleAt(state: EditorState): TypingStyle {
  const mark = (state.storedMarks ?? state.selection.$from.marks()).find(mark => mark.type.name === "styledText");
  return { fontFamily: mark?.attrs.fontFamily ?? null, fontSize: mark?.attrs.fontSize ?? null };
}

function seedTransaction(state: EditorState, remembered: TypingStyle | undefined, containerFontFamily?: () => string | undefined) {
  const { $from, empty } = state.selection;
  const type = state.schema.marks.styledText;
  if (!remembered || !type || !empty || !$from.parent.isTextblock || !$from.parent.type.allowsMarkType(type) || $from.parent.content.size > 0) return null;
  const marks = state.storedMarks ?? $from.marks();
  const current = marks.find(mark => mark.type === type);
  const frame = resolveBoxFontContext(state);
  const frameFont = (frame.inBoxTitle ? frame.titleFontFamily : frame.bodyFontFamily) ?? containerFontFamily?.();
  const frameSize = frame.inBoxTitle ? frame.titleFontSizePx : frame.bodyFontSizePx;
  // A toolbar choice at this insertion point always wins over the remembered style.
  // Frame typography is inherited; do not persist another editor's style over it.
  const attrs = { ...remembered, ...(frameFont ? { fontFamily: null } : {}), ...(frameSize ? { fontSize: null } : {}), ...Object.fromEntries(Object.entries(current?.attrs ?? {}).filter(([, value]) => value !== null)) };
  if (!current && Object.values(attrs).every(value => value === null)) return null;
  const mark = type.create(attrs);
  if (current?.eq(mark)) return null;
  return state.tr.setStoredMarks(mark.addToSet(marks)).setMeta("addToHistory", false);
}

function seed(view: EditorView) {
  const transaction = seedTransaction(view.state, preferences.get(view.dom.ownerDocument), () => readProblemFontFamily(view.dom));
  if (transaction) view.dispatch(transaction);
}

export const RememberedTypingStyle = Extension.create({
  name: "rememberedTypingStyle",
  addProseMirrorPlugins() {
    let ownerDocument: Document | null = null;
    let editorDom: Element | null = null;
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
      view: view => { ownerDocument = view.dom.ownerDocument; editorDom = view.dom; return {}; },
      appendTransaction: (transactions, _previous, next) => {
        if (!ownerDocument || transactions.some(transaction => transaction.getMeta("preventUpdate"))) return null;
        return seedTransaction(next, preferences.get(ownerDocument), () => readProblemFontFamily(editorDom));
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
