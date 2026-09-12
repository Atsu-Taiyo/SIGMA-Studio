import type { TextFlowBlock } from "@/features/text-editing";

import { hasBreakBefore, TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET } from "./block-ops";

/**
 * チャンクの境界。**各チャンクの先頭ブロック id** をそのまま並べたもの。
 *
 * これがユニット id (= React の key, `data-flow-unit-id`) になるので、境界が安定していれば
 * 下流のエディタは作り直されない。
 */
export interface ChunkBoundaryState {
  /**
   * 集合で持つ。本文の連なり (run) は文書内に何本もあり、`chunkTextRun` はそのたびに呼ばれる
   * ので、配列から毎回 `Set` を作ると run 数 x アンカー数で二乗に膨らむ (問題と本文が交互に
   * 並ぶ教材はまさにこの形)。作るのは 1 描画につき 1 回だけにする。
   */
  anchors: ReadonlySet<string>;
}

/** 文書ごとのチャンク境界。**別の教材の境界を持ち越さない**ための docId 付き。 */
export interface DocumentChunkBoundaryState {
  docId: string;
  state: ChunkBoundaryState;
}

export interface TextRunChunkLimits {
  /** 新しく切るときの 1 チャンクの大きさ。 */
  target: number;
  /** これを超えたチャンクだけ、その場で切り直す。 */
  max: number;
  /** これを割ったチャンクだけ、隣とくっつける。 */
  min: number;
}

/**
 * 既定値は従来の 1 ユニット 40 件を `target` に据え、その 2 倍で切り直し・1/4 で併合する。
 * 幅を持たせてあるのは、境界を動かさずに済ませる余地を作るため (動かすと再マウントが起きる)。
 */
export const DEFAULT_TEXT_RUN_CHUNK_LIMITS: TextRunChunkLimits = {
  target: TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET,
  max: TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET * 2,
  min: Math.max(1, Math.floor(TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET / 4)),
};

/**
 * 本文の連なりを「前回と同じ境界」で切り直す。
 *
 * index で 40 件ごとに切ると、先頭に 1 ブロック足しただけで 2 つ目以降の先頭ブロックがずれ、
 * ユニット id (React の key) が全部変わって下流のエディタが丸ごと作り直される — キャレットが
 * 飛ぶ既知の不具合 (`docs/caret-behavior-spec.md`) の出どころがこれだった。
 *
 * そこで境界は**ブロック id で覚える**。前回のアンカーのうち今も存在するものをそのまま境界に
 * 使い、大きくなりすぎたチャンクだけを切り直し、小さくなりすぎたチャンクだけを隣と併合する。
 * 手動改ページは常に境界 (呼び出し側でも連なりを切っているが、この関数だけでも成り立たせる)。
 *
 * `pinnedAnchors` はフォーカス中のユニットの先頭ブロック id。跨ぎ選択の IME 合成
 * (compositionstart で他ユニットの担当分だけ先に削除する) で前のチャンクが `min` を割ると、
 * 併合が焦点チャンクの先頭ブロック id (= React の key) を消し、合成中のエディタごと
 * unmount されて IME セッションが落ちる。フォーカス中のユニットが関わる併合だけを
 * 見送り、フォーカスが外れた後の描画で自然に併合させる。
 *
 * 純関数・決定的: 同じ (blocks, previous, limits, pinnedAnchors) からは必ず同じ結果になる。
 * さらに**不動点**でもある — この関数の出力から作った境界を渡し直しても結果は変わらない。
 * これが崩れると、内容を変えていないのに次の描画で境界が動く (= 作り直しが 1 回起きる)。
 */
export function chunkTextRun(
  blocks: TextFlowBlock[],
  previous: ChunkBoundaryState | null,
  limits: TextRunChunkLimits = DEFAULT_TEXT_RUN_CHUNK_LIMITS,
  pinnedAnchors: ReadonlySet<string> | null = null,
): TextFlowBlock[][] {
  if (blocks.length === 0) {
    return [];
  }

  // 前回のアンカーがこの連なりに 1 つも残っていない = 初めて描く連なり (新規文書、AI 適用や
  // 巨大 undo での差し替え)。ここでアンカー方式に落とすと連なり全体が 1 チャンクになり、
  // ProseMirror 1 インスタンスが想定の倍を抱えてしまうので、素直に target 件ごとに切る。
  const anchors = previous?.anchors;
  const chunks = anchors && blocks.some((block) => anchors.has(block.id))
    ? sliceByAnchors(blocks, anchors)
    : sliceEvery(blocks, limits.target);

  // 初回も同じ後処理を通す。初回だけ併合を飛ばすと「初回の出力を次回に渡すと結果が変わる」
  // 状態 (例: 45 件が 40+5 → 45) になり、**開いて最初の 1 打鍵で必ず境界が動く** —
  // この WI が消そうとしている再マウントそのものが 1 回だけ残る。
  return mergeSmallChunks(splitLargeChunks(chunks, limits), limits, normalizePinnedAnchors(pinnedAnchors));
}

/**
 * pin をチャンクの先頭ブロック id へ正規化する。`getFocusedTextRunUnitIds` が返すのは
 * レジストリのユニット id (`${先頭ブロック id}:${partIndex}` — インライン挿入で分割された
 * パート番号付き) で、素の先頭ブロック id との突き合わせでは一致しない。末尾の
 * `:partIndex` を落とさないと pin が丸ごと no-op になり、IME 合成中のエディタを守る
 * 「併合の見送り」が効かない。素の先頭ブロック id はそのまま通る (createId の id に
 * コロンは入らない)。
 */
