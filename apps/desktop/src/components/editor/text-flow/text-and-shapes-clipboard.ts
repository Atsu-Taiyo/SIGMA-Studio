import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { refreshMathInlineIdsInSlice } from "@/components/tiptap/inline-math-extension";
import type { ListNode } from "@/features/document";
import { idPrefixForTextNode, type TextFlowBlock } from "@/features/text-editing";
import type { EditorClipboardPayload } from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";

import type { TextRunReplacementMutation } from "./text-run-replacement";

export const OVERLAY_SHAPES_PASTE_REQUEST_EVENT = "sigma-studio:overlay-shapes-paste-request";

export interface OverlayShapesPasteRequestDetail {
  payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>;
  /** コピー元ブロック id → 貼り付けで生まれたブロック id。 */
  anchorBlockIdMap: Record<string, string>;
  /**
   * 本文側が鋳造した undo のコアレスキー。図形側はこれを使って保存し、⌘Z 1 回で
   * 本文と図形が同時に戻る (`clipboard-history-group.ts`)。
   */
  historyGroup: string;
  /** 貼り付けたエディタの DOM。シェルが「文書本文のエディタか」を判定する。 */
  source: HTMLElement;
}

export function requestOverlayShapesPaste(detail: OverlayShapesPasteRequestDetail): void {
  window.dispatchEvent(new CustomEvent(OVERLAY_SHAPES_PASTE_REQUEST_EVENT, { detail }));
}

/**
 * 跨ぎ選択への本文+図形ペーストで、コピー元ブロック id → 置換後に文書へ残ったブロック id
 * の対応を組み立てる。clone 系 (cloneTextFlowBlocksForPaste) はツリー構造を変えないので、
 * 原本と複製を並走して id を対にし、境界結合で複製が消えた分は mutation の
 * joinedInsertionIds で結合先へ読み替える。
 */
export function resolveTextRunSpanAnchorBlockIdMap(
  sourceBlocks: readonly TextFlowBlock[],
  pastedBlocks: readonly TextFlowBlock[],
  mutations: readonly TextRunReplacementMutation[],
): Record<string, string> {
  const joinedInsertionIds: Record<string, string> = {};
  for (const mutation of mutations) {
    Object.assign(joinedInsertionIds, mutation.joinedInsertionIds);
  }
  const map: Record<string, string> = {};
  sourceBlocks.forEach((source, index) => {
    const pasted = pastedBlocks[index];
    if (pasted) {
      collectPastedBlockIdPairs(source, pasted, joinedInsertionIds, map);
    }
  });
  return map;
}

function collectPastedBlockIdPairs(
  source: TextFlowBlock,
  pasted: TextFlowBlock,
  joinedInsertionIds: Record<string, string>,
  map: Record<string, string>,
): void {
  map[source.id] = joinedInsertionIds[pasted.id] ?? pasted.id;
  if (source.type === "boxBlock" && pasted.type === "boxBlock") {
    source.blocks.forEach((child, index) => {
      const pastedChild = pasted.blocks[index];
      if (pastedChild) {
        collectPastedBlockIdPairs(child, pastedChild, joinedInsertionIds, map);
      }
    });
    return;
  }
  if (source.type === "layoutSection" && pasted.type === "layoutSection") {
    source.children.forEach((child, index) => {
      const pastedChild = pasted.children[index];
      if (pastedChild) {
        collectPastedBlockIdPairs(child, pastedChild, joinedInsertionIds, map);
      }
    });
    return;
  }
  if (source.type === "list" && pasted.type === "list") {
    collectPastedListIdPairs(source, pasted, map);
  }
}

function collectPastedListIdPairs(
  source: ListNode,
  pasted: ListNode,
  map: Record<string, string>,
): void {
  source.items.forEach((item, index) => {
    const pastedItem = pasted.items[index];
    if (!pastedItem) {
      return;
    }
    map[item.id] = pastedItem.id;
    item.continuations?.forEach((continuation, continuationIndex) => {
      const pastedContinuation = pastedItem.continuations?.[continuationIndex];
      if (pastedContinuation) {
        map[continuation.id] = pastedContinuation.id;
      }
    });
    item.nested?.forEach((nested, nestedIndex) => {
      const pastedNested = pastedItem.nested?.[nestedIndex];
      if (pastedNested) {
        map[nested.id] = pastedNested.id;
        collectPastedListIdPairs(nested, pastedNested, map);
      }
    });
  });
}

export function refreshSigmaDocIdsInSlice(slice: Slice): { slice: Slice; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const content = refreshFragment(slice.content, idMap);
  return { slice: new Slice(content, slice.openStart, slice.openEnd), idMap };
}

