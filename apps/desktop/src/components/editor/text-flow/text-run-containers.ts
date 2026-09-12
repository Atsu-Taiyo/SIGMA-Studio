import {
  emptyProblemAreaEditorBlockId,
} from "@/features/rendering/core";
import type {
  LayoutSectionNode,
  ProblemAreaKind,
  ProblemNode,
  SigmaBlock,
} from "@/features/document";
import type { TextFlowBlock } from "@/features/text-editing";

/**
 * ユニットが「本文のどの入れ物の中身を編集しているか」。外側 → 内側の順に並ぶ。
 *
 * 本文は 1 つの連なりに見えるが、段組セクションと問題エリアはそれぞれ独立した
 * Tiptap インスタンスで、その doc には**中身のブロックしか入っていない**。跨ぎ選択の
 * コピーが入れ物ごと運ぶには、ユニット側から「自分は誰の中身か」を渡すしかない。
 *
 * 問題エリアの中に段組があると入れ子になる (`problemLayoutSection` ユニット) ので、
 * 1 段ではなく列で持つ。
 */
export type TextRunContainerFrame =
  | { kind: "layoutSection"; id: string; layout: LayoutSectionNode["layout"] }
  /**
   * `template` は同じ問題の他エリア・タグ・番号・枠の設定を運ぶための原本。エリアの中身は
   * 選択範囲から組み直すので、ここからは使わない。
   */
  | { kind: "problemArea"; id: string; area: ProblemAreaKind; template: ProblemNode };

export type TextRunScopeContainer = readonly TextRunContainerFrame[];

export interface TextRunContainerEntry {
  blocks: TextFlowBlock[];
  containers?: TextRunScopeContainer;
}

/**
 * 選択されたユニットごとのブロック列を、入れ物ごと組み直して文書順の SigmaBlock 列にする。
 *
 * 同じ入れ物 (id 一致) の連続したユニットは 1 つのブロックへ束ねる — 問題は
 * 導入文 / 問題文 / ヒント / 解答が別ユニットなので、束ねないと同じ問題が 4 つ並ぶ。
 */
export function wrapTextRunBlocksInContainers(entries: readonly TextRunContainerEntry[]): SigmaBlock[] {
  const blocks: SigmaBlock[] = [];
  for (const entry of entries) {
    mergeEntryIntoBlocks(blocks, entry.containers ?? [], entry.blocks);
  }
  return blocks;
}

function mergeEntryIntoBlocks(
  target: SigmaBlock[],
  frames: TextRunScopeContainer,
  blocks: readonly TextFlowBlock[],
): void {
  const frame = frames[0];
  if (!frame) {
    target.push(...blocks);
    return;
  }

  const accepted = blocks.filter((block) => isBlockAllowedInFrame(frame, block));
  if (accepted.length === 0) {
    return;
  }

  const last = target.at(-1);
  const host = last && last.id === frame.id && last.type === frameBlockType(frame)
    ? last
    : appendFrameBlock(target, frame);

  // 入れ物の子は SigmaBlock の部分集合 (段の中に段組は入れない・問題エリアに section は
  // 入らない) なので、`isBlockAllowedInFrame` を通した列だけをここへ流す。
  mergeEntryIntoBlocks(frameChildren(host, frame) as SigmaBlock[], frames.slice(1), accepted);
}

function frameBlockType(frame: TextRunContainerFrame): SigmaBlock["type"] {
  return frame.kind === "layoutSection" ? "layoutSection" : "problem";
}

function appendFrameBlock(target: SigmaBlock[], frame: TextRunContainerFrame): SigmaBlock {
  const block: SigmaBlock = frame.kind === "layoutSection"
    ? { type: "layoutSection", id: frame.id, layout: { ...frame.layout }, children: [] }
    : emptyProblemFromTemplate(frame.template);
  target.push(block);
  return block;
}

/** 中身は選択範囲から組み直すので、原本からは中身以外 (タグ・解答・番号・枠・エリア設定) だけを引き継ぐ。 */
function emptyProblemFromTemplate(template: ProblemNode): ProblemNode {
  const problem: ProblemNode = {
    ...structuredClone(template),
    lead: [],
    prompt: [],
    hints: [],
    solution: [],
  };
  return problem;
}

function frameChildren(host: SigmaBlock, frame: TextRunContainerFrame): unknown[] {
  if (frame.kind === "layoutSection") {
    return (host as LayoutSectionNode).children;
  }
  return (host as ProblemNode)[frame.area];
}

function isBlockAllowedInFrame(frame: TextRunContainerFrame, block: TextFlowBlock): boolean {
  if (frame.kind === "layoutSection") {
    // 段の中に段組は入れられない (SigmaDoc の `LayoutSectionChildBlock`)。
    return block.type !== "layoutSection";
  }
  if (block.type === "section") {
    // 問題エリアは見出し行 (`SectionNode`) を持てない (`ProblemAreaBlock`)。
    return false;
  }
  // 空エリアの編集用段落は SigmaDoc に存在しない派生ブロック。運ぶと空段落が増えるだけ。
  return !(
    block.id === emptyProblemAreaEditorBlockId(frame.id, frame.area) &&
    block.type === "paragraph" &&
    block.children.length === 0
  );
}
