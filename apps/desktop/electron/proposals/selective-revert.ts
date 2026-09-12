import { deriveAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { deleteBlocksFromDocument, findBlock, updateBlockInDocument } from "@/lib/document-tree";
import {
  ensurePageLayout,
  normalizeOverlaySnapshot,
  type OverlayShape,
  type OverlaySnapshot,
  type SigmaDocument,
} from "@/features/document";
import { type SelectiveRevertBatchDraft, type SelectiveRevertResult } from "./contracts";
import { mergeProposalDraftsIntoDocument } from "./replay";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

// 選択的revertが「触った対象のブロック/図形だけを戻す」という仕組みで安全に理解できる
// mutation opのホワイトリスト。deriveAppliedDocumentDiffがremoved/added IDとして表現できる
// (=巻き戻し先を一意に特定できる) 操作だけがここに入る。
//
// これはブロックリストではなくホワイトリストにしてある: moveBlocks/wrapBlocksInColumns/
// updateLayoutSectionは「中身」ではなく「位置・レイアウト」を変える操作なのでbefore/after
// の差分だけでは安全に巻き戻せる範囲が判断できず(moveBlocksは同じIDがremovedにもaddedにも
// 出るが、それは「動いた」ことを意味するだけで「編集された」わけではない)、updatePageLayout/
// setDocumentColumnsはページ設定というブロック/図形IDを持たない変更なのでdiffに一切現れず、
// ブロックリスト方式だとガードを素通りしてサイレントに戻し漏れる(実際に見つかったバグ)。
// ホワイトリストなら、スキーマに将来追加される未知のmutation opもデフォルトで拒否側に倒れる
// (「知らない操作は安全側に倒す」フェイルセーフ)。
const SELECTIVE_REVERT_SUPPORTED_MUTATION_OPS = new Set([
  "deleteBlocks",
  "updateOverlayShape",
  "alignOverlayShapes",
  "deleteOverlayShapes",
]);

// 上のホワイトリストに無い操作のうち、moveBlocks/wrapBlocksInColumns/updateLayoutSectionは
// 「位置・レイアウト」の変更だと具体的に言えるので専用の文言を出す。それ以外
// (updatePageLayout/setDocumentColumns、および将来スキーマに追加される未知の操作) は
// 中身を正確に言い当てられないため、汎用的な (=嘘のない) 文言にまとめる。
const SELECTIVE_REVERT_STRUCTURAL_MUTATION_OPS = new Set(["moveBlocks", "wrapBlocksInColumns", "updateLayoutSection"]);

/** バッチ全体を見て、ホワイトリストに無い最初のmutation opの種類を返す (無ければundefined)。 */
function findFirstUnsupportedMutationOp(batchDrafts: SelectiveRevertBatchDraft[]): string | undefined {
  for (const entry of batchDrafts) {
    for (const op of entry.draft.mutationOperations ?? []) {
      if (!SELECTIVE_REVERT_SUPPORTED_MUTATION_OPS.has(op.operation)) {
        return op.operation;
      }
    }
  }
  return undefined;
}

/**
 * 承認済みバッチ (同じ1回の保存を共有した提案群) を、CASが崩れた後でも選択的に (=触った
 * ブロック/図形だけ) 巻き戻せるか判定し、戻せるなら currentDocument を土台にした結果を返す。
 *
 * 手順:
 * 1. revertDocument (承認直前の教材) にバッチのdraftを承認時と同じ順序で合成し直し、
 *    「承認直後に実際に保存された状態」(after) を再現する。
 * 2. SELECTIVE_REVERT_SUPPORTED_MUTATION_OPSのホワイトリストに無い操作を含むバッチは
 *    対象外 (上のコメント参照)。
 * 3. deriveAppliedDocumentDiff で before(revertDocument)/after の実差分を取り、
 *    「置換(同じIDが削除・追加の両方に出る)」「AI追加のみ」「AI削除のみ」に仕分ける。
 * 4. 仕分けた各IDについて、現在のドキュメントでの内容が after 時点から変わっていないかを
 *    hashSigmaNode相当のハッシュで比較する。ユーザーがAI追加分をすでに消していた場合は
 *    「戻すものがないだけ」であってエラーにはしない。
 * 5. current を土台に、置換IDは revertDocument 時点の内容へ戻し、AI追加のみのIDは削除し、
 *    AI削除のみのID (revertDocument.content の直下だけ対応) を元の位置付近へ再挿入する。
 *    overlay図形も同じ方針。assets は意図的に触らない (孤立assetが残っても実害はなく、
 *    ここで刈り込むと他の図形が参照しているassetを誤って消しかねない)。
 *
 * どの入力ドキュメントも書き換えない (常に新しいオブジェクトを返す)。
 */
export function buildSelectiveRevertDocument(input: {
  revertDocument: SigmaDocument;
  batchDrafts: SelectiveRevertBatchDraft[];
  currentDocument: SigmaDocument;
}): SelectiveRevertResult {
  const { revertDocument, batchDrafts, currentDocument } = input;
  const CONFLICT_REASON = te("electron.proposalStore.undoConflict");

  const firstUnsupportedOp = findFirstUnsupportedMutationOp(batchDrafts);
  if (firstUnsupportedOp !== undefined) {
    const reason = SELECTIVE_REVERT_STRUCTURAL_MUTATION_OPS.has(firstUnsupportedOp)
      ? te("electron.proposalStore.structuralUndoUnsupported")
      : te("electron.proposalStore.selectiveUndoUnsupported");
    return { ok: false, reason };
  }

  const merge = mergeProposalDraftsIntoDocument(revertDocument, batchDrafts);
  if (merge.failed.length > 0) {
    return { ok: false, reason: te("electron.proposalStore.safeUndoFailed") };
  }
  const after = merge.document;

  const diff = deriveAppliedDocumentDiff(revertDocument, after, batchDrafts.map((entry) => entry.draft));
  const removedBodyIds = new Set(diff.body.filter((entry) => entry.change === "removed").map((entry) => entry.block.id));
  const addedBodyIds = new Set(diff.body.filter((entry) => entry.change === "added").map((entry) => entry.block.id));
  const removedShapeIds = new Set(diff.shapes.filter((entry) => entry.change === "removed").map((entry) => entry.shape.id));
  const addedShapeIds = new Set(diff.shapes.filter((entry) => entry.change === "added").map((entry) => entry.shape.id));

  const pairBodyIds = [...removedBodyIds].filter((id) => addedBodyIds.has(id));
  const addedOnlyBodyIds = [...addedBodyIds].filter((id) => !removedBodyIds.has(id));
  const removedOnlyBodyIds = [...removedBodyIds].filter((id) => !addedBodyIds.has(id));
  const pairShapeIds = new Set([...removedShapeIds].filter((id) => addedShapeIds.has(id)));
  const addedOnlyShapeIds = new Set([...addedShapeIds].filter((id) => !removedShapeIds.has(id)));
  const removedOnlyShapeIds = [...removedShapeIds].filter((id) => !addedShapeIds.has(id));

  // 鮮度チェック: 「触った/追加した」対象の afterAt 時点の内容が、現在のドキュメントで
  // まだそのままかを見る。currentHashes に無い (=ユーザーがすでに削除済み) IDは
  // 「戻すものがないだけ」でconflictにしない。
  const currentHashes = computeDocumentBlockHashes(currentDocument);
  const afterHashes = computeDocumentBlockHashes(after);
  for (const id of [...pairBodyIds, ...addedOnlyBodyIds, ...pairShapeIds, ...addedOnlyShapeIds]) {
    const currentHash = currentHashes[id];
    if (currentHash === undefined) {
      continue;
    }
    if (currentHash !== afterHashes[id]) {
      return { ok: false, reason: CONFLICT_REASON };
    }
  }
  for (const id of [...removedOnlyBodyIds, ...removedOnlyShapeIds]) {
    if (currentHashes[id] !== undefined) {
      // AIが削除したはずの対象が現在の教材に存在する = 何らかの形で復活している。
      return { ok: false, reason: CONFLICT_REASON };
    }
  }

  let doc = currentDocument;

  for (const id of pairBodyIds) {
    if (!findBlock(doc, id)) {
      continue; // ユーザーがすでに削除済み: 戻すものがない
    }
    const beforeBlock = findBlock(revertDocument, id);
    if (!beforeBlock) {
      continue;
    }
    doc = updateBlockInDocument(doc, id, () => beforeBlock);
  }

  const removableAddedBodyIds: string[] = [];
  for (const id of addedOnlyBodyIds) {
    const block = findBlock(doc, id);
    if (!block) {
      continue; // ユーザーがすでに削除済み
    }
    if (block.type === "listItem") {
      return { ok: false, reason: te("electron.proposalStore.listItemUndoUnsupported") };
    }
    removableAddedBodyIds.push(id);
  }
  if (removableAddedBodyIds.length > 0) {
    doc = deleteBlocksFromDocument(doc, removableAddedBodyIds);
  }

  if (removedOnlyBodyIds.length > 0) {
    const topLevelIndexById = new Map(revertDocument.content.map((block, index) => [block.id, index]));
    const orderedRemovedBodyIds = [...removedOnlyBodyIds].sort((a, b) => (
      (topLevelIndexById.get(a) ?? -1) - (topLevelIndexById.get(b) ?? -1)
    ));
    for (const id of orderedRemovedBodyIds) {
      const originalIndex = topLevelIndexById.get(id);
      if (originalIndex === undefined) {
        // revertDocument.content の直下に無い = ネストされた場所 (problem内など) から削除された。
        // 元のネスト位置を安全に再現できないため対象外にする。
        return { ok: false, reason: te("electron.proposalStore.nestedBlockUndoUnsupported") };
      }
      const block = revertDocument.content[originalIndex];
      let insertIndex = 0;
      for (let j = originalIndex - 1; j >= 0; j -= 1) {
        const siblingIndex = doc.content.findIndex((item) => item.id === revertDocument.content[j].id);
        if (siblingIndex >= 0) {
          insertIndex = siblingIndex + 1;
          break;
        }
      }
      const nextContent = [...doc.content];
      nextContent.splice(insertIndex, 0, block);
      doc = { ...doc, content: nextContent, updatedAt: new Date().toISOString() };
    }
  }

  if (pairShapeIds.size > 0 || addedOnlyShapeIds.size > 0 || removedOnlyShapeIds.length > 0) {
    const beforeShapes = readOverlayShapes(revertDocument);
    const beforeShapesById = new Map(beforeShapes.map((shape) => [shape.id, shape]));
    let shapes = readOverlayShapes(doc)
      .map((shape) => (pairShapeIds.has(shape.id) ? beforeShapesById.get(shape.id) ?? shape : shape))
      .filter((shape) => !addedOnlyShapeIds.has(shape.id));

    if (removedOnlyShapeIds.length > 0) {
      const originalIndexById = new Map(beforeShapes.map((shape, index) => [shape.id, index]));
      const orderedRemovedShapeIds = [...removedOnlyShapeIds].sort((a, b) => (
        (originalIndexById.get(a) ?? 0) - (originalIndexById.get(b) ?? 0)
      ));
      for (const id of orderedRemovedShapeIds) {
        const shape = beforeShapesById.get(id);
        if (!shape) {
          continue;
        }
        const insertIndex = Math.min(originalIndexById.get(id) ?? shapes.length, shapes.length);
        shapes = [...shapes.slice(0, insertIndex), shape, ...shapes.slice(insertIndex)];
      }
    }

    doc = writeOverlayShapes(doc, shapes);
  }

  return { ok: true, document: doc };
}

/** document.pageLayout.overlay.overlaySnapshot.shapes を正規化した形で読み出すだけの薄いヘルパー。 */

function readOverlayShapes(document: SigmaDocument): OverlayShape[] {
  return normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes;
}

/**
 * shapes配列だけを差し替えてoverlaySnapshotを書き戻す。sigma-doc-edit-schema.tsの
 * writeOverlaySnapshotと同じ書き込み方 (pageLayoutを確実に用意してからoverlayを合成する)
 * だが、選択的revertはelectron側のこのモジュールに閉じているため、循環importを避けて
 * ここに複製してある。
 */
function writeOverlayShapes(document: SigmaDocument, shapes: OverlayShape[]): SigmaDocument {
  const withLayout = ensurePageLayout(document);
  const layout = withLayout.pageLayout!;
  const snapshot: OverlaySnapshot = { ...normalizeOverlaySnapshot(layout.overlay?.overlaySnapshot), shapes };
  return {
    ...withLayout,
    pageLayout: {
      ...layout,
      overlay: {
        ...(layout.overlay ?? {}),
        overlaySnapshot: snapshot,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}
