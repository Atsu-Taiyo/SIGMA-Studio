import { Node as TiptapNodeExtension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { PROBLEM_AREA_ORDER, type ProblemNode } from "@/features/document";
import { getProblemNumberFontSize, isRecord } from "@/features/text-editing/model";
import { getProblemFrameStyleId, problemFrameClassName } from "@/lib/problem-frame";

export interface NestedProblemOptions {
  getProblemNumbers: () => ReadonlyMap<string, number>;
}

export const nestedProblemLayoutKey = new PluginKey<DecorationSet>("nestedProblemLayout");

/** Presentation is derived from SigmaDoc metadata; numbers and frame fragments never enter saved content. */
export function createNestedProblemDecorations(doc: ProseMirrorNode, numbers: ReadonlyMap<string, number>): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "problem") return !node.isLeaf;
    const metadata: Partial<ProblemNode> = isRecord(node.attrs.problemMetadata) ? node.attrs.problemMetadata : {};
    const number = metadata.numbering?.enabled === false ? undefined : numbers.get(node.attrs.sigmaDocId);
    const visibleFrameAreas = PROBLEM_AREA_ORDER.filter((area, index) => area !== "lead" && (
      area === "prompt" || node.child(index).content.size > 0 || metadata.areaLayout?.[area]?.minHeightMm
    ));
    node.forEach((areaNode, offset) => {
      const area = areaNode.attrs.area as (typeof PROBLEM_AREA_ORDER)[number];
      const minHeight = metadata.areaLayout?.[area]?.minHeightMm;
      const showNumber = area === "lead" && number !== undefined;
      const visible = area === "prompt" || areaNode.content.size > 0 || minHeight || showNumber;
      const framed = metadata.frame?.enabled === true && area !== "lead" && visible;
      const classes = ["print-problem-area", framed ? problemFrameClassName("with-frame", getProblemFrameStyleId(metadata)) : ""];
      if (framed && area === visibleFrameAreas[0]) classes.push("first-frame-area");
      if (framed && area === visibleFrameAreas.at(-1)) classes.push("last-frame-area");
      const style = [!visible ? "display:none" : "", minHeight ? `min-height:${minHeight}mm` : "",
        showNumber ? `--nested-problem-number-size:${getProblemNumberFontSize(metadata)}pt` : ""].filter(Boolean).join(";");
      decorations.push(Decoration.node(pos + 1 + offset, pos + 1 + offset + areaNode.nodeSize, {
        class: classes.filter(Boolean).join(" "), style,
        ...(showNumber ? { "data-problem-number": String(number) } : {}),
        ...(framed ? { "data-problem-frame-style": getProblemFrameStyleId(metadata) } : {}),
      }));
    });
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/** Problems nested in a box share its text surface; SigmaDoc owns the four areas. */
export const NestedProblemExtension = TiptapNodeExtension.create<NestedProblemOptions>({
  name: "problem",
  group: "boxChild",
  content: "problemArea{4}",
  defining: true,
  isolating: true,
  addOptions() { return { getProblemNumbers: () => new Map() }; },
  addAttributes() {
    return {
      sigmaDocId: { default: null, parseHTML: element => element.getAttribute("data-sigma-doc-id") },
      sigmaDocType: { default: "problem" },
      problemMetadata: {
        default: {},
        parseHTML: element => {
          try { return JSON.parse(element.getAttribute("data-problem-metadata") ?? "{}"); } catch { return {}; }
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'section[data-sigma-doc-type="problem"]' }]; },
  renderHTML({ node }) {
    return ["section", {
      "data-sigma-doc-type": "problem", "data-sigma-doc-id": node.attrs.sigmaDocId,
      "data-problem-id": node.attrs.sigmaDocId,
      "data-problem-metadata": JSON.stringify(node.attrs.problemMetadata),
      class: "sigma-doc-nested-problem",
    }, 0];
  },
  addProseMirrorPlugins() {
    const build = (doc: ProseMirrorNode) => createNestedProblemDecorations(doc, this.options.getProblemNumbers());
    return [new Plugin<DecorationSet>({
      key: nestedProblemLayoutKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (transaction, previous) => transaction.docChanged || transaction.getMeta(nestedProblemLayoutKey)
          ? build(transaction.doc) : previous,
      },
      props: { decorations: state => nestedProblemLayoutKey.getState(state) ?? DecorationSet.empty },
    })];
  },
});

export const NestedProblemAreaExtension = TiptapNodeExtension.create({
  name: "problemArea", content: "block*", defining: true, isolating: true,
  addAttributes() {
    return { area: { default: "prompt", parseHTML: element => element.getAttribute("data-problem-area") } };
  },
  parseHTML() { return [{ tag: 'div[data-problem-area]' }]; },
  renderHTML({ node }) {
    return ["div", { class: "sigma-doc-nested-problem-area", "data-problem-area": node.attrs.area },
      ["div", { class: "print-problem-area-content" }, 0]];
  },
});
