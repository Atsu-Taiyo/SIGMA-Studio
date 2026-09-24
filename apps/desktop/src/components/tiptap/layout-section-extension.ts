import { createColumnRuleStyle } from "@/features/rendering/adapters";
import { normalizeColumnRule } from "@/features/document";
import { Node as TiptapNodeExtension } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { normalizeLayoutSectionColumnCount, normalizeNonnegativeNumber, getLayoutSectionColumnWidths } from "@/features/text-editing";
import { createTranslator, getAppLocale } from "@/lib/i18n";
import { createIndependentColumnLayout } from "@/features/rendering/core";
import { attachLayoutColumnResizeHandle } from "@/components/editor/layout-column-resize";
import { textFlowBlockToTiptapNode, tiptapToTextFlow } from "@/components/editor/text-flow/tiptap-document-adapter";

const childContent = "(paragraph | heading | bulletList | orderedList | quote | codeBlock | divider | boxBlock)+";

/** A derived editing boundary, never a persisted SigmaDoc node. */
const LayoutColumnExtension = TiptapNodeExtension.create({
  name: "layoutColumn",
  content: childContent,
  defining: true,
  isolating: true,
  addAttributes() {
    return { index: { default: 0, parseHTML: element => Number(element.getAttribute("data-layout-column-index") ?? 0) } };
  },
  parseHTML() { return [{ tag: "div.layout-section-independent-column" }]; },
  renderHTML({ node }) {
    return ["div", {
      class: "layout-section-independent-column",
      "data-layout-column-index": String(node.attrs.index),
    }, 0];
  },
});

function columnWidths(node: ProseMirrorNode): number[] {
  return getLayoutSectionColumnWidths({
    type: "layoutSection", id: node.attrs.sigmaDocId,
    layout: { columnCount: node.attrs.columnCount, columnWidths: node.attrs.columnWidths }, children: [],
  }, normalizeLayoutSectionColumnCount(node.attrs.columnCount));
}

const resizeKey = new PluginKey("nestedLayoutColumnResize");
const resizeDetachByHandle = new WeakMap<Node, () => void>();
const initializeColumns = "initializeIndependentColumns";

