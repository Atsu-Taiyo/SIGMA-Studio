import { isDeepStrictEqual } from "node:util";
import {
  isAdditiveInsertOnlyDraft,
  resolveAiEditSessionOperationOrder,
  type AiEditSessionDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import { isOverlayAnchorSupportDraft } from "@/lib/ai/applied-document-diff";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { type EditableBlock } from "@/lib/document-tree";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import {
  type LocalMcpEditProposalTouchedBlock,
  type ProposalFreshnessConflict,
  type LocalMcpEditProposalRequestSelection,
  type LocalMcpEditProposal,
} from "./contracts";

export function canForceApplyProposalConflict(conflict: ProposalFreshnessConflict | null): boolean {
  return conflict?.reason === "content-stale";
}

// aiAutoApplyVerifiedProposals 設定がONのとき、新規/既存の pending 提案を自動承認してよいかの
// 純粋な判定。main.ts の watch コールバックから呼ばれる (ファイルIO・保存は main.ts 側の責務)。
// テスト容易性のため、設定読み込み・現在revisionの取得ロジックからここを切り離してある。
export function shouldAutoApplyProposal(params: {
  settingEnabled: boolean;
  proposal: Pick<LocalMcpEditProposal, "status" | "verification" | "baseRevision" | "conflict">;
  currentRevision: number;
}): boolean {
  return (
    params.settingEnabled &&
    params.proposal.status === "pending" &&
    params.proposal.verification?.validationOk === true &&
    params.proposal.baseRevision === params.currentRevision &&
    !params.proposal.conflict
  );
}

export function collectRequiredInsertAnchorBlockIds(draft: AiEditSessionDraft): string[] {
  const createdIds = new Set<string>();
  const ids = new Set<string>();
  for (const orderEntry of resolveAiEditSessionOperationOrder(draft)) {
    if (orderEntry.kind !== "operation") {
      continue;
    }
    const operation = draft.operations[orderEntry.index];
    if (operation.operation === undefined || operation.operation === "replace") {
      collectEditableBlockTreeIds(operation.replacementBlock).forEach((id) => createdIds.add(id));
      continue;
    }
    if (
      operation.operation !== "insertAfter"
      && operation.operation !== "insertTableShape"
      && operation.operation !== "insertOverlayShape"
    ) {
      continue;
    }
    if (!createdIds.has(operation.targetId)) {
      ids.add(operation.targetId);
    }
    if (operation.operation === "insertTableShape") {
      if (operation.tableShape.anchor?.type === "block") {
        if (!createdIds.has(operation.tableShape.anchor.blockId)) {
          ids.add(operation.tableShape.anchor.blockId);
        }
      } else if (operation.tableShape.anchor?.type === "shape") {
        if (!createdIds.has(operation.tableShape.anchor.shapeId)) {
          ids.add(operation.tableShape.anchor.shapeId);
        }
      }
    } else if (operation.operation === "insertOverlayShape") {
      if (operation.overlayShape.anchor?.type === "block") {
        if (!createdIds.has(operation.overlayShape.anchor.blockId)) {
          ids.add(operation.overlayShape.anchor.blockId);
        }
      } else if (operation.overlayShape.anchor?.type === "shape") {
        if (!createdIds.has(operation.overlayShape.anchor.shapeId)) {
          ids.add(operation.overlayShape.anchor.shapeId);
        }
      }
    }
    if (operation.operation === "insertAfter") {
      createdIds.add(operation.insertedBlock.id);
    } else if (operation.operation === "insertTableShape") {
      createdIds.add(operation.tableShape.id);
    } else {
      createdIds.add(operation.overlayShape.id);
    }
  }
  return [...ids];
}

function collectEditableBlockTreeIds(block: EditableBlock): string[] {
  const ids = [block.id];
  if (block.type === "problem") {
    for (const child of [...block.lead, ...block.prompt, ...block.solution, ...block.hints]) {
      ids.push(...collectEditableBlockTreeIds(child));
    }
  } else if (block.type === "layoutSection") {
    for (const child of block.children) {
      ids.push(...collectEditableBlockTreeIds(child));
    }
  } else if (block.type === "boxBlock") {
    for (const child of block.blocks) {
      ids.push(...collectEditableBlockTreeIds(child));
    }
  } else if (block.type === "list") {
    for (const item of block.items) {
      ids.push(...collectEditableBlockTreeIds(item));
    }
  } else if (block.type === "listItem") {
    for (const nested of block.nested ?? []) {
      ids.push(...collectEditableBlockTreeIds(nested));
    }
  }
  return ids;
}

export function collectOccupiedInsertIds(
  draft: AiEditSessionDraft,
  currentHashes: Record<string, string>,
): string[] {
  const deletedIds = new Set<string>();
  const occupiedIds = new Set<string>();
  for (const orderEntry of resolveAiEditSessionOperationOrder(draft)) {
    if (orderEntry.kind === "mutation") {
      const mutation = draft.mutationOperations?.[orderEntry.index];
      if (mutation?.operation === "deleteBlocks") {
        mutation.blockIds.forEach((id) => deletedIds.add(id));
      } else if (mutation?.operation === "deleteOverlayShapes") {
        mutation.shapeIds.forEach((id) => deletedIds.add(id));
      }
      continue;
    }
    const operation = draft.operations[orderEntry.index];
    const insertedId = operation.operation === "insertAfter"
      ? operation.insertedBlock.id
      : operation.operation === "insertTableShape"
        ? operation.tableShape.id
        : operation.operation === "insertOverlayShape"
          ? operation.overlayShape.id
          : null;
    if (insertedId && currentHashes[insertedId] !== undefined && !deletedIds.has(insertedId)) {
      occupiedIds.add(insertedId);
    }
  }
  return [...occupiedIds];
}

/**
 * draft (AiEditSessionDraft) の操作列から「IDで触りうる対象」を列挙する: replace/insertAfter/
 * insertTableShape/insertOverlayShape の targetId (置換対象、または挿入アンカー = 既存ブロック)、
 * insertAfter/insertTableShape/insertOverlayShape が新規に作る insertedBlock/tableShape/
 * overlayShape の id (baseDocument 時点にはまだ存在しない新規ID)、そして deleteBlocks/
 * moveBlocks/updateOverlayShape/alignOverlayShapes/deleteOverlayShapes/wrapBlocksInColumns/
 * updateLayoutSection の対象ID + moveBlocks の移動先アンカー targetId。文書全体の段組み
 * (setDocumentColumns) はIDを持たない。呼び出し順で重複しうるため呼び出し元が dedupe する
 * 前提の生リスト。
 */
export function collectTouchedBlockIds(draft: AiEditSessionDraft): string[] {
  const ids: string[] = [];
  const push = (id: string | undefined | null): void => {
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
    }
  };

  for (const operation of draft.operations) {
    push(operation.targetId);
    if (operation.operation === "insertAfter") {
      push(operation.insertedBlock.id);
    } else if (operation.operation === "insertTableShape") {
      push(operation.tableShape.id);
    } else if (operation.operation === "insertOverlayShape") {
      push(operation.overlayShape.id);
    }
  }

  for (const operation of draft.mutationOperations ?? []) {
    if (operation.operation === "deleteBlocks") {
      operation.blockIds.forEach(push);
    } else if (operation.operation === "moveBlocks") {
      operation.blockIds.forEach(push);
      push(operation.targetId);
    } else if (operation.operation === "updateOverlayShape") {
      push(operation.shapeId);
    } else if (operation.operation === "alignOverlayShapes" || operation.operation === "deleteOverlayShapes") {
      operation.shapeIds.forEach(push);
    } else if (operation.operation === "wrapBlocksInColumns") {
      operation.blockIds.forEach(push);
    } else if (operation.operation === "updateLayoutSection") {
      push(operation.sectionId);
    }
  }

  return Array.from(new Set(ids));
}

