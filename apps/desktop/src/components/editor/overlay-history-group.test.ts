import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveOverlayCommitOptions } from "@/components/editor/EditorShell";
import { mergeOverlayHistoryGroup } from "@/components/editor/OverlayCanvasEditorClient";

/**
 * 混在ペースト / 混在カットのコアレスキーが、overlay の保存経路で正しく合成・翻訳されるか。
 *
 * どちらも「取りこぼし (戻せなくなる)」に直結する分岐なのに、コンポーネントの奥にあって
 * e2e からは 1 通りずつしか踏めない。純関数として切り出してここで全組み合わせを固定する。
 */

describe("mergeOverlayHistoryGroup", () => {
  it("keeps the key when both sides agree", () => {
    expect(mergeOverlayHistoryGroup("mixed_1", "mixed_1")).toBe("mixed_1");
  });

  it("adopts the key when the pending save has none", () => {
    // オーバーレイ編集に入るときの再アンカーがキー無しで窓に積まれているのは普通のこと
    // (実測で混在ペーストの直前に必ず 1 本)。ここでキーを捨てると畳めない。
    expect(mergeOverlayHistoryGroup(null, "mixed_1")).toBe("mixed_1");
  });

  it("keeps the key when the new request has none", () => {
    expect(mergeOverlayHistoryGroup("mixed_1", null)).toBe("mixed_1");
  });

  it("drops both keys when two different operations collide", () => {
    // 別々の混在操作が同じ窓に落ちたら畳まない。独立した undo エントリにするのが安全側。
    expect(mergeOverlayHistoryGroup("mixed_1", "mixed_2")).toBeNull();
  });

  it("stays keyless when neither side has one", () => {
    expect(mergeOverlayHistoryGroup(null, null)).toBeNull();
  });
});

describe("resolveOverlayCommitOptions", () => {
  it("passes the coalescing key through", () => {
    expect(resolveOverlayCommitOptions({ history: "record", historyGroup: "mixed_1" }))
      .toEqual({ historyGroup: "mixed_1" });
  });

  it("keeps coalesce for derived overlay geometry", () => {
    expect(resolveOverlayCommitOptions({ history: "coalesce" })).toEqual({ coalesce: true });
  });

  it("prefers the key over coalesce when both arrive", () => {
    // `coalesce` は record を丸ごとスキップする。キー付きの変更をそれに化けさせると、
    // その変更だけを戻せなくなる —— この設計が排除しようとしている唯一の消失形。
    // 今日の混在経路は全て `record` を要求するので到達しないが、順序を逆にした瞬間に
    // 静かに壊れるので優先順位を固定する。
    expect(resolveOverlayCommitOptions({ history: "coalesce", historyGroup: "mixed_1" }))
      .toEqual({ historyGroup: "mixed_1" });
  });

  it("asks for a plain record when nothing is specified", () => {
    expect(resolveOverlayCommitOptions()).toBeUndefined();
    expect(resolveOverlayCommitOptions({ history: "record" })).toBeUndefined();
  });
});

/**
 * コアレスキーを運ぶ ref の扱いは **ふるまいでは押さえられなかった** (e2e に実測の但し書き)。
 * 取り残し・畳みすぎはどちらも「あとから来る無関係な保存に紛れる」形なので、e2e からは
 * 掴み直しが挟む保存やテスト自身の遅さに隠れてしまう。**変異を当てて赤くなる形**として
 * 残せたのはソースの構造なので、そこを名指しで固定する。
 */
const overlaySource = readFileSync(
  fileURLToPath(new URL("./OverlayCanvasEditorClient.tsx", import.meta.url)),
  "utf8",
);
const textFlowSource = readFileSync(
  fileURLToPath(new URL("./TextFlowEditor.tsx", import.meta.url)),
  "utf8",
);
const shellSource = readFileSync(
  fileURLToPath(new URL("./EditorShell.tsx", import.meta.url)),
  "utf8",
);

function sliceOf(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `${from} が見つからない`).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, `${to} が見つからない`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function sliceBetween(from: string, to: string): string {
  const start = overlaySource.indexOf(from);
  expect(start, `${from} が見つからない`).toBeGreaterThan(0);
  const end = overlaySource.indexOf(to, start);
  expect(end, `${to} が見つからない`).toBeGreaterThan(start);
  return overlaySource.slice(start, end);
}

