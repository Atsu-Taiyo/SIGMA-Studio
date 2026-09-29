import { PROBLEM_AREA_ORDER, type SigmaBlock } from "@/features/document";
import { shouldShowProblemArea } from "@/features/rendering/core";

import { getTextFlowBlockEditorLength } from "../model";

/**
 * 手動改ページ (改段) を**どこに置けるか**と、**どの区切りがどのブロックに隣接しているか**。
 *
 * 区切りは TeX の `\newpage` と同じく本文の流れの中の一点で、`pagination.break` は「このブロック
 * の最初の行の前で改ページする」を意味する。引用・箱・問題の各エリア・1段組の段組みの中でも
 * 同じ意味で効く。例外は独立した複数段の段組み (`layoutSection` の columnCount > 1) の中だけで、
 * そこでは段の所属を `layout.columnStartIds` が決めるので区切りを持たせない (MISS.md R9)。
 */

type FlowBlock = SigmaBlock;

interface FlowEntry {
  block: FlowBlock;
  /** 外側から順に並べた祖先。 */
  ancestors: FlowBlock[];
  /** 親の子列の中で先頭か (問題なら表示される最初のエリアの先頭)。 */
  first: boolean;
}

function childGroups(block: FlowBlock): FlowBlock[][] {
  if (block.type === "quote" || block.type === "boxBlock") return [block.blocks as FlowBlock[]];
  if (block.type === "layoutSection") return [block.children as FlowBlock[]];
  if (block.type === "problem") {
    return PROBLEM_AREA_ORDER
      .filter((area) => shouldShowProblemArea(block, area))
      .map((area) => block[area] as FlowBlock[]);
  }
  return [];
}

/** 文書順 (描く順) に全ブロックを並べる。リストの項目はブロックではないので含めない。 */
function flattenFlow(blocks: readonly FlowBlock[]): FlowEntry[] {
  const entries: FlowEntry[] = [];
  const visit = (siblings: readonly FlowBlock[], ancestors: FlowBlock[], firstGroup: boolean) => {
    siblings.forEach((block, index) => {
      entries.push({ block, ancestors, first: firstGroup && index === 0 });
      const groups = childGroups(block);
      groups.forEach((group, groupIndex) => visit(group, [...ancestors, block], groupIndex === 0));
    });
  };
  visit(blocks, [], true);
  return entries;
}

function isMultiColumnSection(block: FlowBlock): boolean {
  return block.type === "layoutSection" && (block.layout.columnCount ?? 1) > 1;
}

/**
 * 子孫に手動改ページを持つブロックの id。ページ割りの計測が、中を探す必要のある最上位ブロックを
 * 文書から先に絞るために使う (区切りを持たない引用・リスト・箱の中を毎回歩かない)。
 */
export function collectManualBreakHostIds(blocks: readonly FlowBlock[]): Set<string> {
  const hosts = new Set<string>();
  for (const entry of flattenFlow(blocks)) {
    if (entry.block.pagination?.break !== true) continue;
    for (const ancestor of entry.ancestors) hosts.add(ancestor.id);
  }
  return hosts;
}

/**
 * このブロックに手動改ページ (改段) を置けるか。
 *
 * 本文の流れのどこでも置ける (引用・箱・問題・1段組の段組みの中も)。独立した複数段の段組みの
 * 中だけは置けない。
 */
export function isManualBreakAllowedAtBlock(blocks: readonly FlowBlock[], blockId: string): boolean {
  const entry = flattenFlow(blocks).find((candidate) => candidate.block.id === blockId);
  return !!entry && !entry.ancestors.some(isMultiColumnSection);
}

/**
 * `blockId` の最初の行の直前にある手動改ページの持ち主。そのブロック自身か、そのブロックから
 * 始まる入れ物 (先頭の子を辿った祖先) のうち、区切りを持つ最も外側のもの。
 */
export function findManualBreakOwnerAtBlockStart(
  blocks: readonly FlowBlock[],
  blockId: string,
): string | null {
  const entries = flattenFlow(blocks);
  const entry = entries.find((candidate) => candidate.block.id === blockId);
  if (!entry || entry.ancestors.some(isMultiColumnSection)) return null;
  let owner: string | null = entry.block.pagination?.break === true ? entry.block.id : null;
  let current = entry;
  while (current.first && current.ancestors.length > 0) {
    const parent = current.ancestors[current.ancestors.length - 1];
    // 箱のタイトルは本文の前の行なので、タイトルのある箱の区切りは本文の先頭に隣接しない。
    if (parent.type === "boxBlock" && hasBoxTitle(parent)) break;
    if (parent.pagination?.break === true) owner = parent.id;
    const parentEntry = entries.find((candidate) => candidate.block === parent);
    if (!parentEntry) break;
    current = parentEntry;
  }
  return owner;
}

/**
 * `blockId` (とその中身) の直後にある手動改ページの持ち主。改ページの印はこのブロックの直後に
 * 描かれるので、右クリックしたブロックから「すぐ後ろの区切り」を解除できるようにする。
 */