/**
 * 提案を現在のSigmaDocへreplayするとき、内容の上書き・削除が起きる既存IDだけを返す。
 *
 * insertAfter / insertTableShape / insertOverlayShape は既存内容を上書きしない追加操作なので、
 * 挿入アンカーの文章や依頼時の選択範囲が変わっただけでは競合にしない。アンカー削除や新規IDの
 * 重複は replay 自体が正確に検出する。moveBlocks / wrapBlocksInColumns も内容を保持するため、
 * 内容ハッシュの変化は競合理由にしない。
 */
export function collectConflictSensitiveBlockIds(draft: AiEditSessionDraft): string[] {
  const ids: string[] = [];
  const push = (id: string): void => {
    if (id.length > 0) {
      ids.push(id);
    }
  };

  for (const operation of draft.operations) {
    if ((operation.operation === undefined || operation.operation === "replace")
      && !isOverlayAnchorSupportDraft(operation, draft.operations)) {
      push(operation.targetId);
    }
  }

  for (const operation of draft.mutationOperations ?? []) {
    if (operation.operation === "deleteBlocks") {
      operation.blockIds.forEach(push);
    } else if (operation.operation === "updateOverlayShape") {
      push(operation.shapeId);
    } else if (operation.operation === "alignOverlayShapes" || operation.operation === "deleteOverlayShapes") {
      operation.shapeIds.forEach(push);
    } else if (operation.operation === "updateLayoutSection") {
      push(operation.sectionId);
    }
  }

  return Array.from(new Set(ids));
}

