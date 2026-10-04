import type {
  OverlayShape,
  SigmaDocument,
} from "@/features/document";
import { findBlock, type EditableBlock } from "@/lib/document-tree";
import type { AiEditDraft, AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";

export type AiAppliedDiffChange = "added" | "removed";

export interface AiAppliedBodyDiffEntry {
  change: AiAppliedDiffChange;
  block: EditableBlock;
}

export interface AiAppliedShapeDiffEntry {
  change: AiAppliedDiffChange;
  shape: OverlayShape;
}

/**
 * 適用直前・直後のSigmaDocから切り出した、AI編集の実データ差分。
 * 説明文や操作名は持たず、GitHub風表示に必要な削除前／追加後ノードだけを保持する。
 */
export interface AiAppliedDocumentDiff {
  body: AiAppliedBodyDiffEntry[];
  shapes: AiAppliedShapeDiffEntry[];
}

/**
 * 図形挿入先を作るためだけの空段落は、ユーザーが依頼した本文変更ではない。
 * 本文内プレビューと適用後差分の両方から同じ判定で除外する。
 */
/**
 * 「図形の挿入先を作るための空段落」を表す要約の、言語ごとの前後。
 *
 * **この要約を書くのはモデル本人**で、リポジトリ内にこの文を指示している箇所は無い
 * (プロンプトにも MCP のツール説明にも無い)。つまりこの判定は元々「モデルがたまたま
 * この文を書いたら効く」という当てにならない作りで、WI-8 でプロンプトが英語になると
 * 日本語だけ見ていては永久に当たらなくなる。**本来は要約の文字列ではなく draft 側の
 * 構造 (種別フィールド) で表すべきもの**で、そこまでは WI-8 の範囲外なので、
 * さしあたり両方の言語で拾えるようにしてある。
 */
const ANCHOR_SUPPORT_SUMMARY_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["図形の挿入先として問題の", "に空行を追加しました。"],
  ["Added a blank paragraph to the problem's", "as an insertion point for the shape."],
];

export function isOverlayAnchorSupportDraft(
  operation: AiEditDraft,
  operations: AiEditDraft[],
): boolean {
  const summary = operation.summary.trim();
  const matchesMarker = ANCHOR_SUPPORT_SUMMARY_MARKERS.some(([head, tail]) => (
    summary.startsWith(head) && summary.endsWith(tail)
  ));
  if (operation.operation !== "replace" || !matchesMarker) {
    return false;
  }
  return operations.some((candidate) => (
    candidate.operation === "insertOverlayShape" || candidate.operation === "insertTableShape"
  ));
}

function pushUnique(ids: string[], seen: Set<string>, id: string): void {
  if (!id || seen.has(id)) {
    return;
  }
  seen.add(id);
  ids.push(id);
}

/**
 * 承認時に保存したbefore/after文書から、提案が実際に触ったIDだけを抽出する。
 * replace/update/moveは削除行と追加行の対として表し、見た目をGitHub差分と揃える。
 */
export function deriveAppliedDocumentDiff(
  before: SigmaDocument,
  after: SigmaDocument,
  drafts: AiEditSessionDraft[],
): AiAppliedDocumentDiff {
  const removedBodyIds: string[] = [];
  const addedBodyIds: string[] = [];
  const removedShapeIds: string[] = [];
  const addedShapeIds: string[] = [];
  const removedBodySeen = new Set<string>();
  const addedBodySeen = new Set<string>();
  const removedShapeSeen = new Set<string>();
  const addedShapeSeen = new Set<string>();

  for (const draft of drafts) {
    for (const operation of draft.operations) {
      if (isOverlayAnchorSupportDraft(operation, draft.operations)) {
        continue;
      }
      if (operation.operation === undefined || operation.operation === "replace") {
        pushUnique(removedBodyIds, removedBodySeen, operation.targetId);
        pushUnique(addedBodyIds, addedBodySeen, operation.replacementBlock.id);
      } else if (operation.operation === "insertAfter") {
        pushUnique(addedBodyIds, addedBodySeen, operation.insertedBlock.id);
      } else if (operation.operation === "insertOverlayShape") {
        pushUnique(addedShapeIds, addedShapeSeen, operation.overlayShape.id);
      } else if (operation.operation === "insertTableShape") {
        pushUnique(addedShapeIds, addedShapeSeen, operation.tableShape.id);
      }
    }

    for (const operation of draft.mutationOperations ?? []) {
      if (operation.operation === "deleteBlocks") {
        operation.blockIds.forEach((id) => pushUnique(removedBodyIds, removedBodySeen, id));
      } else if (operation.operation === "moveBlocks") {
        operation.blockIds.forEach((id) => {
          pushUnique(removedBodyIds, removedBodySeen, id);
          pushUnique(addedBodyIds, addedBodySeen, id);
        });
      } else if (operation.operation === "updateOverlayShape") {
        pushUnique(removedShapeIds, removedShapeSeen, operation.shapeId);
        pushUnique(addedShapeIds, addedShapeSeen, operation.shapeId);
      } else if (operation.operation === "alignOverlayShapes") {
        operation.shapeIds.forEach((id) => {
          pushUnique(removedShapeIds, removedShapeSeen, id);
          pushUnique(addedShapeIds, addedShapeSeen, id);
        });
      } else if (operation.operation === "deleteOverlayShapes") {
        operation.shapeIds.forEach((id) => pushUnique(removedShapeIds, removedShapeSeen, id));
      } else if (operation.operation === "wrapBlocksInColumns") {
        operation.blockIds.forEach((id) => {
          pushUnique(removedBodyIds, removedBodySeen, id);
          pushUnique(addedBodyIds, addedBodySeen, id);
        });
      } else if (operation.operation === "updateLayoutSection") {
        pushUnique(removedBodyIds, removedBodySeen, operation.sectionId);
        pushUnique(addedBodyIds, addedBodySeen, operation.sectionId);
      }
    }
  }

  const beforeShapes = new Map(
    (before.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => [shape.id, shape]),
  );
  const afterShapes = new Map(
    (after.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => [shape.id, shape]),
  );
  const body: AiAppliedBodyDiffEntry[] = [];
  const shapes: AiAppliedShapeDiffEntry[] = [];

  for (const id of removedBodyIds) {
    const block = findBlock(before, id);
    if (block) {
      body.push({ change: "removed", block });
    }
  }
  for (const id of addedBodyIds) {
    const block = findBlock(after, id);
    if (block) {
      body.push({ change: "added", block });
    }
  }
  for (const id of removedShapeIds) {
    const shape = beforeShapes.get(id);
    if (shape) {
      shapes.push({ change: "removed", shape });
    }
  }
  for (const id of addedShapeIds) {
    const shape = afterShapes.get(id);
    if (shape) {
      shapes.push({ change: "added", shape });
    }
  }

  return { body, shapes };
}

