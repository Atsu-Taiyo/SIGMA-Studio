import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **文書を書き換える choke point は 2 つあり、AI ロックの読み方は同じでなければならない。**
 *
 * `commitDocumentChange` (通常の編集) と `restoreDocumentHistory` (履歴の巻き戻し) の
 * どちらも「AI が握っている対象を書き換えない」で守られている。ところが後者だけが
 * state のミラー (`mcpPreviewBusy` / render クロージャの `aiLockedTargets`) を読んでいた。
 * state はレンダー 1 回ぶん遅れて届くので、**書き込みが始まった直後の 1 手 —— いちばん
 * 危ない瞬間の ⌘Z —— だけがすり抜ける**。
 *
 * 振る舞いで押さえるには「AI 実行中に ⌘Z」を実機で作る必要があり (AI 編集ロックが
 * 打鍵を禁じるので e2e からは組めない)、配線を構造で固定する。
 */
const shellSource = readFileSync(
  fileURLToPath(new URL("../EditorShell.tsx", import.meta.url)),
  "utf8",
);

function bodyOf(from: string, to: string): string {
  const start = shellSource.indexOf(from);
  expect(start, `${from} が見つからない`).toBeGreaterThan(0);
  const end = shellSource.indexOf(to, start);
  expect(end, `${to} が見つからない`).toBeGreaterThan(start);
  return shellSource.slice(start, end);
}

const restoreBody = () => bodyOf(
  '  const restoreDocumentHistory = useCallback((direction: "undo" | "redo") => {',
  "  const undoDocumentChange = useCallback(() => {",
);

describe("AI lock reads at both document choke points", () => {
  it("reads the write-in-progress flag from the synchronous ref", () => {
    const body = restoreBody();
    expect(body).toContain("const aiDocumentWriteInProgress = mcpPreviewBusyRef.current;");
    // state ミラー (`mcpPreviewBusy`) を直に読んでいないこと。
    expect(body).not.toContain("= mcpPreviewBusy;");
  });

  it("reads the locked set from the synchronous ref", () => {
    const body = restoreBody();
    expect(body).toContain("const aiLockedTargets = aiLockedTargetsRef.current;");
  });

  it("keeps the AI state out of the dependency array", () => {
    // deps に入れると、保存のたびに動く提案プレビュー由来で識別子が変わり、ぶら下がる
    // 全コールバック → memo 済み本文ユニット全部が描き直される。
    const deps = bodyOf(
      "  }, [documentHistory, refreshMcpEditProposals, setActiveCommentThreadId,",
      "  const undoDocumentChange = useCallback(() => {",
    );
    expect(deps).not.toContain("aiDocumentWriteInProgress");
    expect(deps).not.toContain("aiLockedTargets");
  });

  it("guards on both the flag and the locked set before touching the stacks", () => {
    const body = restoreBody();
    const flag = body.indexOf("if (aiDocumentWriteInProgress) {");
    const peek = body.indexOf("documentHistory.peek(direction)");
    const touched = body.indexOf("findAiLockedTargetsTouched(");
    const swap = body.indexOf("documentRef.current = entry.document;");
    expect(flag).toBeGreaterThan(0);
    // 書き込み中の判定はスタックを覗くより前。覗いてから断ると、覗く行為自体は無害でも
    // 「なぜ止まったか」の順序が読み手に伝わらない。
    expect(flag).toBeLessThan(peek);
    // ロック判定は文書を差し替えるより前。**呼ぶだけでなく、触れていたら降りること。**
    // 呼び出しの存在だけを見ると、`if` ごと消す変異が素通りする (実測)。
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThan(swap);
    const refusal = body.slice(touched, swap);
    expect(refusal).toContain("if (hasAiLockedTargetsTouched(touchedAiTargets)) {");
    expect(refusal).toContain("setStatusMessage(describeAiLockedTargets(aiLockedTargets, touchedAiTargets));");
    expect(refusal).toContain("return;");
  });

  it("asks the same two questions the edit choke point asks", () => {
    const commit = bodyOf(
      "  const commitDocumentChange = useCallback((change: DocumentChange",
      "  const restoreDocumentHistory = useCallback(",
    );
    for (const read of [
      "const aiDocumentWriteInProgress = mcpPreviewBusyRef.current;",
      "const aiLockedTargets = aiLockedTargetsRef.current;",
    ]) {
      expect(commit, read).toContain(read);
      expect(restoreBody(), read).toContain(read);
    }
  });
});