/**
 * collectTouchedBlockIds が返したID群を baseDocument に対してハッシュ化し、
 * LocalMcpEditProposal.touchedBlocks の形にする。baseDocument にまだ存在しないID
 * (insertAfter等が新規に作るブロック/図形) は baseHash: null として記録する。
 */
export function computeTouchedBlocks(
  draft: AiEditSessionDraft,
  baseDocument: SigmaDocument,
): LocalMcpEditProposalTouchedBlock[] {
  const ids = collectTouchedBlockIds(draft);
  if (ids.length === 0) {
    return [];
  }
  const hashes = computeDocumentBlockHashes(baseDocument);
  return ids.map((id) => ({ id, baseHash: hashes[id] ?? null }));
}

/**
 * touchedBlocks のうち、currentDocument 上のハッシュが baseHash と食い違っているIDを返す。
 * 空配列 = touchedBlocks が指す対象はすべて baseDocument 時点から変わっていない (安全に
 * replay してよい)。requestSelection を持たないレガシー提案のフォールバック判定として、
 * findProposalFreshnessConflictIds と reconcileStaleExpectedRevision (MCP write path) が使う。
 */
export function findConflictingBlockIds(
  touchedBlocks: LocalMcpEditProposalTouchedBlock[],
  currentHashes: Record<string, string>,
): string[] {
  return touchedBlocks
    .filter((touched) => (currentHashes[touched.id] ?? null) !== touched.baseHash)
    .map((touched) => touched.id);
}

/**
 * requestSelection (依頼時の選択範囲スナップショット) のうち、現在の内容が依頼時から変わっている
 * IDを返す。draft/touchedBlocksを持たない旧提案のフォールバック用。
 */
export function findRequestSelectionConflictIds(
  requestSelection: LocalMcpEditProposalRequestSelection,
  currentHashes: Record<string, string>,
): string[] {
  return requestSelection.blockIds
    .filter((id) => (currentHashes[id] ?? null) !== (requestSelection.hashes[id] ?? null));
}

/**
 * 承認/自動rebase共通の鮮度(衝突)判定。
 *
 * draftとtouchedBlocksを持つ提案は「実際に上書き・削除・更新する対象」だけを比較する。
 * 追加操作のアンカーや依頼時の選択範囲が変わっただけでは競合にせず、最新SigmaDocへのreplayを
 * 試す。旧提案でこの精密判定ができない場合だけ requestSelection、さらに touchedBlocks の順に
 * フォールバックする。空配列 = 衝突なし (そのままreplay/自動追従してよい)。
 */