/**
 * 旧レコードや実行直後の一時表示向けfallback。before文書が無いので削除側は捏造せず、
 * draftに実体がある追加後ノードだけを返す。
 */
export function deriveAppliedDraftFallback(
  drafts: AiEditSessionDraft[],
  currentShapes: OverlayShape[] = [],
): AiAppliedDocumentDiff {
  const body: AiAppliedBodyDiffEntry[] = [];
  const shapes: AiAppliedShapeDiffEntry[] = [];
  const bodyIds = new Set<string>();
  const shapeIds = new Set<string>();
  const currentShapesById = new Map(currentShapes.map((shape) => [shape.id, shape]));

  const pushBody = (block: EditableBlock) => {
    if (!bodyIds.has(block.id)) {
      bodyIds.add(block.id);
      body.push({ change: "added", block });
    }
  };
  const pushShape = (shape: OverlayShape | undefined) => {
    if (shape && !shapeIds.has(shape.id)) {
      shapeIds.add(shape.id);
      shapes.push({ change: "added", shape });
    }
  };

  for (const draft of drafts) {
    for (const operation of draft.operations) {
      if (isOverlayAnchorSupportDraft(operation, draft.operations)) {
        continue;
      }
      if (operation.operation === undefined || operation.operation === "replace") {
        pushBody(operation.replacementBlock);
      } else if (operation.operation === "insertAfter") {
        pushBody(operation.insertedBlock);
      } else if (operation.operation === "insertOverlayShape") {
        pushShape(operation.overlayShape);
      } else if (operation.operation === "insertTableShape") {
        pushShape(operation.tableShape);
      }
    }
    for (const operation of draft.mutationOperations ?? []) {
      if (operation.operation === "updateOverlayShape") {
        pushShape(currentShapesById.get(operation.shapeId));
      } else if (operation.operation === "alignOverlayShapes") {
        operation.shapeIds.forEach((id) => pushShape(currentShapesById.get(id)));
      }
    }
  }

  return { body, shapes };
}

/** 同じturnに属する複数proposalの差分を、change/id単位で重複なくまとめる。 */
export function mergeAppliedDocumentDiffs(
  diffs: Array<AiAppliedDocumentDiff | undefined>,
): AiAppliedDocumentDiff {
  const bodyByKey = new Map<string, AiAppliedBodyDiffEntry>();
  const shapeByKey = new Map<string, AiAppliedShapeDiffEntry>();
  for (const diff of diffs) {
    for (const entry of diff?.body ?? []) {
      const key = `${entry.change}:${entry.block.id}`;
      if (entry.change === "added" || !bodyByKey.has(key)) {
        bodyByKey.set(key, entry);
      }
    }
    for (const entry of diff?.shapes ?? []) {
      const key = `${entry.change}:${entry.shape.id}`;
      if (entry.change === "added" || !shapeByKey.has(key)) {
        shapeByKey.set(key, entry);
      }
    }
  }
  return {
    body: [...bodyByKey.values()],
    shapes: [...shapeByKey.values()],
  };
}
