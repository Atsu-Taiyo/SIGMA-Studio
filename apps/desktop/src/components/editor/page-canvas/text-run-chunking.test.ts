import { describe, expect, it } from "vitest";

import type { TextFlowBlock } from "@/features/text-editing";

import {
  carryChunkBoundaryState,
  chunkTextRun,
  DEFAULT_TEXT_RUN_CHUNK_LIMITS,
  getChunkBoundaryState,
  type ChunkBoundaryState,
} from "./text-run-chunking";

function paragraph(id: string): TextFlowBlock {
  return { type: "paragraph", id, children: [{ type: "text", text: id }] } as TextFlowBlock;
}

function run(count: number, prefix = "b"): TextFlowBlock[] {
  return Array.from({ length: count }, (_, index) => paragraph(`${prefix}${index}`));
}

function anchorsOf(chunks: TextFlowBlock[][]): string[] {
  return chunks.map((chunk) => chunk[0].id);
}

function stateOf(chunks: TextFlowBlock[][]): ChunkBoundaryState {
  return getChunkBoundaryState(anchorsOf(chunks));
}

describe("chunkTextRun", () => {
  it("cuts a fresh run into target-sized chunks anchored on their first block", () => {
    const chunks = chunkTextRun(run(100), null);

    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 20]);
    expect(anchorsOf(chunks)).toEqual(["b0", "b40", "b80"]);
  });

  it("keeps every boundary when a block is inserted at the top", () => {
    // ここが本題。index で切ると先頭に 1 件足すだけで 2 つ目以降のユニット id が全部ずれ、
    // React の key が変わって下流のエディタが丸ごと作り直される (キャレットが飛ぶ)。
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const inserted = [paragraph("inserted"), ...blocks];

    const next = chunkTextRun(inserted, stateOf(first));

    expect(anchorsOf(next)).toEqual(["inserted", "b40", "b80"]);
    expect(next.map((chunk) => chunk.length)).toEqual([41, 40, 20]);
    // 触っていないチャンクのブロックは前回と同じオブジェクトのまま (ユニット再利用の前提)。
    expect(next[1].every((block, index) => block === first[1][index])).toBe(true);
    expect(next[2].every((block, index) => block === first[2][index])).toBe(true);
  });

  it("keeps every boundary when a block in the middle of a chunk is deleted", () => {
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const deleted = blocks.filter((block) => block.id !== "b5");

    const next = chunkTextRun(deleted, stateOf(first));

    expect(anchorsOf(next)).toEqual(["b0", "b40", "b80"]);
    expect(next.map((chunk) => chunk.length)).toEqual([39, 40, 20]);
  });

  it("moves only the boundary whose anchor block was deleted", () => {
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const deleted = blocks.filter((block) => block.id !== "b40");

    const next = chunkTextRun(deleted, stateOf(first));

    // b40 が消えた境界は「次のチャンクの先頭」へ動くだけで、b80 の境界は動かない。
    expect(anchorsOf(next)).toEqual(["b0", "b80"]);
    expect(next.map((chunk) => chunk.length)).toEqual([79, 20]);
  });

  it("splits only the chunk that grew past the maximum", () => {
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const grown = [
      ...blocks.slice(0, 40),
      ...Array.from({ length: 46 }, (_, index) => paragraph(`added${index}`)),
      ...blocks.slice(40),
    ];

    const next = chunkTextRun(grown, stateOf(first));

    expect(next.map((chunk) => chunk.length)).toEqual([40, 46, 40, 20]);
    expect(anchorsOf(next)).toEqual(["b0", "added0", "b40", "b80"]);
  });

  it("merges a chunk into the following one when it is the small side", () => {
    // 前が小さい側でも併合する (どちらか一方が min を割っていれば寄せる)。
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const shrunk = [...blocks.slice(0, 4), ...blocks.slice(40)];

    const next = chunkTextRun(shrunk, stateOf(first));

    expect(next.map((chunk) => chunk.length)).toEqual([44, 20]);
    expect(anchorsOf(next)).toEqual(["b0", "b80"]);
  });

  it("merges a chunk that shrank below the minimum into its neighbour", () => {
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    const shrunk = [...blocks.slice(0, 40), ...blocks.slice(40, 43), ...blocks.slice(80)];

    const next = chunkTextRun(shrunk, stateOf(first));

    expect(next.map((chunk) => chunk.length)).toEqual([43, 20]);
    expect(anchorsOf(next)).toEqual(["b0", "b80"]);
  });

  it("フォーカス中 (pinned) のチャンクは前のチャンクが min を割っても吸収されない", () => {
    // 跨ぎ選択の IME 合成: compositionstart で前チャンクの担当分だけが削除されて 5 件に
    // なった状態。併合で焦点チャンクの先頭 id (= React の key) が消えると、合成中の
    // エディタごと unmount されて IME セッションが落ちる。
    const blocks = run(60);
    const first = chunkTextRun(blocks, null);
    expect(anchorsOf(first)).toEqual(["b0", "b40"]);
    const shrunk = [...blocks.slice(0, 5), ...blocks.slice(40)];

    const pinned = chunkTextRun(shrunk, stateOf(first), DEFAULT_TEXT_RUN_CHUNK_LIMITS, new Set(["b40"]));
    expect(anchorsOf(pinned)).toEqual(["b0", "b40"]);
    expect(pinned.map((chunk) => chunk.length)).toEqual([5, 20]);

    // pin が無ければ従来どおり併合される (フォーカスが外れた後の描画で自然に整う)。
    const unpinned = chunkTextRun(shrunk, stateOf(first));
    expect(anchorsOf(unpinned)).toEqual(["b0"]);
  });

  it("レジストリ形式のユニット id (`先頭ブロックid:partIndex`) の pin でも併合を見送る", () => {
    // 実際の呼び出し元 (`getFocusedTextRunUnitIds`) はレジストリのユニット id を返す。
    // 素の先頭ブロック id と一致しないまま照合すると pin が no-op になり、IME 合成中の
    // エディタが併合で unmount される (E3 の保護が効かない)。
    const blocks = run(60);
    const first = chunkTextRun(blocks, null);
    const shrunk = [...blocks.slice(0, 5), ...blocks.slice(40)];

    const pinned = chunkTextRun(shrunk, stateOf(first), DEFAULT_TEXT_RUN_CHUNK_LIMITS, new Set(["b40:0"]));
    expect(anchorsOf(pinned)).toEqual(["b0", "b40"]);
    expect(pinned.map((chunk) => chunk.length)).toEqual([5, 20]);

    // インライン挿入で分割された 2 つ目以降のパート (partIndex > 0) の id でも効く。
    const pinnedLaterPart = chunkTextRun(shrunk, stateOf(first), DEFAULT_TEXT_RUN_CHUNK_LIMITS, new Set(["b40:2"]));
    expect(anchorsOf(pinnedLaterPart)).toEqual(["b0", "b40"]);
  });

  it("フォーカス中 (pinned) のチャンクは後続の小チャンクも吸収しない", () => {
    // 吸収すると焦点チャンクの内容 (ブロック列) が変わり、合成中のエディタへ setContent が
    // 走って IME セッションが切れる。
    const blocks = run(100);
    const first = chunkTextRun(blocks, null);
    expect(anchorsOf(first)).toEqual(["b0", "b40", "b80"]);
    const shrunk = [...blocks.slice(0, 80), ...blocks.slice(80, 85)];

    const pinned = chunkTextRun(shrunk, stateOf(first), DEFAULT_TEXT_RUN_CHUNK_LIMITS, new Set(["b40"]));
    expect(anchorsOf(pinned)).toEqual(["b0", "b40", "b80"]);
    expect(pinned.map((chunk) => chunk.length)).toEqual([40, 40, 5]);

    const unpinned = chunkTextRun(shrunk, stateOf(first));
    expect(anchorsOf(unpinned)).toEqual(["b0", "b40"]);
    expect(unpinned.map((chunk) => chunk.length)).toEqual([40, 45]);
  });

  it("pinned でも不動点: 自身の出力境界を渡し直しても結果は変わらない", () => {
    const blocks = [...run(5, "a"), ...run(20, "z")];
    const previous = getChunkBoundaryState(["a0", "z0"]);
    const pinnedAnchors = new Set(["z0"]);

    const first = chunkTextRun(blocks, previous, DEFAULT_TEXT_RUN_CHUNK_LIMITS, pinnedAnchors);
    const second = chunkTextRun(blocks, stateOf(first), DEFAULT_TEXT_RUN_CHUNK_LIMITS, pinnedAnchors);

    expect(anchorsOf(second)).toEqual(anchorsOf(first));
    expect(second.map((chunk) => chunk.length)).toEqual(first.map((chunk) => chunk.length));
  });

  it("always starts a chunk at a manual page break", () => {
    const blocks = [
      paragraph("b0"),
      paragraph("b1"),
      { ...paragraph("b2"), pagination: { break: true } } as TextFlowBlock,
      paragraph("b3"),
    ];

    const chunks = chunkTextRun(blocks, getChunkBoundaryState(["b0"]));

    expect(anchorsOf(chunks)).toEqual(["b0", "b2"]);
    // 改ページ側が短くても併合しない (改ページは必ず境界)。
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2]);
  });

  it("cuts a fresh run into target-sized chunks, tail included, when the tail is big enough", () => {
    const chunks = chunkTextRun(run(50), null);

    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 10]);
    expect(chunkTextRun(run(50), getChunkBoundaryState([])).map((chunk) => chunk.length)).toEqual([40, 10]);
  });

  it("is a fixed point: feeding its own boundary back changes nothing", () => {
    // ここが崩れると「何も編集していないのに次の描画で境界が動く」= 作り直しが 1 回起きる。
    // 初回だけ併合を飛ばしていた頃は 45 件が 40+5 → 45 に変わり、開いて最初の 1 打鍵で
    // 2 つ目のユニットが破棄されていた。
    for (const count of [7, 45, 50, 100, 137]) {
      const blocks = run(count);
      const first = chunkTextRun(blocks, null);
      const second = chunkTextRun(blocks, stateOf(first));

      expect(anchorsOf(second)).toEqual(anchorsOf(first));
      expect(second.map((chunk) => chunk.length)).toEqual(first.map((chunk) => chunk.length));
    }
  });

  it("falls back to fresh chunking when no anchor survives at all", () => {
    // AI 適用や巨大 undo で本文が丸ごと差し替わると、アンカーは非空のまま全滅する。
    // そのままアンカー方式に落とすと連なり全体が 1 チャンク (= ProseMirror 1 つが 60 件) になる。
    const chunks = chunkTextRun(run(60, "c"), getChunkBoundaryState(["b0", "b40"]));

    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 20]);
    expect(anchorsOf(chunks)).toEqual(["c0", "c40"]);
  });

  it("handles an empty run and a single block run", () => {
    expect(chunkTextRun([], null)).toEqual([]);
    expect(chunkTextRun([], getChunkBoundaryState(["gone"]))).toEqual([]);
    expect(chunkTextRun([paragraph("only")], null).map((chunk) => chunk.length)).toEqual([1]);
  });

  it("ignores anchors that no longer exist, which is what makes undo safe", () => {
    // undo でブロック列が丸ごと戻ると、古いアンカーはもう文書に無い。落とすだけでよい。
    const chunks = chunkTextRun(run(50), getChunkBoundaryState(["ghost1", "b20", "ghost2"]));

    expect(anchorsOf(chunks)).toEqual(["b0", "b20"]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([20, 30]);
  });

  it("is deterministic for the same input", () => {
    const blocks = run(137);
    const previous = getChunkBoundaryState(["b0", "b40", "b95"]);

    expect(chunkTextRun(blocks, previous).map((chunk) => chunk.map((block) => block.id)))
      .toEqual(chunkTextRun(blocks, previous).map((chunk) => chunk.map((block) => block.id)));
    expect(DEFAULT_TEXT_RUN_CHUNK_LIMITS).toEqual({ target: 40, max: 80, min: 10 });
  });

  it("takes the anchor set as-is so it can be built once per render, not once per run", () => {
    // 本文の連なりは文書内に何本もある (問題と交互に並ぶ教材は特に)。ここで毎回 Set を作ると
    // 打鍵のたびに run 数 x アンカー数になる。集合はそのまま使い回せることを型と実装で担保する。
    const anchors = getChunkBoundaryState(["b0", "b40"]).anchors;
    const first = chunkTextRun(run(60), { anchors });
    const second = chunkTextRun(run(60, "c"), { anchors });

    expect(anchorsOf(first)).toEqual(["b0", "b40"]);
    // 2 本目はこのアンカーを 1 つも含まない連なりなので素の切り方に落ちる (集合は共有のまま)。
    expect(anchorsOf(second)).toEqual(["c0", "c40"]);
  });
});

describe("carryChunkBoundaryState", () => {
  it("carries the boundary within the same document", () => {
    const state = getChunkBoundaryState(["b0", "b40"]);

    expect(carryChunkBoundaryState({ docId: "doc-1", state }, "doc-1")).toBe(state);
  });

  it("drops the boundary when the same editor starts drawing another document", () => {
    // 印刷プレビューのステージは同じ `PageCanvasEditor` を使い回す。テンプレート複製の教材どうしは
    // ブロック id が一致しうるので、docId を見ないと前の教材の境界がそのまま効いてしまう
    // (同じ教材の紙面が操作履歴で変わる)。
    const state = getChunkBoundaryState(["b0", "b40"]);

    expect(carryChunkBoundaryState({ docId: "doc-1", state }, "doc-2")).toBeNull();
    expect(carryChunkBoundaryState(null, "doc-1")).toBeNull();
  });
});