export function findProposalFreshnessConflictIds(
  proposal: Pick<LocalMcpEditProposal, "requestSelection" | "touchedBlocks" | "baseRevision" | "invalidReason"> & {
    draft?: AiEditSessionDraft;
  },
  currentHashes: Record<string, string>,
  currentRevision: number,
  currentDocument?: SigmaDocument,
): string[] {
  return findProposalFreshnessConflict(
    proposal,
    currentHashes,
    currentRevision,
    currentDocument,
  )?.blockIds ?? [];
}

export function findProposalFreshnessConflict(
  proposal: Pick<LocalMcpEditProposal, "requestSelection" | "touchedBlocks" | "baseRevision" | "invalidReason"> & {
    draft?: AiEditSessionDraft;
  },
  currentHashes: Record<string, string>,
  currentRevision: number,
  currentDocument?: SigmaDocument,
): ProposalFreshnessConflict | null {
  if (proposal.invalidReason) {
    return { blockIds: [], reason: "replay-failed" };
  }
  // 部分段組みだけの提案は本文内容を変更しない。選択箇所の文章が変わっていても、現在の
  // 開始〜終了範囲を包めれば安全なので、内容ハッシュでは競合にしない。アンカー削除・移動などの
  // 構造不整合は replayProposalDraft の範囲解決で検出する。
  if (proposal.draft && isLocalColumnLayoutOnlyDraft(proposal.draft)) {
    return null;
  }
  const assetCollisionIds = proposal.draft && currentDocument
    ? findNonIdenticalOverlayAssetCollisionIds(proposal.draft, currentDocument)
    : [];
  if (assetCollisionIds.length > 0) {
    return { blockIds: assetCollisionIds, reason: "asset-collision" };
  }
  const missingInsertAnchorIds = proposal.draft
    ? collectRequiredInsertAnchorBlockIds(proposal.draft)
      .filter((id) => currentHashes[id] === undefined)
    : [];
  const occupiedInsertIds = proposal.draft
    ? collectOccupiedInsertIds(proposal.draft, currentHashes)
    : [];
  if (occupiedInsertIds.length > 0) {
    return { blockIds: occupiedInsertIds, reason: "replay-failed" };
  }
  if (proposal.draft && isAdditiveInsertOnlyDraft(proposal.draft, currentDocument)) {
    return missingInsertAnchorIds.length > 0
      ? { blockIds: missingInsertAnchorIds, reason: "anchor-missing" }
      : null;
  }
  if (proposal.draft && proposal.touchedBlocks) {
    const sensitiveIds = new Set(collectConflictSensitiveBlockIds(proposal.draft));
    if (sensitiveIds.size === 0) {
      return missingInsertAnchorIds.length > 0
        ? { blockIds: missingInsertAnchorIds, reason: "anchor-missing" }
        : null;
    }
    const sensitiveTouchedBlocks = proposal.touchedBlocks.filter((touched) => sensitiveIds.has(touched.id));
    if (sensitiveTouchedBlocks.length === sensitiveIds.size) {
      if (missingInsertAnchorIds.length > 0) {
        return { blockIds: missingInsertAnchorIds, reason: "anchor-missing" };
      }
      const contentConflictIds = findConflictingBlockIds(sensitiveTouchedBlocks, currentHashes);
      return contentConflictIds.length > 0
        ? { blockIds: contentConflictIds, reason: "content-stale" }
        : null;
    }
    // 破損した旧レコードなどで上書き対象のbaseHashが欠けている場合は、安全側の旧判定へ戻す。
  }
  if (proposal.requestSelection) {
    if (proposal.draft) {
      const sensitiveDraftIds = new Set(collectConflictSensitiveBlockIds(proposal.draft));
      const restrictedSelection: LocalMcpEditProposalRequestSelection = {
        blockIds: proposal.requestSelection.blockIds.filter((id) => sensitiveDraftIds.has(id)),
        hashes: proposal.requestSelection.hashes,
        capturedRevision: proposal.requestSelection.capturedRevision,
      };
      if (restrictedSelection.blockIds.length === 0) {
        return missingInsertAnchorIds.length > 0
          ? { blockIds: missingInsertAnchorIds, reason: "anchor-missing" }
          : null;
      }
      if (missingInsertAnchorIds.length > 0) {
        return { blockIds: missingInsertAnchorIds, reason: "anchor-missing" };
      }
      const contentConflictIds = findRequestSelectionConflictIds(restrictedSelection, currentHashes);
      return contentConflictIds.length > 0
        ? { blockIds: contentConflictIds, reason: "content-stale" }
        : null;
    }
    const contentConflictIds = findRequestSelectionConflictIds(proposal.requestSelection, currentHashes);
    return contentConflictIds.length > 0
      ? { blockIds: contentConflictIds, reason: "content-stale" }
      : null;
  }
  if (proposal.baseRevision !== currentRevision && proposal.touchedBlocks?.length) {
    const contentConflictIds = findConflictingBlockIds(proposal.touchedBlocks, currentHashes);
    return contentConflictIds.length > 0
      ? { blockIds: contentConflictIds, reason: "content-stale" }
      : null;
  }
  return null;
}

