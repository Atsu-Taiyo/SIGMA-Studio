import {
  PROBLEM_AREA_ORDER,
  type InlineNode,
  type ListItemNode,
  type ListNode,
  type OverlayAsset,
  type OverlayShape,
  type ProblemAreaKind,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import { mapBlockLineNodes, pairBlockLines, buildAppliedDiffRows } from "@/lib/ai/applied-diff-lines";
import {
  isOverlayAnchorSupportDraft,
  type AiAppliedDiffChange,
  type AiAppliedDocumentDiff,
} from "@/lib/ai/applied-document-diff";
import { diffInlineNodeRanges, type InlineChangeRange } from "@/lib/ai/inline-diff";
import {
  primarySigmaDocMutationOpTargetId,
  resolveAiEditSessionOperationOrder,
  type AiEditSessionDraft,
  type SigmaDocMutationOp,
} from "@/lib/ai/sigma-doc-edit-schema";
import {
  collectBlocksById,
  findProblemAreaBlockLocation,
  type EditableBlock,
} from "@/lib/document-tree";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import { getProblemNumberMap } from "@/lib/problem-numbering";
import { areStructurallyEqual } from "@/lib/structural-equality";

import {
  deriveAiEditPreviewOverlayShapes,
  hasBodyAiEditChanges,
  isOverlayAiEditDraft,
  isOverlaySigmaDocMutationOp,
  resolveMutationOpAssets,
  type AiEditPreviewState,
} from "./preview";
import { resolveProposalMergePreview } from "./proposal-merge-preview";

/**
 * 提案の「内容」の唯一のモデル。本文カード (紙面)・サイドバー・⌘K パネル・チャットの図形サムネは
 * どれもこれを `AiProposalContentView` で描く。表示の方式 (紙面か縮小か) は部品の `surface` が
 * 決め、ここは**何が消えて何が足されるか**だけを持つ。
 *
 * 作り方は 2 つ:
 * - 保留中の提案から (`buildPendingProposalContent`)。削除側は今の文書、追加側は**渡された
 *   適用後の文書**から読む。渡すのは承認と同じ合成 replay の結果 (`resolveProposalMergePreview`)
 *   なので、提案の後に人が対象を直していれば、その編集と AI の変更の両方が入った内容になる。
 * - 適用済みの差分から (`buildAppliedProposalContent`)。承認時に保存した `AiAppliedDocumentDiff`
 *   (旧レコードを含む) をそのまま読む。
 */

export type AiProposalChange = AiAppliedDiffChange;

/** 塊に含まれる操作の種類。見出し (「AI挿入案」など) を決めるのに使う。 */
export type AiProposalOperationKind =
  | "replace"
  | "insertAfter"
  | "deleteBlocks"
  | "moveBlocks"
  | "wrapBlocksInColumns"
  | "updateLayoutSection"
  | "other";

export interface AiProposalNumbering {
  /** 問題 id → 番号。番号を出さない問題は入らない。 */
  problems: ReadonlyMap<string, number>;
  /** 見出し/章 id → 番号の文字列。 */
  headings: ReadonlyMap<string, string>;
}

/**
 * 紙面の 1 か所 (アンカー) にまとまる変更。
 *
 * `anchorBlockId` は紙面が内容を差し込める**流れのブロック**: 最上位の本文ブロック、最上位の
 * 問題の各エリアの直下、最上位の段組みの各段の直下。入れ子の対象 (箱やリストの中) はその外側の
 * 流れのブロックまで遡る。`insertAfter` を連ねた挿入は、連鎖の根の実在するブロックに集める。
 */
export interface AiProposalContentHunk {
  anchorBlockId: string;
  /** アンカーが問題のエリアの中にあるとき、その問題とエリア。 */
  problemArea?: { problemId: string; area: ProblemAreaKind };
  /** 消える (置き換わる) ブロック。今の文書の文書順。 */
  removed: EditableBlock[];
  /** 足される (置き換えた後の) ブロック。適用後の文書の文書順。 */
  added: EditableBlock[];
  /** 本文の中身を持たない操作 (移動・削除など) の要約。モデル自身が書いた文で、空のこともある。 */
  notes: string[];
  operations: AiProposalOperationKind[];
  /** 削除側は今の文書、追加側は適用後の文書の番号。 */
  numbering: { removed: AiProposalNumbering; added: AiProposalNumbering };
}

export interface AiProposalShapeChange {
  change: AiProposalChange;
  shape: OverlayShape;
  /** この図形を描くのに使う画像。削除側は今の文書、追加側は適用後のもの。 */
  assets: Readonly<Record<string, OverlayAsset>>;
}

export interface AiProposalContent {
  hunks: AiProposalContentHunk[];
  shapes: AiProposalShapeChange[];
}

/** 紙面の 1 か所に置くカード 1 枚分: どの提案の、どの内容か。 */
export interface AiProposalAnchorCard {
  preview: AiEditPreviewState;
  content: AiProposalContent;
  /** 内容が人の編集と合成したものか (承認バーに一言を添える)。 */
  mergedWithHumanEdits: boolean;
}

/**
 * 提案の表示用コピーに付ける id の接頭辞。`PrintBlock` は `data-sigma-doc-id` を出すので、
 * そのまま描くと紙面の本物と同じ id が 2 つ並ぶ (計測やアンカーが先に見つけた方を採る)。
 */
export const AI_PROPOSAL_PREVIEW_ID_PREFIX = "ai-proposal-preview:";

/**
 * 変わった単語に付ける印 (CSS 変数の名前)。表示用のコピーの `backgroundColor` を
 * `var(<印>, <元の背景色>)` にする。印の変数はどこにも定義しないので、描かれる背景色は元のまま
 * (マーカー色を変えた提案でも、どの色からどの色に変わるかが見える)。差分の色は描画部品の CSS が
 * この印を手がかりに `background-image` として半透明で重ねる。保存される文書には書かない。
 */
export const AI_PROPOSAL_WORD_HIGHLIGHT = {
  removed: "--ai-proposal-word-removed-mark",
  added: "--ai-proposal-word-added-mark",
} as const;

const EMPTY_NUMBERING: AiProposalNumbering = { problems: new Map(), headings: new Map() };

interface DocumentFlowIndex {
  /** 各ブロック id → 紙面で内容を差し込める流れのブロック (自分自身か、外側の最も近いもの)。 */
  flowAnchorById: Map<string, string>;
  /** 文書順 (深さ優先。問題のエリアは紙面の並び)。 */
  orderById: Map<string, number>;
  /** リスト項目 id → その項目を持つリストと、リストの中の位置。 */
  listOfItem: Map<string, { list: ListNode; index: number }>;
}

type FlowWalkBlock = SigmaBlock | EditableBlock;

function indexDocumentFlow(document: SigmaDocument): DocumentFlowIndex {
  const flowAnchorById = new Map<string, string>();
  const orderById = new Map<string, number>();
  const listOfItem = new Map<string, { list: ListNode; index: number }>();
  let order = 0;

  const record = (id: string, anchor: string) => {
    flowAnchorById.set(id, anchor);
    orderById.set(id, order++);
  };

  const visit = (block: FlowWalkBlock, flowLevel: boolean, outerAnchor: string | null): void => {
    const anchor = flowLevel || outerAnchor === null ? block.id : outerAnchor;
    record(block.id, anchor);
    switch (block.type) {
      case "problem":
        // 最上位の問題のエリアの直下は、エリアごとの編集面に並ぶ流れのブロック。
        for (const area of PROBLEM_AREA_ORDER) {
          for (const child of block[area]) {
            visit(child, flowLevel, anchor);
          }
        }
        return;
      case "layoutSection":
        // 段組みの各段も独立した編集面なので、段の直下は流れのブロック。
        for (const child of block.children) {
          visit(child, flowLevel, anchor);
        }
        return;
      case "boxBlock":
        for (const child of block.blocks) {
          visit(child, false, anchor);
        }
        return;
      case "quote":
        for (const child of block.blocks) {
          visit(child, false, anchor);
        }
        return;
      case "list":
        block.items.forEach((item, index) => {
          listOfItem.set(item.id, { list: block, index });
          visit(item, false, anchor);
        });
        return;
      case "listItem":
        for (const continuation of block.continuations ?? []) {
          record(continuation.id, anchor);
        }
        for (const nested of block.nested ?? []) {
          visit(nested, false, anchor);
        }
        return;
      default:
        return;
    }
  };

  for (const block of document.content) {
    visit(block, true, null);
  }
  return { flowAnchorById, orderById, listOfItem };
}

/**
 * リスト項目は、その項目だけを持つリストとして見せる。項目の文だけを段落にすると、子の項目
 * (`nested`) と続きの段落 (`continuations`) が落ち、そこだけを直した提案が「変わらない親の行が
 * 2 回並ぶ」表示になる。番号付きのリストは元の位置の番号から始める。id は項目のものを使うので、
 * 置き換えの両側は同じ id で組になる。所属が分からない (文書が無い) ときは箇条書きにする。
 */
function presentListItem(item: ListItemNode, owner?: { list: ListNode; index: number }): ListNode {
  const list = owner?.list;
  const ordered = list?.listType === "ordered";
  return {
    id: item.id,
    type: "list",
    listType: list?.listType ?? "bullet",
    ...(ordered && list?.markerStyle ? { markerStyle: list.markerStyle } : {}),
    ...(ordered ? { start: (list?.start ?? 1) + (owner?.index ?? 0) } : {}),
    items: [item],
  };
}

function presentBlock(block: EditableBlock, index: DocumentFlowIndex | null): EditableBlock {
  return block.type === "listItem" ? presentListItem(block, index?.listOfItem.get(block.id)) : block;
}

function numberingOf(document: SigmaDocument): AiProposalNumbering {
  return {
    problems: getProblemNumberMap(document.content),
    headings: getHeadingNumberMap(document.content, document.metadata?.headingNumbering),
  };
}

function operationOrder(draft: AiEditSessionDraft): ReturnType<typeof resolveAiEditSessionOperationOrder> {
  try {
    return resolveAiEditSessionOperationOrder(draft);
  } catch {
    return [
      ...draft.operations.map((_, index) => ({ kind: "operation" as const, index })),
      ...(draft.mutationOperations ?? []).map((_, index) => ({ kind: "mutation" as const, index })),
    ];
  }
}

function mutationKind(op: SigmaDocMutationOp): AiProposalOperationKind {
  const operation = (op as { operation?: unknown }).operation;
  return operation === "deleteBlocks" || operation === "moveBlocks"
    || operation === "wrapBlocksInColumns" || operation === "updateLayoutSection"
    ? operation
    : "other";
}

function mutationSummary(op: SigmaDocMutationOp): string {
  const summary = (op as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary.trim() : "";
}

interface HunkDraft {
  anchorBlockId: string;
  problemArea?: AiProposalContentHunk["problemArea"];
  removed: Map<string, EditableBlock>;
  added: Map<string, EditableBlock>;
  notes: string[];
  operations: AiProposalOperationKind[];
}

function byDocumentOrder(blocks: Iterable<EditableBlock>, orderById: Map<string, number> | undefined): EditableBlock[] {
  const list = [...blocks];
  if (!orderById) {
    return list;
  }
  return list
    .map((block, index) => ({ block, index, order: orderById.get(block.id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ block }) => block);
}

/**
 * 保留中の提案から内容を作る。`afterDocument` は提案を適用した後の文書で、追加側のブロックと
 * 番号はそこから読む (`null` なら draft の中身と今の文書の番号で代える)。
 */
export function buildPendingProposalContent(
  current: SigmaDocument,
  afterDocument: SigmaDocument | null,
  preview: AiEditPreviewState,
): AiProposalContent {
  return {
    hunks: hasBodyAiEditChanges(preview) ? buildPendingHunks(current, afterDocument, preview) : [],
    shapes: buildPendingShapeChanges(current, afterDocument, preview),
  };
}

function buildPendingHunks(
  current: SigmaDocument,
  afterDocument: SigmaDocument | null,
  preview: AiEditPreviewState,
): AiProposalContentHunk[] {
  const { draft } = preview;
  const operations = draft.operations;
  const mutationOperations = draft.mutationOperations ?? [];
  const currentIndex = indexDocumentFlow(current);
  const afterIndex = afterDocument ? indexDocumentFlow(afterDocument) : null;
  const currentBlocks = collectBlocksById(current.content);
  const afterBlocks = afterDocument ? collectBlocksById(afterDocument.content) : null;
  const removedNumbering = numberingOf(current);
  const numbering = { removed: removedNumbering, added: afterDocument ? numberingOf(afterDocument) : removedNumbering };

  // この draft が作る (まだ文書に無い) id → その挿入先。連ねた挿入を根のアンカーへ集める。
  const insertedIdToTarget = new Map<string, string>();
  for (const operation of operations) {
    if (operation.operation === "insertAfter") {
      insertedIdToTarget.set(operation.insertedBlock.id, operation.targetId);
    }
  }
  const resolveChainRoot = (targetId: string): string => {
    const visited = new Set<string>();
    let currentId = targetId;
    while (insertedIdToTarget.has(currentId) && !visited.has(currentId)) {
      visited.add(currentId);
      currentId = insertedIdToTarget.get(currentId)!;
    }
    return currentId;
  };

  const hunks = new Map<string, HunkDraft>();
  const hunkFor = (targetId: string): HunkDraft => {
    const root = resolveChainRoot(targetId);
    const anchorBlockId = currentIndex.flowAnchorById.get(root) ?? root;
    let hunk = hunks.get(anchorBlockId);
    if (!hunk) {
      const location = findProblemAreaBlockLocation(current, anchorBlockId);
      hunk = {
        anchorBlockId,
        ...(location ? { problemArea: { problemId: location.problemId, area: location.area } } : {}),
        removed: new Map(),
        added: new Map(),
        notes: [],
        operations: [],
      };
      hunks.set(anchorBlockId, hunk);
    }
    return hunk;
  };
  const addProposed = (hunk: HunkDraft, draftBlock: EditableBlock) => {
    // 適用後の文書があればそこから読む。無い id は同じ draft の後の操作が消したもの。
    const block = afterBlocks ? afterBlocks.get(draftBlock.id) : draftBlock;
    if (block) {
      hunk.added.set(block.id, presentBlock(block, afterIndex ?? currentIndex));
    }
  };
  // AI が消すブロックを人が直していれば、合成はそのブロックを残す (編集は削除に勝つ)。適用後の
  // 文書に今と同じ内容で残るブロックは、消える側に出さない。同じ draft が同じ id を挿入し直す
  // (置き換え・移動) ときは従来どおり消える側にも出す。
  const isKeptByMerge = (blockId: string): boolean => {
    if (!afterBlocks || insertedIdToTarget.has(blockId)) {
      return false;
    }
    const kept = afterBlocks.get(blockId);
    return kept !== undefined && areStructurallyEqual(kept, currentBlocks.get(blockId));
  };
  const addCurrent = (hunk: HunkDraft, blockId: string) => {
    const block = currentBlocks.get(blockId);
    if (block) {
      hunk.removed.set(block.id, presentBlock(block, currentIndex));
    }
  };

  for (const entry of operationOrder(draft)) {
    if (entry.kind === "operation") {
      const operation = operations[entry.index];
      if (!operation || isOverlayAiEditDraft(operation) || isOverlayAnchorSupportDraft(operation, operations)) {
        continue;
      }
      const hunk = hunkFor(operation.targetId);
      if (operation.operation === "insertAfter") {
        hunk.operations.push("insertAfter");
        addProposed(hunk, operation.insertedBlock);
      } else if (operation.operation === undefined || operation.operation === "replace") {
        hunk.operations.push("replace");
        addCurrent(hunk, operation.targetId);
        addProposed(hunk, operation.replacementBlock);
      }
      continue;
    }

    const op = mutationOperations[entry.index];
    if (!op || isOverlaySigmaDocMutationOp(op)) {
      continue;
    }
    const targetId = primarySigmaDocMutationOpTargetId(op);
    if (!targetId) {
      continue;
    }
    const hunk = hunkFor(targetId);
    hunk.operations.push(mutationKind(op));
    hunk.notes.push(mutationSummary(op));
    // 位置や段組みだけを変える操作は中身が変わらないので、ブロックは並べない (要約だけ)。
    if (op.operation === "deleteBlocks") {
      op.blockIds
        .filter((blockId) => !isKeptByMerge(blockId))
        .forEach((blockId) => addCurrent(hunk, blockId));
    }
  }

  return [...hunks.values()]
    .map((hunk, index) => ({
      index,
      order: currentIndex.orderById.get(hunk.anchorBlockId) ?? Number.POSITIVE_INFINITY,
      hunk: {
        anchorBlockId: hunk.anchorBlockId,
        ...(hunk.problemArea ? { problemArea: hunk.problemArea } : {}),
        removed: byDocumentOrder(hunk.removed.values(), currentIndex.orderById),
        added: byDocumentOrder(hunk.added.values(), afterIndex?.orderById),
        notes: hunk.notes,
        operations: hunk.operations,
        numbering,
      } satisfies AiProposalContentHunk,
    }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ hunk }) => hunk);
}

function buildPendingShapeChanges(
  current: SigmaDocument,
  afterDocument: SigmaDocument | null,
  preview: AiEditPreviewState,
): AiProposalShapeChange[] {
  const operations = preview.draft.operations;
  const mutationOperations = preview.draft.mutationOperations ?? [];
  if (!operations.some(isOverlayAiEditDraft) && !mutationOperations.some(isOverlaySigmaDocMutationOp)) {
    return [];
  }

  const snapshot = current.pageLayout?.overlay?.overlaySnapshot;
  const currentShapes = snapshot?.shapes ?? [];
  const currentAssets: Record<string, OverlayAsset> = snapshot?.assets ?? {};
  const currentById = new Map(currentShapes.map((shape) => [shape.id, shape]));
  // 承認したら実際に反映される姿 (patch 適用後・置き換えは元の位置と id のまま)。
  const postStateById = new Map(
    deriveAiEditPreviewOverlayShapes(preview, currentShapes).map((shape) => [shape.id, shape]),
  );
  const afterSnapshot = afterDocument?.pageLayout?.overlay?.overlaySnapshot;
  const afterById = new Map((afterSnapshot?.shapes ?? []).map((shape) => [shape.id, shape]));
  const replacedIdByAddedId = new Map(
    (preview.shapeReplacements ?? []).map((pair) => [pair.addedShapeId, pair.removedShapeId]),
  );

  // 追加側の画像: 今の文書の画像に、挿入が持ち込む画像と更新が差し替える画像を重ねる。
  let addedAssets: Record<string, OverlayAsset> = { ...currentAssets, ...(afterSnapshot?.assets ?? {}) };
  for (const operation of operations) {
    if (operation.operation === "insertOverlayShape") {
      addedAssets = { ...addedAssets, ...(operation.assets ?? {}) };
    }
  }
  for (const op of mutationOperations) {
    addedAssets = resolveMutationOpAssets(op, addedAssets);
  }

  const removed = new Map<string, OverlayShape>();
  const added = new Map<string, OverlayShape>();
  const pushRemoved = (shapeId: string) => {
    const shape = currentById.get(shapeId);
    if (shape && !removed.has(shapeId)) {
      removed.set(shapeId, shape);
    }
  };
  const pushAdded = (shape: OverlayShape | undefined) => {
    if (shape && !added.has(shape.id)) {
      added.set(shape.id, shape);
    }
  };
  const finalShape = (shapeId: string) => afterById.get(shapeId) ?? postStateById.get(shapeId) ?? currentById.get(shapeId);

  for (const operation of operations) {
    if (operation.operation !== "insertOverlayShape" && operation.operation !== "insertTableShape") {
      continue;
    }
    const inserted = operation.operation === "insertOverlayShape" ? operation.overlayShape : operation.tableShape;
    const replacedShapeId = replacedIdByAddedId.get(inserted.id);
    if (replacedShapeId) {
      pushRemoved(replacedShapeId);
      pushAdded(postStateById.get(replacedShapeId) ?? inserted);
    } else {
      pushAdded(afterById.get(inserted.id) ?? inserted);
    }
  }
  for (const op of mutationOperations) {
    if (op.operation === "deleteOverlayShapes") {
      op.shapeIds.forEach(pushRemoved);
    } else if (op.operation === "updateOverlayShape") {
      pushRemoved(op.shapeId);
      pushAdded(finalShape(op.shapeId));
    } else if (op.operation === "alignOverlayShapes") {
      op.shapeIds.forEach((shapeId) => {
        pushRemoved(shapeId);
        pushAdded(finalShape(shapeId));
      });
    }
  }

  return [
    ...[...removed.values()].map((shape) => ({ change: "removed" as const, shape, assets: currentAssets })),
    ...[...added.values()].map((shape) => ({ change: "added" as const, shape, assets: addedAssets })),
  ];
}

/**
 * 適用済みの差分 (承認時に保存した `AiAppliedDocumentDiff`) から内容を作る。差分は文書を
 * 持たないので、番号と問題エリアは付かない。図形の画像は `assets` (ふつうは今の文書の画像) で描く。
 */
export function buildAppliedProposalContent(
  diff: AiAppliedDocumentDiff,
  assets: Readonly<Record<string, OverlayAsset>> = {},
): AiProposalContent {
  const order: string[] = [];
  const removedById = new Map<string, EditableBlock>();
  const addedById = new Map<string, EditableBlock>();
  for (const entry of diff.body) {
    if (!removedById.has(entry.block.id) && !addedById.has(entry.block.id)) {
      order.push(entry.block.id);
    }
    (entry.change === "removed" ? removedById : addedById).set(entry.block.id, entry.block);
  }

  const hunks: AiProposalContentHunk[] = [];
  for (const id of order) {
    const removed = removedById.get(id);
    const added = addedById.get(id);
    // 移動やレイアウトだけの変更は、中身が同じ組として記録される。何も変わっていないので出さない。
    if (removed && added && buildAppliedDiffRows({ body: [{ change: "removed", block: removed }, { change: "added", block: added }] }).length === 0) {
      continue;
    }
    hunks.push({
      anchorBlockId: id,
      removed: removed ? [presentBlock(removed, null)] : [],
      added: added ? [presentBlock(added, null)] : [],
      notes: [],
      operations: [removed && added ? "replace" : removed ? "deleteBlocks" : "insertAfter"],
      numbering: { removed: EMPTY_NUMBERING, added: EMPTY_NUMBERING },
    });
  }

  return {
    hunks,
    shapes: diff.shapes.map((entry) => ({ change: entry.change, shape: entry.shape, assets })),
  };
}

/** 件数 (+n/−n) の集計に渡す形へ戻す。 */
export function proposalContentToAppliedDiff(content: AiProposalContent): AiAppliedDocumentDiff {
  return {
    body: content.hunks.flatMap((hunk) => [
      ...hunk.removed.map((block) => ({ change: "removed" as const, block })),
      ...hunk.added.map((block) => ({ change: "added" as const, block })),
    ]),
    shapes: content.shapes.map(({ change, shape }) => ({ change, shape })),
  };
}

/** 描くものが何も無いか。要約だけの塊 (移動など) は「ある」と数える。 */
export function isProposalContentEmpty(content: AiProposalContent): boolean {
  return content.hunks.length === 0 && content.shapes.length === 0;
}

/**
 * 紙面のカード用に、保留中の提案の本文の塊をアンカーごとに分ける。同じブロックに 2 つの
 * 提案があればカードは 2 枚 (承認・破棄は提案ごとに独立)。図形はキャンバスで決めるので含めない。
 *
 * アンカーが本文に無い塊 (文書に無いブロック・ヘッダーの中など) は、紙面が後ろに置けないので
 * カードにしない。カードが 1 枚もできない提案は、紙面がそのそばに浮かぶバーで決める
 * (`AiPageCanvasEditor`)。
 */
export function groupPendingProposalContentByAnchor(
  previews: AiEditPreviewState[],
  document: SigmaDocument,
): Map<string, AiProposalAnchorCard[]> {
  const cardsByAnchorId = new Map<string, AiProposalAnchorCard[]>();
  let placeable: ReadonlySet<string> | null = null;
  for (const preview of previews) {
    if (!hasBodyAiEditChanges(preview)) {
      continue;
    }
    placeable ??= new Set(indexDocumentFlow(document).flowAnchorById.values());
    const merged = resolveProposalMergePreview(document, preview);
    const mergedWithHumanEdits = merged.humanEditedUnits.length > 0;
    for (const hunk of buildPendingHunks(document, merged.afterDocument, preview)) {
      if (!placeable.has(hunk.anchorBlockId)) {
        continue;
      }
      const cards = cardsByAnchorId.get(hunk.anchorBlockId) ?? [];
      cards.push({ preview, content: { hunks: [hunk], shapes: [] }, mergedWithHumanEdits });
      cardsByAnchorId.set(hunk.anchorBlockId, cards);
    }
  }
  return cardsByAnchorId;
}

// --- 表示用のコピー ---------------------------------------------------------

/** 描画部品に渡す塊。ブロックは塗り分けと id の付け替えを済ませた**表示専用のコピー**。 */
export type AiProposalDisplayHunk = AiProposalContentHunk;

/** 元の背景色 (無ければ透明) を既定値に持つ印付きの値。描かれる背景色は元のまま。 */
function markedBackground(mark: string, node: InlineNode): string {
  return `var(${mark}, ${node.backgroundColor ?? "transparent"})`;
}

function paintRanges(nodes: InlineNode[], ranges: InlineChangeRange[], mark: string): InlineNode[] {
  const rangesByNode = new Map<number, InlineChangeRange[]>();
  for (const range of ranges) {
    const list = rangesByNode.get(range.nodeIndex) ?? [];
    list.push(range);
    rangesByNode.set(range.nodeIndex, list);
  }
  return nodes.flatMap((node, index): InlineNode[] => {
    const nodeRanges = rangesByNode.get(index);
    if (!nodeRanges) {
      return [node];
    }
    if (node.type === "mathInline") {
      return [{ ...node, backgroundColor: markedBackground(mark, node) }];
    }
    const pieces: InlineNode[] = [];
    let cursor = 0;
    for (const range of [...nodeRanges].sort((a, b) => a.start - b.start)) {
      if (range.start > cursor) {
        pieces.push({ ...node, text: node.text.slice(cursor, range.start) });
      }
      if (range.end > Math.max(cursor, range.start)) {
        pieces.push({
          ...node,
          text: node.text.slice(Math.max(cursor, range.start), range.end),
          backgroundColor: markedBackground(mark, node),
        });
      }
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < node.text.length) {
      pieces.push({ ...node, text: node.text.slice(cursor) });
    }
    return pieces;
  });
}

function paintAll(nodes: InlineNode[], mark: string): InlineNode[] {
  return nodes.map((node) => ({ ...node, backgroundColor: markedBackground(mark, node) }));
}

/**
 * 同じ id の置き換え 1 組について、変わった単語/数式だけを塗ったコピーを作る。
 * 行の対応は件数の集計と同じ `pairBlockLines`、単語の比較は `diffInlineNodeRanges`。
 */
function paintReplacePair(removedBlock: EditableBlock, addedBlock: EditableBlock): [EditableBlock, EditableBlock] {
  const removedLines = new Map<string, InlineNode[]>();
  const addedLines = new Map<string, InlineNode[]>();
  for (const { removed, added } of pairBlockLines(removedBlock, addedBlock)) {
    if (removed && added) {
      const ranges = diffInlineNodeRanges(removed.nodes, added.nodes);
      if (ranges.changed) {
        removedLines.set(removed.key, paintRanges(removed.nodes, ranges.removed, AI_PROPOSAL_WORD_HIGHLIGHT.removed));
        addedLines.set(added.key, paintRanges(added.nodes, ranges.added, AI_PROPOSAL_WORD_HIGHLIGHT.added));
      }
    } else if (removed) {
      removedLines.set(removed.key, paintAll(removed.nodes, AI_PROPOSAL_WORD_HIGHLIGHT.removed));
    } else if (added) {
      addedLines.set(added.key, paintAll(added.nodes, AI_PROPOSAL_WORD_HIGHLIGHT.added));
    }
  }
  return [
    removedLines.size > 0 ? mapBlockLineNodes(removedBlock, (key) => removedLines.get(key)) : removedBlock,
    addedLines.size > 0 ? mapBlockLineNodes(addedBlock, (key) => addedLines.get(key)) : addedBlock,
  ];
}

function previewId(id: string): string {
  return `${AI_PROPOSAL_PREVIEW_ID_PREFIX}${id}`;
}

/** すべての `id` (と段組みの段の先頭 id) に接頭辞を付けた深いコピー。 */
function withPreviewIds<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withPreviewIds) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" && typeof child === "string") {
      copy[key] = previewId(child);
    } else if (key === "columnStartIds" && Array.isArray(child)) {
      copy[key] = child.map((id) => (typeof id === "string" ? previewId(id) : id));
    } else {
      copy[key] = withPreviewIds(child);
    }
  }
  return copy as T;
}

