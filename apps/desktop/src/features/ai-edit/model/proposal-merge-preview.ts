import { PROBLEM_AREA_ORDER, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { mergeProposalDraftsIntoDocument } from "@/lib/ai/proposal-batch-replay";
import { createAiEditSessionDocumentDraft, type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { collectBlocksById } from "@/lib/document-tree";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import { countPerformanceEvent } from "@/lib/performance";
import { getProblemNumberMap } from "@/lib/problem-numbering";

import { hasBodyAiEditChanges, type AiEditPreviewState } from "./preview";

/**
 * 保留中の提案を「承認したら保存される内容」で見せるための文書。紙面のカード・サイドバー・⌘K の
 * パネルはどれもこれを `buildPendingProposalContent` に渡す (同じ提案・同じ文書なら同じ結果を共有する)。
 *
 * 作り方は一括承認と同じ関数 (`mergeProposalDraftsIntoDocument`): まとめた提案を作成順 (置き換えの
 * 親子は親が先) に、それぞれ `replayProposalForApproval` で今の文書へ replay し、適用できない提案だけを
 * 飛ばす (承認ならその提案は競合として保留に残る)。base (`mergeBasis`) を持つ提案は三者マージの
 * replay なので、提案の後に人が対象を直していれば、その編集と AI の変更の両方が入った内容になる。
 * 第二の差分計算は持たない。
 *
 * - base を持たない旧レコードだけのまとまりは、従来どおり draft をそのまま今の文書へ適用する。
 * - どの提案も合成 replay で適用できないとき (承認ならまとまり全体が競合) は、従来どおりの適用を試し、
 *   それもできなければ `null` (内容は draft の中身で代わりに描く)。どちらの代わりの経路も、提案がその
 *   状態に入ったときに 1 回数える (`AI_PROPOSAL_PREVIEW_COUNTERS`、MISS R3。同じ状態のまま作り直しても
 *   数え直さない)。承認が文書を差し替えている間は数えない
 *   (承認済みの提案が一覧の再取得まで承認後の文書に重ねて描かれ、挿入の id が既にあるなどで必ず失敗する)。
 * - 本文を変えない提案 (図形だけ) も、base を持てば合成 replay する。図形は紙面に draft から描くが、AI が
 *   消す図形を人が直したときに合成で残るかどうか (`collectShapesKeptByMerge`) と、人の編集と合わせた
 *   単位はこの結果から読む。base を持たない図形だけの提案は使わないので replay しない。
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
 * プレビューが合成 replay を使えない状態に入った回数 (正常な操作では 0。`proposal-merge-metrics.ts` と
 * 同じ流儀)。その状態のまま作り直しても数え直さず、抜けてからまた入れば数える。
 */
export const AI_PROPOSAL_PREVIEW_COUNTERS = {
  /** 合成 replay で 1 件も適用できず、draft をそのまま適用した内容で見せた。 */
  fallback: "AiProposalMerge.previewFallback",
  /** どの経路でも適用できず、内容を draft の中身で代わりに描いた。 */
  noPreview: "AiProposalMerge.previewNoPreview",
} as const;

export interface ResolveProposalMergePreviewOptions {
  /** 代わりの経路を数えるか。承認が文書を差し替えている間 (`applying`) は false を渡す。既定は true。 */
  countFallbacks?: boolean;
  /** 数える先 (テスト用)。既定は `countPerformanceEvent`。 */
  count?: (name: string) => void;
}

/**
 * 提案ごとに直近の 1 件だけを覚える。文書をキーにすると、取り消し履歴が古い文書を持つ間その適用後の
 * 文書 (構造を共有しない全体のコピー) も解放されず、提案の数だけ積み上がる。
 *
 * 文書が変わっても、提案が読む単位 (対象のブロック・図形とその入れ物、挿入の付け替え先、番号) が
 * 同じものなら replay し直さない。
 * 打鍵 1 回の手間は「提案の数 × 対象の数」の参照の比較で済む。適用後の文書のうち、内容のモデルが
 * 読むのは対象の単位と番号だけなので、古い文書から作った適用後の文書を使い回しても描く内容は同じ。
 */
interface CacheEntry {
  document: SigmaDocument;
  dependencies: readonly unknown[];
  result: AiProposalMergePreview;
  /** この結果を作るのに通った代わりの経路 (`AI_PROPOSAL_PREVIEW_COUNTERS`)。 */
  fallbacks: readonly string[];
}

const previewCache = new WeakMap<AiEditPreviewState, CacheEntry>();
const dependencyIdsCache = new WeakMap<AiEditPreviewState, DependencyIds>();

export function resolveProposalMergePreview(
  current: SigmaDocument,
  preview: AiEditPreviewState,
  options: ResolveProposalMergePreviewOptions = {},
): AiProposalMergePreview {
  if (!hasBodyAiEditChanges(preview) && !preview.mergeSources?.length) {
    return NO_PREVIEW;
  }
  const cached = previewCache.get(preview);
  if (cached?.document === current) {
    noteFallbacks(preview, cached.fallbacks, options);
    return cached.result;
  }
  const dependencies = readDependencies(current, dependencyIdsOf(preview));
  if (cached && sameDependencies(cached.dependencies, dependencies)) {
    previewCache.set(preview, { ...cached, document: current });
    noteFallbacks(preview, cached.fallbacks, options);
    return cached.result;
  }
  const { result, fallbacks } = computeMergePreview(current, preview);
  previewCache.set(preview, { document: current, dependencies, result, fallbacks });
  noteFallbacks(preview, fallbacks, options);
  return result;
}

/**
 * 提案ごとに、いま入っていて数え済みの代わりの経路。プレビューのオブジェクトは一覧の取り直し (自動保存の
 * あとなど) で作り直されるので、提案の id で持つ。数えるのは代わりの経路に「入った」ときだけ: 保留中の
 * 対象は人が直せる (消せる) ので、対象が消えたまま作り直すたびに数えると退避の回数がノイズになる。
 * 数えない呼び出し (承認中・消えるアニメーション) は観測しても記録しないので、そのあと数える呼び出しが
 * 初回として数える。抜けた (数える呼び出しで退避が無かった) ら忘れ、また入れば数える。
 */
const countedFallbacksByProposal = new Map<string, ReadonlySet<string>>();

function noteFallbacks(
  preview: AiEditPreviewState,
  fallbacks: readonly string[],
  options: ResolveProposalMergePreviewOptions,
): void {
  if (options.countFallbacks === false) {
    return;
  }
  const key = preview.proposalIds.join("\u0000");
  const counted = countedFallbacksByProposal.get(key);
  if (fallbacks.length === 0) {
    countedFallbacksByProposal.delete(key);
    return;
  }
  const count = options.count ?? countPerformanceEvent;
  fallbacks.filter((name) => !counted?.has(name)).forEach((name) => count(name));
  countedFallbacksByProposal.set(key, new Set(fallbacks));
}

function computeMergePreview(
  current: SigmaDocument,
  preview: AiEditPreviewState,
): { result: AiProposalMergePreview; fallbacks: string[] } {
  const fallbacks: string[] = [];
  if (preview.mergeSources && preview.mergeSources.length > 0) {
    const merged = mergeProposalDraftsIntoDocument(current, preview.mergeSources);
    if (merged.appliedIds.length > 0) {
      return { result: { afterDocument: merged.document, humanEditedUnits: merged.report.humanEditedUnits }, fallbacks };
    }
    // 承認ならまとまり全体が競合になる。内容は従来どおりの適用で見せ、競合は承認・保存時の判定に任せる。
    fallbacks.push(AI_PROPOSAL_PREVIEW_COUNTERS.fallback);
  }
  try {
    return {
      result: { afterDocument: createAiEditSessionDocumentDraft(current, null, preview.draft).nextDocument, humanEditedUnits: [] },
      fallbacks,
    };
  } catch {
    fallbacks.push(AI_PROPOSAL_PREVIEW_COUNTERS.noPreview);
    return { result: NO_PREVIEW, fallbacks };
  }
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
    // 挿入のアンカーが消えたときの付け替え先 (直前にあった兄弟) も読む。
    for (const [id, anchor] of Object.entries(source.mergeBasis?.anchors ?? {})) {
      blockIds.add(id);
      anchor.precedingIds.forEach((precedingId) => blockIds.add(precedingId));
    }
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
  containers: ReadonlyMap<string, unknown>;
  shapes: ReadonlyMap<string, unknown>;
  numbering: string;
} | null = null;

/**
 * 入れ子のブロック id → それを持つ入れ物の値。リストの項目はリスト自身 (種類・開始番号・項目の並びで
 * 番号が決まる)、それ以外は兄弟の配列 (問題の区分・箱・引用・段組みの段)。最上位のブロックは入れない
 * (本文全体の配列は打鍵のたびに作り直される)。
 */
function indexContainers(content: readonly SigmaBlock[]): Map<string, unknown> {
  const containers = new Map<string, unknown>();
  const visitChildren = (children: unknown, container: unknown) => {
    if (!Array.isArray(children)) {
      return;
    }
    for (const child of children) {
      if (isRecord(child) && typeof child.id === "string") {
        containers.set(child.id, container);
        visit(child);
      }
    }
  };
  const visit = (block: Record<string, unknown>) => {
    switch (block.type) {
      case "problem":
        PROBLEM_AREA_ORDER.forEach((area) => visitChildren(block[area], block[area]));
        return;
      case "layoutSection":
        visitChildren(block.children, block.children);
        return;
      case "boxBlock":
      case "quote":
        visitChildren(block.blocks, block.blocks);
        return;
      case "list":
        visitChildren(block.items, block);
        return;
      case "listItem":
        visitChildren(block.continuations, block.continuations);
        visitChildren(block.nested, block.nested);
        return;
      default:
        return;
    }
  };
  content.forEach((block) => visit(block as unknown as Record<string, unknown>));
  return containers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexOf(document: SigmaDocument) {
  if (lastIndex?.document !== document) {
    lastIndex = {
      document,
      blocks: collectBlocksById(document.content),
      containers: indexContainers(document.content),
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
 * 提案の replay と内容が読むものの今の値。ブロック・図形とその入れ物は参照 (打鍵は触っていない
 * ブロックの参照を保つ) で、番号は値で比べる (適用後の番号を、別の場所の問題・見出しの増減が変える)。
 * 入れ物を読むのは、適用後の文書から読むリストの番号や区分の位置が、対象そのものが同じでも兄弟の
 * 増減で変わるため。
 */
function readDependencies(document: SigmaDocument, ids: DependencyIds): unknown[] {
  const index = indexOf(document);
  return [
    index.numbering,
    ids.readsPageLayout ? document.pageLayout : null,
    ids.readsAssets ? document.pageLayout?.overlay?.overlaySnapshot?.assets : null,
    ...ids.blockIds.flatMap((id) => [index.blocks.get(id), index.containers.get(id)]),
    ...ids.shapeIds.map((id) => index.shapes.get(id)),
  ];
}

function sameDependencies(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
