import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  DOCUMENT_REFERENCE_CANDIDATES_EVENT, readDocumentReference, referenceAt, referenceAttributes,
  type DocumentReferenceCandidate, type ReferenceCandidatesRequest,
} from "@/lib/document-reference";
import { createTranslator, getAppLocale } from "@/lib/i18n";

export const DocumentReferenceMark = Mark.create({
  name: "documentReference",
  inclusive: false,
  addAttributes: () => ({ reference: {
    default: null,
    parseHTML: (element: HTMLElement) => referenceAt(element) ?? null,
    renderHTML: (attrs: Record<string, unknown>) => {
      const reference = readDocumentReference(attrs.reference);
      return reference ? referenceAttributes(reference) : {};
    },
  } }),
  parseHTML: () => [{ tag: "span[data-document-reference-id]", getAttrs: element => referenceAt(element) ? null : false }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "document-reference", role: "link", tabindex: "0" }), 0],
});

export function documentReferenceQuery(view: EditorView) {
  const { selection } = view.state;
  if (!selection.empty || !view.hasFocus() || view.composing) return null;
  const { $from, from } = selection;
  if (!$from.parent.isTextblock || !$from.parent.type.allowsMarkType(view.state.schema.marks.documentReference) || $from.marks().some(mark => mark.type.name === "documentReference")) return null;
  const prefix = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = /(^|[^A-Za-z0-9._%+-])[@＠]([^\s@＠]*)$/u.exec(prefix);
  return match ? { from: from - match[2].length - 1, to: from, query: match[2] } : null;
}

export const DocumentReferenceSuggestions = Extension.create({
  name: "documentReferenceSuggestions",
  addProseMirrorPlugins() {
    let popup: HTMLDivElement | null = null;
    let candidates: DocumentReferenceCandidate[] = [];
    let active = 0;
    let query: ReturnType<typeof documentReferenceQuery> = null;
    let dismissed = "";
    const hide = () => { popup?.remove(); popup = null; };
    const insert = (view: EditorView, candidate: DocumentReferenceCandidate) => {
      if (!query) return;
      const mark = view.state.schema.marks.documentReference.create({ reference: candidate.reference });
      const text = view.state.schema.text(`@${candidate.label}`, [mark]);
      view.dispatch(view.state.tr.replaceWith(query.from, query.to, [text, view.state.schema.text(" ")]).scrollIntoView());
      hide();
      view.focus();
    };
    const update = (view: EditorView) => {
      const next = documentReferenceQuery(view);
      const key = next ? `${next.from}:${next.to}:${next.query}` : "";
      if (!next) { dismissed = ""; query = null; hide(); return; }
      if (dismissed === key) { query = next; hide(); return; }
      dismissed = "";
      if (next.query !== query?.query) active = 0;
      query = next;
      const request: ReferenceCandidatesRequest = { candidates: [] };
      view.dom.dispatchEvent(new CustomEvent(DOCUMENT_REFERENCE_CANDIDATES_EVENT, { bubbles: true, detail: request }));
      const normalized = next.query.normalize("NFKC").toLocaleLowerCase();
      candidates = request.candidates.filter(item => item.label.normalize("NFKC").toLocaleLowerCase().includes(normalized)).slice(0, 12);
      hide();
      popup = view.dom.ownerDocument.createElement("div");
      popup.className = "document-reference-suggestions";
      popup.setAttribute("role", "listbox");
      const t = createTranslator(getAppLocale(), "editor");
      popup.setAttribute("aria-label", t("reference.choose"));
      active = Math.min(active, Math.max(0, candidates.length - 1));
      candidates.forEach((candidate, index) => {
        const button = view.dom.ownerDocument.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(active === index));
        const label = view.dom.ownerDocument.createElement("span");
        label.textContent = candidate.label;
        const kind = view.dom.ownerDocument.createElement("small");
        kind.textContent = t(candidate.reference.kind === "document" ? "reference.document" : "reference.material");
        button.append(label, kind);
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => insert(view, candidate));
        popup!.append(button);
      });
      if (!candidates.length) popup.textContent = t("reference.empty");
      view.dom.ownerDocument.body.append(popup);
      const point = view.coordsAtPos(next.to);
      const rect = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(point.left, window.innerWidth - rect.width - 8))}px`;
      popup.style.top = `${point.bottom + rect.height + 8 < window.innerHeight ? point.bottom + 4 : Math.max(8, point.top - rect.height - 4)}px`;
    };
    return [new Plugin({
      key: new PluginKey("documentReferenceSuggestions"),
      view: view => { update(view); return { update, destroy: hide }; },
      props: {
        handleKeyDown: (view, event) => {
          if (!popup || !query || event.isComposing) return false;
          if (event.key === "Escape") { dismissed = `${query.from}:${query.to}:${query.query}`; hide(); return true; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            active = (active + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, candidates.length)) % Math.max(1, candidates.length);
            update(view); return true;
          }
          if (event.key === "Enter" && candidates[active]) { insert(view, candidates[active]); return true; }
          return false;
        },
        handleDOMEvents: {
          blur: (_view, event) => { if (!popup?.contains(event.relatedTarget as Node)) hide(); return false; },
          focus: view => { update(view); return false; },
        },
      },
    })];
  },
});