function normalizePinnedAnchors(
  pinnedAnchors: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (pinnedAnchors === null || pinnedAnchors.size === 0) {
    return pinnedAnchors;
  }
  const normalized = new Set<string>();
  for (const anchor of pinnedAnchors) {
    normalized.add(anchor.replace(/:\d+$/, ""));
  }
  return normalized;
}

/**
 * 前回のアンカー (と手動改ページ) を境界として切る。もう存在しない id は自然に落ちる。
 *
 * 改ページの判定は防御的なもの。`buildRenderUnits` は改ページで連なり自体を切ってから
 * ここへ渡すので、実際の呼び出しでは 2 件目以降に改ページ付きブロックは来ない。この関数
 * 単体でも「改ページは必ず境界」が成り立つようにしてある (単体テストはその契約を固定する)。
 */
function sliceByAnchors(blocks: TextFlowBlock[], anchors: ReadonlySet<string>): TextFlowBlock[][] {
  const chunks: TextFlowBlock[][] = [];
  let current: TextFlowBlock[] = [];
  for (const block of blocks) {
    const startsChunk = current.length > 0 && (anchors.has(block.id) || hasBreakBefore(block));
    if (startsChunk) {
      chunks.push(current);
      current = [];
    }
    current.push(block);
  }
  chunks.push(current);
  return chunks;
}

/** 引き継ぐ境界が無いときの素の切り方: target 件ずつ。手動改ページはそこで切る。 */
function sliceEvery(blocks: TextFlowBlock[], size: number): TextFlowBlock[][] {
  const chunks: TextFlowBlock[][] = [];
  let current: TextFlowBlock[] = [];
  for (const block of blocks) {
    if (current.length > 0 && (current.length >= size || hasBreakBefore(block))) {
      chunks.push(current);
      current = [];
    }
    current.push(block);
  }
  chunks.push(current);
  return chunks;
}

/**
 * 大きくなりすぎたチャンクだけを切り直す。
 *
 * 切るのは**先頭から target 件ずつ**。前半の境界 (既存のアンカー) を動かさないので、
 * 追記でチャンクが伸びた場合でも、既にあるユニットはそのまま再利用できる。
 */
function splitLargeChunks(chunks: TextFlowBlock[][], limits: TextRunChunkLimits): TextFlowBlock[][] {
  return chunks.flatMap((chunk) => (
    chunk.length > limits.max ? sliceEvery(chunk, limits.target) : [chunk]
  ));
}

/**
 * 小さくなりすぎたチャンクだけを隣とくっつける。
 *
 * くっつける先は「直前のチャンク」を優先し、上限を超えるなら次のチャンクへ。どちらにも
 * 入らないなら小さいまま残す (無理に動かすと境界が跳ねて、この関数の目的が崩れる)。
 * 手動改ページで始まるチャンクは境界そのものなので、前へは吸収させない。
 *
 * `pinnedAnchors` (フォーカス中ユニットの先頭ブロック id) が関わる併合は見送る。前へ吸収
 * されると先頭ブロック id = React の key が消えてフォーカス中 (特に IME 合成中) のエディタ
 * ごと unmount され、逆に後続チャンクを吸収すると合成中のエディタへ setContent が走る。
 * どちらも IME セッションを殺すので、フォーカスが外れた後の描画まで併合を遅らせる。
 */
function mergeSmallChunks(
  chunks: TextFlowBlock[][],
  limits: TextRunChunkLimits,
  pinnedAnchors: ReadonlySet<string> | null = null,
): TextFlowBlock[][] {
  const merged: TextFlowBlock[][] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const startsAtPageBreak = hasBreakBefore(chunk[0]);
    const touchesPinnedAnchor = pinnedAnchors !== null
      && (pinnedAnchors.has(chunk[0].id)
        || (previous !== undefined && pinnedAnchors.has(previous[0].id)));
    const fitsInPrevious = previous !== undefined
      && !startsAtPageBreak
      && !touchesPinnedAnchor
      && previous.length + chunk.length <= limits.max
      && (chunk.length < limits.min || previous.length < limits.min);
    if (fitsInPrevious) {
      merged[merged.length - 1] = [...previous, ...chunk];
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

/** 描画に使ったユニットから次回の境界を作る (アンカー = 各ユニットの先頭ブロック id)。 */
export function getChunkBoundaryState(unitIds: readonly string[]): ChunkBoundaryState {
  return { anchors: new Set(unitIds) };
}

/**
 * 前回の境界を**同じ文書のときだけ**引き継ぐ。
 *
 * 境界は ref で持ち回るが、同じ `PageCanvasEditor` インスタンスが別の教材を描くことがある
 * (印刷プレビューのステージ)。ブロック id はテンプレート複製で文書をまたいで一致しうるので、
 * docId を確かめずに引き継ぐと「同じ教材なのに操作履歴で紙面が変わる」状態になる。
 */
export function carryChunkBoundaryState(
  previous: DocumentChunkBoundaryState | null,
  docId: string,
): ChunkBoundaryState | null {
  return previous && previous.docId === docId ? previous.state : null;
}