export const LayoutSectionExtension = TiptapNodeExtension.create({
  name: "layoutSection",
  group: "block",
  // The flat alternative accepts old clipboard slices; new projections always carry columns.
  content: `(layoutColumn+ | ${childContent})`,
  defining: true,
  isolating: true,
  addExtensions() { return [LayoutColumnExtension]; },
  onCreate() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta(initializeColumns, true));
  },
  addAttributes() {
    return {
      sigmaDocId: { default: null, parseHTML: element => element.getAttribute("data-sigma-doc-id") },
      sigmaDocType: { default: "layoutSection" },
      columnCount: { default: 2, parseHTML: element => Number.parseInt(element.getAttribute("data-column-count") ?? "2", 10) },
      columnGapMm: { default: 8, parseHTML: element => Number.parseFloat(element.getAttribute("data-column-gap-mm") ?? "8") },
      columnRule: {
        default: null,
        parseHTML: element => { try { return normalizeColumnRule(JSON.parse(element.getAttribute("data-column-rule") ?? "null")); } catch { return null; } },
      },
      columnStartIds: {
        default: null,
        parseHTML: element => { try { return JSON.parse(element.getAttribute("data-column-start-ids") ?? "null"); } catch { return null; } },
      },
      columnWidths: {
        default: null,
        parseHTML: element => { try { return JSON.parse(element.getAttribute("data-column-widths") ?? "null"); } catch { return null; } },
      },
    };
  },
  parseHTML() { return [{ tag: "section[data-sigma-doc-type='layoutSection']" }]; },
  renderHTML({ node }) {
    const count = normalizeLayoutSectionColumnCount(node.attrs.columnCount);
    const gap = normalizeNonnegativeNumber(node.attrs.columnGapMm) ?? 8;
    const presentation = createIndependentColumnLayout(columnWidths(node), `${gap}mm`);
    const rule = normalizeColumnRule(node.attrs.columnRule);
    return ["section", {
      "data-sigma-doc-id": node.attrs.sigmaDocId,
      "data-sigma-doc-type": "layoutSection",
      "data-layout-section-id": node.attrs.sigmaDocId,
      "data-column-count": String(count),
      "data-column-gap-mm": String(gap),
      "data-column-rule": node.attrs.columnRule ? JSON.stringify(node.attrs.columnRule) : undefined,
      "data-column-start-ids": Array.isArray(node.attrs.columnStartIds) ? JSON.stringify(node.attrs.columnStartIds) : undefined,
      "data-column-widths": Array.isArray(node.attrs.columnWidths) ? JSON.stringify(node.attrs.columnWidths) : undefined,
      class: "sigma-doc-layout-section-block",
      style: Object.entries(createColumnRuleStyle(rule)).map(([key, value]) => `${key}:${value}`).join(";"),
    }, ["div", {
      class: "sigma-doc-layout-section-body layout-section-independent-columns",
      style: `column-gap:${presentation.columnGap};grid-template-columns:${presentation.gridTemplateColumns}`,
    }, 0], ...(rule && rule.style !== "none" ? presentation.dividers.map(divider => ["span", {
      class: "column-rule-separator", "aria-hidden": "true", contenteditable: "false", style: `left:${divider.left}`,
    }] as [string, Record<string, string>]) : [])];
  },
  addNodeView() {
    return ({ node }) => {
      const render = (current: ProseMirrorNode) => DOMSerializer.renderSpec(document, current.type.spec.toDOM!(current));
      const rendered = render(node);
      // This extension's toDOM always returns a section containing the grid.
      const dom = rendered.dom as HTMLElement;
      const contentDOM = rendered.contentDOM;
      let ownedAttributes = [...dom.attributes].map(attribute => attribute.name);
      return {
        dom,
        contentDOM,
        update: next => {
          if (next.type !== node.type) return false;
          if (next.attrs !== node.attrs) {
            const rendered = render(next);
            if (dom instanceof HTMLElement && rendered.dom instanceof HTMLElement) {
              for (const name of ownedAttributes) if (!rendered.dom.hasAttribute(name)) dom.removeAttribute(name);
              for (const attribute of [...rendered.dom.attributes]) dom.setAttribute(attribute.name, attribute.value);
              ownedAttributes = [...rendered.dom.attributes].map(attribute => attribute.name);
              dom.querySelectorAll(":scope > .column-rule-separator").forEach(line => line.remove());
              rendered.dom.querySelectorAll(":scope > .column-rule-separator").forEach(line => dom.appendChild(line));
            }
            if (contentDOM instanceof HTMLElement && rendered.contentDOM instanceof HTMLElement) {
              contentDOM.style.cssText = rendered.contentDOM.style.cssText;
            }
          }
          node = next;
          return true;
        },
        // Divider previews are derived view state. Letting PM reparse a transient grid
        // style cancels pointer capture and can write the preview back as document content.
        ignoreMutation: mutation => (
          mutation.type === "attributes" && (mutation.target === contentDOM || mutation.target === dom)
        ) || (
          mutation.type === "childList" && mutation.target === dom
          && [...mutation.addedNodes, ...mutation.removedNodes].every(child => child instanceof HTMLElement && child.classList.contains("column-rule-separator"))
        ),
      };
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: resizeKey,
      appendTransaction: (transactions, _oldState, state) => {
        if (!transactions.some(transaction => transaction.docChanged || transaction.getMeta(initializeColumns))) return null;
        const replacements: { pos: number; node: ProseMirrorNode }[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "layoutSection" || node.firstChild?.type.name === "layoutColumn") return true;
          replacements.push({ pos, node });
          return false;
        });
        if (replacements.length === 0) return null;
        const tr = state.tr;
        for (const { node, pos } of replacements.reverse()) {
          const [section] = tiptapToTextFlow({ type: "doc", content: [node.toJSON()] });
          tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodeFromJSON(textFlowBlockToTiptapNode(section)));
        }
        return tr;
      },
      props: {
        decorations: state => {
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "layoutSection" || node.firstChild?.type.name !== "layoutColumn") return true;
            const widths = columnWidths(node);
            const presentation = createIndependentColumnLayout(widths, `${normalizeNonnegativeNumber(node.attrs.columnGapMm) ?? 8}mm`);
            let offset = pos + 1;
            node.forEach((column, _offset, index) => {
              offset += column.nodeSize;
              if (index >= node.childCount - 1) return;
              decorations.push(Decoration.widget(offset, (view, getPos) => {
                const t = createTranslator(getAppLocale(), "editor");
                const handle = document.createElement("button");
                handle.type = "button";
                handle.contentEditable = "false";
                handle.className = "layout-section-column-resize-handle";
                handle.dataset.layoutSectionId = node.attrs.sigmaDocId;
                handle.dataset.dividerIndex = String(index);
                handle.style.left = presentation.dividers[index].left;
                handle.style.setProperty("--layout-column-divider-gap", presentation.columnGap);
                handle.setAttribute("aria-label", t("pageCanvas.resizeColumns", {
                  replace: { left: index + 1, right: index + 2 },
                }));
                handle.title = t("pageCanvas.resizeColumnsHint");
                const commit = (leftWidth: number, rightWidth: number) => {
                  const position = getPos();
                  if (position === undefined) return;
                  const $pos = view.state.doc.resolve(position);
                  const section = $pos.parent;
                  if (section.type.name !== "layoutSection" || index + 1 >= section.childCount) return;
                  const currentWidths = columnWidths(section);
                  const pairTotal = currentWidths[index] + currentWidths[index + 1];
                  const tr = view.state.tr;
                  if (leftWidth <= 0 || rightWidth <= 0) {
                    const columns: ProseMirrorNode[] = [];
                    section.forEach(child => columns.push(child));
                    columns.splice(index, 2, columns[index].copy(columns[index].content.append(columns[index + 1].content)));
                    currentWidths.splice(index, 2, pairTotal);
                    if (columns.length === 1) {
                      tr.replaceWith($pos.before(), $pos.after(), columns[0].content);
                    } else {
                      const updated = section.type.create({
                        ...section.attrs, columnCount: columns.length, columnWidths: currentWidths,
                        columnStartIds: columns.map(column => column.firstChild?.attrs.sigmaDocId),
                      }, Fragment.from(columns.map((column, columnIndex) => column.type.create({ ...column.attrs, index: columnIndex }, column.content))));
                      tr.replaceWith($pos.before(), $pos.after(), updated);
                    }
                  } else {
                    currentWidths[index] = Math.round(pairTotal * leftWidth / (leftWidth + rightWidth));
                    currentWidths[index + 1] = pairTotal - currentWidths[index];
                    tr.setNodeMarkup($pos.before(), undefined, { ...section.attrs, columnWidths: currentWidths });
                  }
                  view.dispatch(tr);
                };
                resizeDetachByHandle.set(handle, attachLayoutColumnResizeHandle(handle, () => ({
                  dividerIndex: index,
                  labels: { merge: t("pageCanvas.mergeColumns") },
                  onCommit: commit,
                })));
                return handle;
              }, {
                key: `${node.attrs.sigmaDocId}:column-divider:${index}:${JSON.stringify(widths)}:${presentation.columnGap}`,
                side: -1,
                destroy: handle => { resizeDetachByHandle.get(handle)?.(); resizeDetachByHandle.delete(handle); },
                stopEvent: () => true,
              }));
            });
            return true;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