describe("overlay history group carrier", () => {
  it("reads and clears the key before the effect's early returns", () => {
    // ガードの後ろで読むと、早期 return したときにキーが取り残され、次の無関係な
    // 図形編集がそれを継承して単独では戻せなくなる。**読んだら必ず消す**。
    const effect = sliceBetween("    if (!mountedRef.current) {", "  }, [assets, commitOverlayChangeNow");
    const read = effect.indexOf("pendingOverlaySaveHistoryGroupRef.current = null;");
    const firstGuard = effect.indexOf("explicitlySavedShapeStatesRef.current.delete(shapes)");
    expect(read).toBeGreaterThan(0);
    expect(firstGuard).toBeGreaterThan(0);
    expect(read).toBeLessThan(firstGuard);
  });

  it("commits a keyed save immediately instead of debouncing it", () => {
    // debounce すると 250ms 窓の**後ろ側を縛るものが無く**、続けて起きた無関係な図形編集まで
    // 同じ undo エントリへ畳まれる。混在クリップボード操作は離散イベントなので待つ理由が無い。
    const effect = sliceBetween("    if (!mountedRef.current) {", "  }, [assets, commitOverlayChangeNow");
    const keyedBranch = effect.slice(effect.indexOf("if (historyGroup) {"));
    expect(keyedBranch).toContain("commitOverlayChangeNow({ historyGroup })");
    expect(keyedBranch.slice(0, keyedBranch.indexOf("return;"))).not.toContain("queueOverlaySave");
  });

  it("only stashes the cut key when a shape will actually be deleted", () => {
    // 選択が全てロック / 編集ポリシー禁止だと `deleteSelectedShapes` は何もせずに戻る。
    // それでもキーを置くと `setShapes` が走らず、誰も消費しないまま次の編集へ継承される。
    const handleCut = sliceBetween("    const handleCut = (event: ClipboardEvent) => {", "    const handlePaste =");
    const check = handleCut.indexOf("getRemovableSelectedShapeIds()");
    const stash = handleCut.indexOf("pendingOverlaySaveHistoryGroupRef.current =");
    expect(check).toBeGreaterThan(0);
    expect(stash).toBeGreaterThan(0);
    expect(check).toBeLessThan(stash);
  });

  it("lets an overlay instance that will not write the clipboard keep its hands off the cut mark", () => {
    // `takeBodyTextCut` の印は 1 回しか取れない。オーバーレイは複数マウントされうるので、
    // 書き出さないインスタンスが先に食うと、切り取った図形を持つ側に本文もキーも届かない。
    const handleCut = sliceBetween("    const handleCut = (event: ClipboardEvent) => {", "    const handlePaste =");
    const guard = handleCut.indexOf("if (!canWriteShapeClipboard(event)) {");
    const take = handleCut.indexOf("takeBodyTextCut(event)");
    expect(guard).toBeGreaterThan(0);
    expect(take).toBeGreaterThan(0);
    expect(guard).toBeLessThan(take);
    // 「選択が空でない」だけでは足りない。テキスト編集中・`clipboardData` 無し・
    // 選択が全てクリップボード対象外、のどれでも書き出しは中断するのに印だけ食われる。
    expect(handleCut).not.toContain("selectedIdsRef.current.length === 0");
  });

  it("asks the same question the clipboard writer asks", () => {
    // **条件は 1 箇所で持つ。** 2 箇所に書くと、片方だけ増えた瞬間にまた印が食い逃げされる。
    const predicate = sliceBetween(
      "    const canWriteShapeClipboard = (event: ClipboardEvent): boolean => {",
      "    /**\n     * 選択中の図形をクリップボードへ",
    );
    expect(predicate).toContain("activeTextEditorRef.current?.isFocused || !event.clipboardData");
    expect(predicate).toContain("getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current).length > 0");
    const writer = sliceBetween(
      "    const writeShapeClipboard = (",
      "    const handleCopy = (event: ClipboardEvent) => {",
    );
    expect(writer).toContain("if (!canWriteShapeClipboard(event) || !event.clipboardData) {");
  });
});

describe("body-side history group carrier", () => {
  it("drops the clipboard key when history is restored", () => {
    // 一致条件は**一意でない sequence 番号**なので、残したまま undo でカウンタが 0 に戻ると、
    // 同じ番号まで登り直したところで無関係な編集が古いキーで刻印される。
    const restore = sliceOf(
      textFlowSource,
      "    historyGroupingRef.current = createTextFlowHistoryGroupingState();",
      "  }, [",
    );
    // session の reset 後に同じ sequence を再利用しても古いキーが復活しないことは
    // clipboard-transactions.test.ts が実行で確認する。ここでは復元経路との接続順を守る。
    const reset = restore.indexOf("clipboardSession.resetHistory();");
    const syncContent = restore.indexOf("setTextFlowContentPreservingSelection(editor, blocks);");
    expect(reset).toBeGreaterThan(0);
    expect(syncContent).toBeGreaterThan(reset);
  });

  it("lets an IME composition group win over the clipboard key", () => {
    // 跨ぎ選択の IME 置換が混在操作と同じグルーピング区間で始まると、このユニットだけ
    // クリップボードのキーになり、**1 回の IME 置換が 2 エントリに割れる**。合成が強い括り。
    const call = sliceOf(textFlowSource, "        historyGroup: ", "        selection: selectionBookmark,");
    const composition = call.indexOf("spanCompositionGroup");
    const clipboard = call.indexOf("forcedClipboardGroup");
    expect(composition).toBeGreaterThanOrEqual(0);
    expect(clipboard).toBeGreaterThan(0);
    expect(composition).toBeLessThan(clipboard);
  });

  it("carries the key to the units a cross-editor replacement touches", () => {
    // 跨ぎ置換は `onUpdate` を通らずに本文を書く。再チャンクが起こす後続の `onUpdate` に
    // キーが乗らないと、本文書き込みと 250ms 後の図形保存の**間に別エントリが挟まる**。
    const onUpdate = sliceOf(textFlowSource, "      clearBoxFragmentSelection();", "      const historyGrouping =");
    const read = onUpdate.indexOf("crossEditorSyncRef.current?.historyGroup");
    const clear = onUpdate.indexOf("crossEditorSyncRef.current = null;");
    expect(read).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
    expect(read).toBeLessThan(clear);
  });

  it("routes the page layout overlay through the same commit resolution", () => {
    // running region (ヘッダ / フッタ) の overlay もここを通る。素のインライン判定のままだと
    // そちらに属する図形を含む混在操作だけ 2 エントリになる。
    // 判定は `resolveOverlayCommitOptions` の**外側**だけを見る (関数自身の本体には
    // インライン判定が残っていて当然なので、素朴に全文を見ると常に落ちる)。
    const helperEnd = shellSource.indexOf("}", shellSource.indexOf('return options?.history === "coalesce"'));
    const callers = shellSource.slice(helperEnd);
    expect(callers).not.toMatch(/options\?\.history === "coalesce" \? \{ coalesce: true \} : undefined/u);
    expect(callers.match(/resolveOverlayCommitOptions\(options\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
