import { createHash } from "node:crypto";

import {
  normalizeOverlaySnapshot,
  type BoxBlockChildBlock,
  type LayoutSectionChildBlock,
  type ListNode,
  type ProblemAreaBlock,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";

// node:crypto はブラウザ(renderer)バンドルでは使えないが、このファイルは electron/ (main process)
// と mcp/ (別Nodeプロセス) からのみ import される想定 (どちらもNode環境)。src/lib/ に置くのは
// mcp/ が既存の実績として "@/lib/..." を import しているため、パスエイリアスを揃えるだけの理由。
// renderer側のコンポーネント/ページからは絶対に import しないこと。

/**
 * 1ブロック/1overlay図形をAI提案の「対象」として同一性比較するためのハッシュ。
 * ハッシュ前に正規化する: オブジェクトのキーは再帰的にソートし、値が undefined の
 * キーは存在しないものとして扱う。配列の順序は実内容 (inline childrenの並び) なので保持する。
 * つまり「内容が同じなら必ず同じハッシュ」を保証する。
 *
 * キー順に依存させてはいけない理由: 本文編集は Tiptap を往復した全ブロックをcommitするため、
 * 内容が同じでも {id,type,children} → {type,id,children} とキー順が入れ替わる。
 * 実際に mathInline へ semanticRole が末尾付与されるドリフトで、編集エリアをクリックした
 * だけでハッシュが変わり、AI提案の承認が「依頼時に選択していた箇所が承認前に変更されている」
 * と偽陽性で拒否される事故が起きていた (2026-07-16調査)。
 * 同じ規約は features/ai-edit/application/locked-target-diff.ts の deepEquals と揃えてある。
 */
export function hashSigmaNode(node: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeSigmaNode(node))).digest("hex");
}

function canonicalizeSigmaNode(node: unknown): unknown {
  if (node === null || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(canonicalizeSigmaNode);
  }

  const record = node as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalizeSigmaNode(record[key])]),
  );
}

/**
 * 「提案がIDで触りうる単位」を document 全体から列挙し、id → ハッシュ の対応表を作る。
 * 本文ブロック (ネストされた problem の各エリア、layoutSection/boxBlock の子、list の入れ子項目を
 * 含む) と、overlay図形 (表・グラフ・通常図形。document.pageLayout.overlay.overlaySnapshot.shapes に
 * フラットに格納されている) の両方を対象にする。findBlock (document-tree.ts) と同じ走査規則。
 */
export function computeDocumentBlockHashes(document: SigmaDocument): Record<string, string> {
  const hashes: Record<string, string> = {};
  collectBlocksInto(document.content, hashes);

  const overlaySnapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  for (const shape of overlaySnapshot.shapes) {
    hashes[shape.id] = hashSigmaNode(shape);
  }

  return hashes;
}

function collectBlocksInto(blocks: SigmaBlock[], out: Record<string, string>): void {
  for (const block of blocks) {
    collectBlockInto(block, out);
  }
}

function collectBlockInto(block: SigmaBlock, out: Record<string, string>): void {
  out[block.id] = hashSigmaNode(block);

  if (block.type === "list") {
    collectListInto(block, out);
    return;
  }
  if (block.type === "problem") {
    collectRichBlocksInto(block.lead, out);
    collectRichBlocksInto(block.prompt, out);
    collectRichBlocksInto(block.solution, out);
    collectRichBlocksInto(block.hints, out);
    return;
  }
  if (block.type === "layoutSection") {
    collectLayoutSectionChildrenInto(block.children, out);
    return;
  }
  if (block.type === "boxBlock") {
    collectBoxBlockChildrenInto(block.blocks, out);
    return;
  }
}

function collectRichBlocksInto(blocks: ProblemAreaBlock[], out: Record<string, string>): void {
  for (const block of blocks) {
    collectRichBlockInto(block, out);
  }
}

function collectRichBlockInto(block: ProblemAreaBlock, out: Record<string, string>): void {
  out[block.id] = hashSigmaNode(block);
  if (block.type === "layoutSection") {
    collectLayoutSectionChildrenInto(block.children, out);
    return;
  }
  if (block.type === "boxBlock") {
    collectBoxBlockChildrenInto(block.blocks, out);
    return;
  }
  if (block.type === "list") {
    collectListInto(block, out);
  }
}

function collectLayoutSectionChildrenInto(blocks: LayoutSectionChildBlock[], out: Record<string, string>): void {
  for (const block of blocks) {
    collectBlockInto(block, out);
  }
}

function collectBoxBlockChildrenInto(blocks: BoxBlockChildBlock[], out: Record<string, string>): void {
  for (const block of blocks) {
    collectBlockInto(block, out);
  }
}

function collectListInto(list: ListNode, out: Record<string, string>): void {
  for (const item of list.items) {
    out[item.id] = hashSigmaNode(item);
    for (const continuation of item.continuations ?? []) {
      out[continuation.id] = hashSigmaNode(continuation);
    }
    for (const nested of item.nested ?? []) {
      collectListInto(nested, out);
    }
  }
}
