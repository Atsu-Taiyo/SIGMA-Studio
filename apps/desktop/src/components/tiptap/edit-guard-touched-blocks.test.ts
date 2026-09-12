import { Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { findTouchedGuardedBlockIds } from "@/components/tiptap/edit-guard-extension";

const SigmaDocIdAttrs = Extension.create({
  name: "testSigmaDocIdAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: { sigmaDocId: { default: null } },
      },
    ];
  },
});

const schema = getSchema([StarterKit.configure({ undoRedo: false }), SigmaDocIdAttrs]);

function doc(blocks: Array<{ id: string; text: string }>): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    blocks.map((block) => schema.nodes.paragraph.create(
      { sigmaDocId: block.id },
      block.text ? schema.text(block.text) : undefined,
    )),
  );
}

function run(count: number, prefix = "b"): Array<{ id: string; text: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, text: `本文${index}` }));
}

describe("findTouchedGuardedBlockIds", () => {
  it("reports a guarded block whose content changed", () => {
    const blocks = run(5);
    const edited = blocks.map((block) => block.id === "b2" ? { ...block, text: "書き換えた" } : block);

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(edited), new Set(["b1", "b2"]))).toEqual(["b2"]);
  });

  it("reports a guarded block whose neighbours changed even when its own content did not", () => {
    // ガードされたブロックの「まわり」が変わるのも編集: 直前・直後が入れ替われば触れている。
    const blocks = run(4);
    const reordered = [blocks[0], blocks[2], blocks[1], blocks[3]];

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(reordered), new Set(["b1"]))).toEqual(["b1"]);
  });

  it("stays silent when an unguarded block far away is edited", () => {
    const blocks = run(6);
    const edited = blocks.map((block) => block.id === "b5" ? { ...block, text: "遠くの編集" } : block);

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(edited), new Set(["b0"]))).toEqual([]);
  });

  it("ignores a guarded id that does not exist in the old document", () => {
    const blocks = run(3);

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(blocks), new Set(["missing"]))).toEqual([]);
  });

  it("reports a guarded block that was deleted", () => {
    const blocks = run(4);
    const deleted = blocks.filter((block) => block.id !== "b2");

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(deleted), new Set(["b2"]))).toEqual(["b2"]);
  });

  it("keeps `indexOf` semantics when the same id appears twice", () => {
    // 索引は「最初に出てきた位置」を返す (`indexOf` と同じ)。重複 id は文書側の壊れだが、
    // 索引化で**判定が変わらない**ことをここで固定する。
    const blocks = [
      { id: "dup", text: "1つ目" },
      { id: "b1", text: "あいだ" },
      { id: "dup", text: "2つ目" },
      { id: "b2", text: "うしろ" },
    ];
    const moved = [blocks[0], blocks[2], blocks[1], blocks[3]];

    expect(findTouchedGuardedBlockIds(doc(blocks), doc(blocks), new Set(["dup"]))).toEqual([]);
    // 並びが変われば触れている (最初の "dup" の隣が変わる)。
    expect(findTouchedGuardedBlockIds(doc(blocks), doc(moved), new Set(["dup"]))).toEqual(["dup"]);
  });

  it("scales linearly with the document, not quadratically", () => {
    // 並びの照合に `includes`/`indexOf` を使っていた頃は、ブロック数を 4 倍にすると
    // 時間が 16 倍側へ張り付いた。時間の絶対値は環境で動くので、**同じ機械での比**を見る。
    const measure = (count: number) => {
      const blocks = run(count);
      const oldDoc = doc(blocks);
      const newDoc = doc(blocks.map((block, index) => (
        index === count - 1 ? { ...block, text: "末尾を編集" } : block
      )));
      const guarded = new Set(blocks.slice(0, Math.floor(count / 5)).map((block) => block.id));
      const startedAt = performance.now();
      for (let index = 0; index < 5; index += 1) {
        findTouchedGuardedBlockIds(oldDoc, newDoc, guarded);
      }
      return performance.now() - startedAt;
    };

    // 小さい方を先に測って JIT を温めてから、両方を測る。
    measure(250);
    const small = Math.max(measure(250), 0.05);
    const large = measure(1000);

    // 4 倍のブロック数で、二乗なら 16 倍側・線形なら 4 倍側。境目に余裕を取って 9 倍。
    expect(large / small).toBeLessThan(9);
  });
});