export function findManualBreakOwnerAfterBlock(
  blocks: readonly FlowBlock[],
  blockId: string,
): string | null {
  const entries = flattenFlow(blocks);
  const index = entries.findIndex((candidate) => candidate.block.id === blockId);
  if (index < 0) return null;
  const clicked = entries[index].block;
  const next = entries.slice(index + 1).find((candidate) => !candidate.ancestors.includes(clicked));
  return next ? findManualBreakOwnerAtBlockStart(blocks, next.block.id) : null;
}

/**
 * 右クリックしたブロックから「解除」できる区切り。そのブロック自身、それを囲む入れ物 (引用・
 * 箱・問題・1段組の段組み) の区切り、なければ**すぐ後ろ**の区切り。ページの途中の無関係な
 * ブロックから、離れた場所の区切りを解除させない。
 */
export function findManualBreakOwnerForBlock(
  blocks: readonly FlowBlock[],
  blockId: string,
): string | null {
  const entry = flattenFlow(blocks).find((candidate) => candidate.block.id === blockId);
  if (!entry) return null;
  if (entry.block.pagination?.break === true) return entry.block.id;
  for (let index = entry.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = entry.ancestors[index];
    if (isMultiColumnSection(ancestor)) return null;
    if (ancestor.pagination?.break === true) return ancestor.id;
  }
  return findManualBreakOwnerAfterBlock(blocks, blockId);
}

/**
 * 区切りを付ける先を、そのブロックから始まる入れ物まで持ち上げる。引用・箱・1段組の段組みの
 * 先頭の子に付けた区切りは「その入れ物の前の区切り」と同じ位置なので、入れ物に持たせる
 * (中に残すと入れ物の上端の縁や見出しだけが前のページに残る)。問題のエリアは持ち上げない —
 * エリアの先頭の区切りは「そのエリアの前」であって問題全体の前ではない。
 */
export function resolveManualBreakHoistTarget(
  blocks: readonly FlowBlock[],
  blockId: string,
): string {
  const entries = flattenFlow(blocks);
  let current = entries.find((candidate) => candidate.block.id === blockId);
  let target = blockId;
  while (current?.first && current.ancestors.length > 0) {
    const parent = current.ancestors[current.ancestors.length - 1];
    if (parent.type !== "quote" && parent.type !== "boxBlock" && !(parent.type === "layoutSection" && !isMultiColumnSection(parent))) {
      break;
    }
    target = parent.id;
    current = entries.find((candidate) => candidate.block === parent);
  }
  return target;
}

export interface ManualBreakInsertionPoint {
  blockId: string;
  /** キャレットのブロック内 offset。省略時はブロックの末尾。 */
  offset?: number;
}

/**
 * キャレットの位置に区切りを入れて空のページ (段) ができないか。区切りの前に、前の区切り以降の
 * 本文 (文字・図などの中身) が 1 つも無いなら入れない。
 */
export function canInsertManualPageBreakAt(
  blocks: readonly FlowBlock[],
  point: ManualBreakInsertionPoint,
): boolean {
  const entries = flattenFlow(blocks);
  const entry = entries.find((candidate) => candidate.block.id === point.blockId);
  if (!entry || entry.ancestors.some(isMultiColumnSection)) return false;
  // `resolveManualTextPageBreakBlocks` と同じ長さで先頭・途中・末尾を決める。
  const length = getTextFlowBlockEditorLength(entry.block);
  const offset = Math.max(0, Math.min(point.offset ?? length, length));
  // 文字の途中・末尾: キャレットの前にこのブロックの文字がある。
  if (length > 0 && offset > 0) return true;
  // 先頭 (空のブロックを含む): 区切りはこのブロック (から始まる入れ物) の前に入る。
  const targetId = resolveManualBreakHoistTarget(blocks, point.blockId);
  let hasBody = false;
  for (const candidate of entries) {
    if (candidate.ancestors.some(isMultiColumnSection)) continue;
    if (candidate.block.id === targetId) return hasBody && candidate.block.pagination?.break !== true;
    if (candidate.block.pagination?.break === true) hasBody = false;
    hasBody ||= occupiesBody(candidate.block);
  }
  return false;
}

function isTextLeaf(block: FlowBlock): boolean {
  return block.type === "paragraph" || block.type === "heading" || block.type === "codeBlock" || block.type === "section";
}

function hasBoxTitle(block: Extract<FlowBlock, { type: "boxBlock" }>): boolean {
  return (block.title ?? []).some((node) => node.type !== "text" || node.text.trim().length > 0);
}

/**
 * 紙面の本文領域を占めるか。空の段落は占めない。引用・段組み・問題は中身で判断する (入れ物
 * だけを前のページに残すと、空のページと同じに見える)。箱は枠そのものが見えるので占める。
 */
function occupiesBody(block: FlowBlock): boolean {
  if (isTextLeaf(block)) return getTextFlowBlockEditorLength(block) > 0;
  if (block.type === "quote" || block.type === "layoutSection" || block.type === "problem") return false;
  // 箱・リスト・区切り線など。
  return true;
}
