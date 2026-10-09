import { Node as TiptapNodeExtension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { PROBLEM_AREA_ORDER, type ProblemNode } from "@/features/document";
import { isProblemAreaDisplayed, type ProblemDisplayFilter } from "@/features/rendering/core";
import { getProblemNumberFontSize, isRecord } from "@/features/text-editing/model";
import {
  getProblemCustomFrame,
  getProblemCustomFrameStyle,
  getProblemFrameStyleId,
  problemFrameClassName,
} from "@/lib/problem-frame";

export interface NestedProblemOptions {
  getProblemNumbers: () => ReadonlyMap<string, number>;
  /**
   * 紙面に出している問題の領域 (設定 > 表示)。外した領域は畳む (display: none)。畳んだ領域の中身は
   * 編集面のガードが守る (`collectProblemDisplayFoldedBlockIds`)。絞っていなければ undefined。
   */
  getProblemDisplay?: () => ProblemDisplayFilter | undefined;
}

export const nestedProblemLayoutKey = new PluginKey<DecorationSet>("nestedProblemLayout");

/** Presentation is derived from SigmaDoc metadata; numbers and frame fragments never enter saved content. */
export function createNestedProblemDecorations(
  doc: ProseMirrorNode,
  numbers: ReadonlyMap<string, number>,
  display?: ProblemDisplayFilter,
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "problem") return !node.isLeaf;
    const metadata: Partial<ProblemNode> = isRecord(node.attrs.problemMetadata) ? node.attrs.problemMetadata : {};
    const number = metadata.numbering?.enabled === false ? undefined : numbers.get(node.attrs.sigmaDocId);
    const displayed = (area: (typeof PROBLEM_AREA_ORDER)[number]) => !display || isProblemAreaDisplayed(display, area);
    const hasBody = (area: (typeof PROBLEM_AREA_ORDER)[number], index: number) => displayed(area) && Boolean(
      area === "prompt" || node.child(index).content.size > 0 || metadata.areaLayout?.[area]?.minHeightMm,
    );
    // 番号はふだん導入文に付く。「問題」を隠した表示では、いちばん上に出る領域が持つ。
    const numberArea = displayed("lead") ? "lead" : PROBLEM_AREA_ORDER.find((area, index) => hasBody(area, index));
    const visibleFrameAreas = PROBLEM_AREA_ORDER.filter((area, index) => area !== "lead" && hasBody(area, index));
    const visibleAreaCount = PROBLEM_AREA_ORDER.filter((area, index) => hasBody(area, index) || (area === numberArea && number !== undefined)).length;
    if (visibleAreaCount === 0) {
      // 出す領域が 1 つも無い問題は、枠ごと畳む。
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: "display:none" }));
      return false;
    }
    node.forEach((areaNode, offset, index) => {
      const area = areaNode.attrs.area as (typeof PROBLEM_AREA_ORDER)[number];
      const minHeight = metadata.areaLayout?.[area]?.minHeightMm;
      const showNumber = area === numberArea && number !== undefined;
      const visible = hasBody(area, index) || showNumber;
      const framed = metadata.frame?.enabled === true && area !== "lead" && visible;
      const classes = ["print-problem-area", framed ? problemFrameClassName("with-frame", getProblemFrameStyleId(metadata)) : ""];
      if (framed && area === visibleFrameAreas[0]) classes.push("first-frame-area");
      if (framed && area === visibleFrameAreas.at(-1)) classes.push("last-frame-area");
      const frameCustom = framed ? getProblemCustomFrame(metadata) : undefined;
      const customFrameStyle = frameCustom
        ? Object.entries(getProblemCustomFrameStyle(frameCustom, "mm")).map(([name, value]) => `${name}:${value}`)
        : [];
      const style = [!visible ? "display:none" : "", minHeight ? `min-height:${minHeight}mm` : "",
        showNumber ? `--nested-problem-number-size:${getProblemNumberFontSize(metadata)}pt` : "",
        ...customFrameStyle].filter(Boolean).join(";");
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
    const build = (doc: ProseMirrorNode) => createNestedProblemDecorations(
      doc,
      this.options.getProblemNumbers(),
      this.options.getProblemDisplay?.(),
    );
    return [new Plugin<DecorationSet>({
      key: nestedProblemLayoutKey,
      state: {
        init: (_config, state) => build(state.doc),
        apply: (transaction, previous) => transaction.docChanged || transaction.getMeta(nestedProblemLayoutKey)
          ? build(transaction.doc) : previous,
      },
      props: { decorations: state => nestedProblemLayoutKey.getState(state) ?? DecorationSet.empty },
      // 畳んだ領域は見えないので、そこを変える編集 (畳んだ領域をまたぐ選択の削除など) は通さない。
      // SigmaDoc からの同期 (`preventUpdate`) は人の編集ではないので通す。
      filterTransaction: (transaction, state) => {
        const display = this.options.getProblemDisplay?.();
        if (!display || !transaction.docChanged || transaction.getMeta("preventUpdate")) return true;
        return !changesFoldedProblemAreas(state.doc, transaction.doc, display);
      },
    })];
  },
});

/**
 * 絞り込みで畳んだ領域 (`display` が外した領域) の中身が変わるか。問題がまるごと消えるのは、見えている
 * 領域ごと消す操作なので通す。ただし 1 つも領域を出していない問題 (問題ごと畳んだもの) は見えないので、
 * 消すことも変えることもさせない。
 */
export function changesFoldedProblemAreas(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  display: ProblemDisplayFilter,
): boolean {
  // 領域は並び (導入文・問題文・コメント・解答) の位置で比べる。領域をまたぐ置き換えは、領域の印 (`area`) を
  // 既定値で作り直すことがある。
  const folded = new Map<string, { areas: Map<number, ProseMirrorNode>; wholeProblem: ProseMirrorNode | null }>();
  oldDoc.descendants((node) => {
    if (node.type.name !== "problem") return !node.isLeaf;
    const metadata: Partial<ProblemNode> = isRecord(node.attrs.problemMetadata) ? node.attrs.problemMetadata : {};
    const areas = new Map<number, ProseMirrorNode>();
    let shown = false;
    node.forEach((areaNode, _offset, index) => {
      const area = areaNode.attrs.area as (typeof PROBLEM_AREA_ORDER)[number];
      if (!isProblemAreaDisplayed(display, area)) {
        if (areaNode.content.size > 0) areas.set(index, areaNode);
        return;
      }
      // 出している領域が描かれるか (`createNestedProblemDecorations` と同じ規則。問題文はいつも描かれる)。
      shown ||= area === "prompt" || areaNode.content.size > 0 || Boolean(metadata.areaLayout?.[area]?.minHeightMm);
    });
    if (areas.size > 0 || !shown) {
      folded.set(node.attrs.sigmaDocId, { areas, wholeProblem: shown ? null : node });
    }
    return true;
  });
  if (folded.size === 0) return false;
  let changed = false;
  const survivors = new Set<string>();
  newDoc.descendants((node) => {
    if (changed) return false;
    if (node.type.name !== "problem") return !node.isLeaf;
    const before = folded.get(node.attrs.sigmaDocId);
    if (!before) return true;
    survivors.add(node.attrs.sigmaDocId);
    if (before.wholeProblem) {
      changed = !before.wholeProblem.eq(node);
      return false;
    }
    for (const [index, previous] of before.areas) {
      if (index >= node.childCount || !previous.eq(node.child(index))) changed = true;
    }
    return true;
  });
  if (changed) return true;
  return [...folded].some(([id, before]) => before.wholeProblem !== null && !survivors.has(id));
}

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
