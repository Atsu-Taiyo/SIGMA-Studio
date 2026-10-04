import type { SigmaDocument } from "@/features/document";
import { rewriteAiOverlayShapeReplacementDrafts } from "@/lib/ai/overlay-shape-replacement";
import { combineProposalMergeReports, type ProposalMergeReport } from "@/lib/ai/proposal-merge-basis";
import {
  collectReplaceTargetIds,
  orderItemsByReplacementAncestry,
  replayProposalForApproval,
} from "@/lib/ai/proposal-replay";
import { createAiEditSessionDocumentDraft, type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { collectBlocksById } from "@/lib/document-tree";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import { getProblemNumberMap } from "@/lib/problem-numbering";

import { hasBodyAiEditChanges, type AiEditPreviewState, type AiProposalMergeSource } from "./preview";

/**
 * 保留中の提案を「承認したら保存される内容」で見せるための文書。紙面のカード・サイドバー・⌘K の
 * パネルはどれもこれを `buildPendingProposalContent` に渡す (同じ提案・同じ文書なら同じ結果を共有する)。
 *
 * 作り方は承認と同じ: まとめた提案を作成順 (置き換えの親子は親が先) に、それぞれ
 * `replayProposalForApproval` で今の文書へ replay する。base (`mergeBasis`) を持つ提案は三者マージの
 * replay なので、提案の後に人が対象を直していれば、その編集と AI の変更の両方が入った内容になる。
 * 第二の差分計算は持たない。
 *
 * - base を持たない旧レコードだけのまとまりは、従来どおり draft をそのまま今の文書へ適用する。
 * - 合成 replay が適用できないとき (対象の消失など。承認なら競合になる) も、従来どおりの適用を試し、
 *   それもできなければ `null` (内容は draft の中身で代わりに描く)。
 * - 本文を変えない提案 (図形だけ) は使わないので replay しない。
 * - 図形の変更は 250ms 遅れて文書に入る (overlay の debounce)。プレビューはその後の文書で更新され、
 *   承認は直前に flush するので、承認の内容とは食い違わない。
 */
export interface AiProposalMergePreview {
  /** 承認したら保存される文書 (今の文書に提案を replay した結果)。使わない・適用できないときは `null`。 */
  afterDocument: SigmaDocument | null;
  /**
   * 合成で人の編集を取り込んだ単位 (承認の合成 report の `humanEditedUnits` と同じ)。空なら合成は
   * 起きていない (AI の変更だけの内容)。
   */
  humanEditedUnits: readonly string[];
}

const NO_PREVIEW: AiProposalMergePreview = Object.freeze({ afterDocument: null, humanEditedUnits: Object.freeze([]) });

/**
 * 提案ごとに直近の 1 件だけを覚える。文書をキーにすると、取り消し履歴が古い文書を持つ間その適用後の
 * 文書 (構造を共有しない全体のコピー) も解放されず、提案の数だけ積み上がる。
 *
 * 文書が変わっても、提案が読む単位 (対象のブロック・図形・番号) が同じものなら replay し直さない。
 * 打鍵 1 回の手間は「提案の数 × 対象の数」の参照の比較で済む。適用後の文書のうち、内容のモデルが
 * 読むのは対象の単位と番号だけなので、古い文書から作った適用後の文書を使い回しても描く内容は同じ。
 */
interface CacheEntry {
  document: SigmaDocument;
  dependencies: readonly unknown[];
  result: AiProposalMergePreview;
}

const previewCache = new WeakMap<AiEditPreviewState, CacheEntry>();
const dependencyIdsCache = new WeakMap<AiEditPreviewState, DependencyIds>();

export function resolveProposalMergePreview(
  current: SigmaDocument,
  preview: AiEditPreviewState,
): AiProposalMergePreview {
  if (!hasBodyAiEditChanges(preview)) {
    return NO_PREVIEW;
  }
  const cached = previewCache.get(preview);
  if (cached?.document === current) {
    return cached.result;
  }
  const dependencies = readDependencies(current, dependencyIdsOf(preview));
  if (cached && sameDependencies(cached.dependencies, dependencies)) {
    previewCache.set(preview, { ...cached, document: current });
    return cached.result;
  }
  const result = computeMergePreview(current, preview);
  previewCache.set(preview, { document: current, dependencies, result });
  return result;
}

function computeMergePreview(current: SigmaDocument, preview: AiEditPreviewState): AiProposalMergePreview {
  if (preview.mergeSources && preview.mergeSources.length > 0) {
    try {
      const { afterDocument, report } = replayLikeApproval(current, preview.mergeSources);
      return { afterDocument, humanEditedUnits: report.humanEditedUnits };
    } catch {
      // 承認なら競合になる提案。内容は従来どおりの適用で見せ、競合は承認・保存時の判定に任せる。
    }
  }
  try {
    return { afterDocument: createAiEditSessionDocumentDraft(current, null, preview.draft).nextDocument, humanEditedUnits: [] };
  } catch {
    return NO_PREVIEW;
  }
}

/**
 * 一括承認 (`mergeProposalDraftsIntoDocument`) と同じ順序で replay する: 図形の置き換えの組があれば
 * その書き換えをしてから、無ければ置き換えの親子を親が先になるように並べる。1 件でも適用できなければ
 * 投げる (承認ならその提案は保留のまま競合になる)。
 */
function replayLikeApproval(
  current: SigmaDocument,
  sources: readonly AiProposalMergeSource[],
): { afterDocument: SigmaDocument; report: ProposalMergeReport } {
  const replacement = rewriteAiOverlayShapeReplacementDrafts(current, [...sources]);
  const ordered = replacement.pairs.length > 0
    ? replacement.proposals
    : orderItemsByReplacementAncestry(current, [...sources], (source) => collectReplaceTargetIds(source.draft));
  let document = current;
  const reports: ProposalMergeReport[] = [];
  for (const source of ordered) {
    const replayed = replayProposalForApproval(document, source);
    document = replayed.nextDocument;
    reports.push(replayed.report);
  }
  return { afterDocument: document, report: combineProposalMergeReports(reports) };
}

// --- 提案が読む単位 ---------------------------------------------------------

interface DependencyIds {
  blockIds: readonly string[];
  shapeIds: readonly string[];
  /** ページ設定を変える操作がある (ページ設定そのものを読む)。 */
  readsPageLayout: boolean;
  /** 画像を持ち込む挿入がある (今の画像の id と衝突すれば改名する)。 */
  readsAssets: boolean;
}

function dependencyIdsOf(preview: AiEditPreviewState): DependencyIds {
  const cached = dependencyIdsCache.get(preview);
  if (cached) {
    return cached;
  }
  const blockIds = new Set<string>();
  const shapeIds = new Set<string>();
  let readsPageLayout = false;
  let readsAssets = false;
  const drafts: AiEditSessionDraft[] = preview.mergeSources?.map((source) => source.draft) ?? [preview.draft];
  for (const draft of drafts) {
    for (const operation of draft.operations) {
      blockIds.add(operation.targetId);
      if (operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape") {
        const anchor = operation.operation === "insertOverlayShape" ? operation.overlayShape.anchor : operation.tableShape.anchor;
        if (anchor?.type === "block") blockIds.add(anchor.blockId);
        if (anchor?.type === "shape") shapeIds.add(anchor.shapeId);
        if (operation.operation === "insertOverlayShape" && operation.assets && Object.keys(operation.assets).length > 0) {
          readsAssets = true;
        }
      }
    }
    for (const op of draft.mutationOperations ?? []) {
      switch (op.operation) {
        case "deleteBlocks":
        case "wrapBlocksInColumns":
          op.blockIds.forEach((id) => blockIds.add(id));
          break;
        case "moveBlocks":
          op.blockIds.forEach((id) => blockIds.add(id));
          blockIds.add(op.targetId);
          break;
        case "updateLayoutSection":
          blockIds.add(op.sectionId);
          break;
        case "updateOverlayShape":
          shapeIds.add(op.shapeId);
          readsAssets ||= Boolean(op.assets);
          break;
        case "alignOverlayShapes":
        case "deleteOverlayShapes":
          op.shapeIds.forEach((id) => shapeIds.add(id));
          break;
        default:
          readsPageLayout = true;
      }
    }
  }
  for (const source of preview.mergeSources ?? []) {
    for (const [id, entity] of Object.entries(source.mergeBasis?.entities ?? {})) {
      (entity.kind === "block" ? blockIds : shapeIds).add(id);
    }
    Object.keys(source.mergeBasis?.anchors ?? {}).forEach((id) => blockIds.add(id));
  }
  const ids: DependencyIds = {
    blockIds: [...blockIds].sort(),
    shapeIds: [...shapeIds].sort(),
    readsPageLayout,
    readsAssets,
  };
  dependencyIdsCache.set(preview, ids);
  return ids;
}

/** 文書 1 つにつき 1 回だけ作る索引 (直近の 1 件)。提案が何件あっても文書を 1 回しか歩かない。 */
let lastIndex: {
  document: SigmaDocument;
  blocks: ReadonlyMap<string, unknown>;
  shapes: ReadonlyMap<string, unknown>;
  numbering: string;
} | null = null;

function indexOf(document: SigmaDocument) {
  if (lastIndex?.document !== document) {
    lastIndex = {
      document,
      blocks: collectBlocksById(document.content),
      shapes: new Map((document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => [shape.id, shape])),
      numbering: JSON.stringify([
        [...getProblemNumberMap(document.content)],
        [...getHeadingNumberMap(document.content, document.metadata?.headingNumbering)],
      ]),
    };
  }
  return lastIndex;
}

/**
 * 提案の replay と内容が読むものの今の値。ブロック・図形は参照 (打鍵は触っていないブロックの参照を
 * 保つ) で、番号は値で比べる (適用後の番号を、別の場所の問題・見出しの増減が変える)。
 */
function readDependencies(document: SigmaDocument, ids: DependencyIds): unknown[] {
  const index = indexOf(document);
  return [
    index.numbering,
    ids.readsPageLayout ? document.pageLayout : null,
    ids.readsAssets ? document.pageLayout?.overlay?.overlaySnapshot?.assets : null,
    ...ids.blockIds.map((id) => index.blocks.get(id)),
    ...ids.shapeIds.map((id) => index.shapes.get(id)),
  ];
}

function sameDependencies(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