function collectIds(value: unknown, ids: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((child) => collectIds(child, ids));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "id" && typeof child === "string") {
        ids.add(child);
      } else {
        collectIds(child, ids);
      }
    }
  }
  return ids;
}

function rekeyNumbering(numbering: AiProposalNumbering, blocks: EditableBlock[]): AiProposalNumbering {
  const problems = new Map<string, number>();
  const headings = new Map<string, string>();
  for (const id of collectIds(blocks, new Set())) {
    const problemNumber = numbering.problems.get(id);
    if (problemNumber !== undefined) {
      problems.set(previewId(id), problemNumber);
    }
    const headingNumber = numbering.headings.get(id);
    if (headingNumber !== undefined) {
      headings.set(previewId(id), headingNumber);
    }
  }
  return { problems, headings };
}

/**
 * 描画用のコピーを作る。(1) 同じ id の置き換えは変わった単語/数式だけを塗る (丸ごとの挿入・削除は
 * 塗らない — 入れ物の地の色で分かる)。(2) すべての id に接頭辞を付け、紙面の本物と同じ
 * `data-sigma-doc-id` を出さない。番号の表も付け替えた id で引けるようにする。
 * 元の塊・ブロック・文書は変えない。
 */
export function toDisplayProposalHunk(hunk: AiProposalContentHunk): AiProposalDisplayHunk {
  const removedById = new Map(hunk.removed.map((block) => [block.id, block]));
  const paintedRemoved = new Map<string, EditableBlock>();
  const added = hunk.added.map((block) => {
    const counterpart = removedById.get(block.id);
    if (!counterpart) {
      return block;
    }
    const [paintedBefore, paintedAfter] = paintReplacePair(counterpart, block);
    paintedRemoved.set(block.id, paintedBefore);
    return paintedAfter;
  });
  const removed = hunk.removed.map((block) => paintedRemoved.get(block.id) ?? block);

  return {
    ...hunk,
    removed: removed.map(withPreviewIds),
    added: added.map(withPreviewIds),
    numbering: {
      removed: rekeyNumbering(hunk.numbering.removed, hunk.removed),
      added: rekeyNumbering(hunk.numbering.added, hunk.added),
    },
  };
}