function refreshFragment(fragment: Fragment, idMap: Map<string, string>): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => nodes.push(refreshNode(node, idMap)));
  return Fragment.fromArray(nodes);
}

function refreshNode(node: ProseMirrorNode, idMap: Map<string, string>): ProseMirrorNode {
  const content = node.content.size > 0 ? refreshFragment(node.content, idMap) : node.content;
  const oldId = typeof node.attrs.sigmaDocId === "string" && node.attrs.sigmaDocId.length > 0
    ? node.attrs.sigmaDocId
    : null;
  if (!oldId) {
    return content === node.content ? node : node.copy(content);
  }

  const prefix = node.type.name === "bulletList" || node.type.name === "orderedList"
    ? "list"
    : node.type.name === "boxBlock"
      ? "box"
      : node.type.name === "layoutSection"
        ? "layout_section"
        : idPrefixForTextNode(String(node.attrs.sigmaDocType ?? node.type.name), node.type.name);
  const nextId = createId(prefix);
  idMap.set(oldId, nextId);
  return node.type.create({ ...node.attrs, sigmaDocId: nextId }, content, node.marks);
}

export function insertTextSliceWithFreshBlockIds(
  state: EditorState,
  slice: Slice,
): { transaction: Transaction; anchorBlockIdMap: Record<string, string> } {
  const nodeTypes = collectSigmaNodeTypes(slice);
  const firstChain = collectOpenChainIds(slice, "first");
  const lastChain = collectOpenChainIds(slice, "last");
  const refreshed = refreshSigmaDocIdsInSlice(slice);
  const nextSlice = refreshMathInlineIdsInSlice(refreshed.slice);
  // ProseMirror の既定貼り付け (`doPaste`) と同じ規則: 閉じた単一ノードは
  // `replaceSelectionWith(node, false)`、それ以外は `replaceSelection(slice)`。
  const single = sliceSingleNode(nextSlice);
  const transaction = single
    ? state.tr.replaceSelectionWith(single, false)
    : state.tr.replaceSelection(nextSlice);

  const idsInDocument = new Set<string>();
  transaction.doc.descendants((node) => {
    if (typeof node.attrs.sigmaDocId === "string" && node.attrs.sigmaDocId) {
      idsInDocument.add(node.attrs.sigmaDocId);
    }
    return true;
  });

  const anchorBlockIdMap: Record<string, string> = {};
  const start = transaction.doc.resolve(Math.min(state.selection.from, transaction.doc.content.size));
  const end = transaction.doc.resolve(Math.min(transaction.selection.to, transaction.doc.content.size));
  for (const [oldId, freshId] of refreshed.idMap) {
    if (idsInDocument.has(freshId)) {
      anchorBlockIdMap[oldId] = freshId;
      continue;
    }
    const typeName = nodeTypes.get(oldId);
    const mergedId = firstChain.has(oldId)
      ? findSigmaAncestorId(start, typeName)
      : lastChain.has(oldId)
        ? findSigmaAncestorId(end, typeName)
        : null;
    if (mergedId) {
      anchorBlockIdMap[oldId] = mergedId;
    }
  }
  return { transaction, anchorBlockIdMap };
}

function sliceSingleNode(slice: Slice): ProseMirrorNode | null {
  return slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
    ? slice.content.firstChild
    : null;
}

function collectSigmaNodeTypes(slice: Slice): Map<string, string> {
  const result = new Map<string, string>();
  slice.content.descendants((node) => {
    if (typeof node.attrs.sigmaDocId === "string" && node.attrs.sigmaDocId) {
      result.set(node.attrs.sigmaDocId, node.type.name);
    }
    return true;
  });
  return result;
}

function collectOpenChainIds(slice: Slice, edge: "first" | "last"): Set<string> {
  const result = new Set<string>();
  let node = edge === "first" ? slice.content.firstChild : slice.content.lastChild;
  const depth = edge === "first" ? slice.openStart : slice.openEnd;
  for (let index = 0; node && index <= depth; index += 1) {
    if (typeof node.attrs.sigmaDocId === "string" && node.attrs.sigmaDocId) {
      result.add(node.attrs.sigmaDocId);
    }
    node = edge === "first" ? node.firstChild : node.lastChild;
  }
  return result;
}

function findSigmaAncestorId(position: ResolvedPos, preferredType: string | undefined): string | null {
  let fallback: string | null = null;
  for (let depth = position.depth; depth > 0; depth -= 1) {
    const node = position.node(depth);
    const id = typeof node.attrs.sigmaDocId === "string" && node.attrs.sigmaDocId
      ? node.attrs.sigmaDocId
      : null;
    if (!id) {
      continue;
    }
    fallback ??= id;
    if (node.type.name === preferredType) {
      return id;
    }
  }
  return fallback;
}