export function classifyProposalReplayFailure(
  proposal: Pick<LocalMcpEditProposal, "draft">,
  document: SigmaDocument,
): ProposalFreshnessConflict {
  const currentHashes = computeDocumentBlockHashes(document);
  const missingIds = collectRequiredReplayTargetIds(proposal.draft)
    .filter((id) => currentHashes[id] === undefined);
  return missingIds.length > 0
    ? { blockIds: missingIds, reason: "anchor-missing" }
    : { blockIds: [], reason: "replay-failed" };
}

function collectRequiredReplayTargetIds(draft: AiEditSessionDraft): string[] {
  const ids: string[] = draft.operations.map((operation) => operation.targetId);
  for (const operation of draft.mutationOperations ?? []) {
    if (operation.operation === "deleteBlocks" || operation.operation === "wrapBlocksInColumns") {
      ids.push(...operation.blockIds);
    } else if (operation.operation === "moveBlocks") {
      ids.push(...operation.blockIds, operation.targetId);
    } else if (operation.operation === "updateOverlayShape") {
      ids.push(operation.shapeId);
    } else if (operation.operation === "alignOverlayShapes" || operation.operation === "deleteOverlayShapes") {
      ids.push(...operation.shapeIds);
    } else if (operation.operation === "updateLayoutSection") {
      ids.push(operation.sectionId);
    }
  }
  return Array.from(new Set(ids));
}

function findNonIdenticalOverlayAssetCollisionIds(
  draft: AiEditSessionDraft,
  currentDocument: SigmaDocument,
): string[] {
  const assets = {
    ...normalizeOverlaySnapshot(currentDocument.pageLayout?.overlay?.overlaySnapshot).assets,
  };
  const collisions: string[] = [];
  for (const operation of draft.operations) {
    if (operation.operation !== "insertOverlayShape") {
      continue;
    }
    for (const [assetId, asset] of Object.entries(operation.assets ?? {})) {
      const existingAsset = assets[assetId];
      if (existingAsset && !isDeepStrictEqual(existingAsset, asset)) {
        collisions.push(assetId);
        continue;
      }
      assets[assetId] = asset;
    }
  }
  return Array.from(new Set(collisions));
}

export function collectLocalColumnRangeAnchorIds(draft: AiEditSessionDraft): string[] {
  const ids = new Set<string>();
  for (const operation of draft.mutationOperations ?? []) {
    if (operation.operation !== "wrapBlocksInColumns") {
      continue;
    }
    const startBlockId = operation.blockIds[0];
    const endBlockId = operation.blockIds.at(-1);
    if (startBlockId) {
      ids.add(startBlockId);
    }
    if (endBlockId) {
      ids.add(endBlockId);
    }
  }
  return [...ids];
}

function isLocalColumnLayoutOnlyDraft(draft: AiEditSessionDraft): boolean {
  const mutationOperations = draft.mutationOperations ?? [];
  return draft.operations.length === 0
    && mutationOperations.length > 0
    && mutationOperations.every((operation) => operation.operation === "wrapBlocksInColumns");
}
