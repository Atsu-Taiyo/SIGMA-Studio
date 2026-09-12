import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  decideExternalDocumentChange,
  nextObservedRevisionAfterQuietOutcome,
  queueLatestDocumentChange,
  recordSuccessfulDocumentSave,
  saveBeforeDocumentReplacement,
  syncDocumentRefWhenStateIsCurrent,
  takeLatestDocumentChange,
} from "./document-state-sync";

describe("syncDocumentRefWhenStateIsCurrent", () => {
  it("does not roll the ref back when an older state renders before a deferred update", () => {
    const staleDocument = { id: "stale" };
    const latestDocument = { id: "latest" };
    const documentRef = { current: latestDocument };

    expect(syncDocumentRefWhenStateIsCurrent(
      documentRef,
      staleDocument,
      0,
      1,
    )).toBe(false);
    expect(documentRef.current).toBe(latestDocument);
  });

  it("syncs the ref after state catches up to the latest revision", () => {
    const previousDocument = { id: "previous" };
    const latestDocument = { id: "latest" };
    const documentRef = { current: previousDocument };

    expect(syncDocumentRefWhenStateIsCurrent(
      documentRef,
      latestDocument,
      1,
      1,
    )).toBe(true);
    expect(documentRef.current).toBe(latestDocument);
  });
});

describe("busy中の外部文書変更", () => {
  it("reject/rebase中の最新イベントをbusy解除後に処理し、次の編集を新revisionで保存できる", () => {
    for (const operation of ["reject", "rebase"]) {
      const pendingRef = {
        current: null as { timestamp: number; revision: number; text: string } | null,
      };
      let busy = true;
      let observedRevision = 4;
      let documentText = "編集前";
      const savedWrites: Array<{ observedRevision: number; text: string }> = [];
      const dispatch = (event: { timestamp: number; revision: number; text: string }) => {
        if (busy) {
          queueLatestDocumentChange(pendingRef, event);
          return;
        }
        observedRevision = event.revision;
        documentText = event.text;
      };

      // reject/rebase自身は正本スナップショットを返さない。その待機中に、別のwriterが
      // revision 5、続けて6を書いた状況を再現する。
      dispatch({ timestamp: 10, revision: 5, text: `${operation}中の外部変更1` });
      dispatch({ timestamp: 12, revision: 6, text: `${operation}中の外部変更2` });
      dispatch({ timestamp: 11, revision: 5, text: "遅れて届いた古い通知" });
      expect(documentText).toBe("編集前");

      busy = false;
      const pending = takeLatestDocumentChange(pendingRef);
      expect(pending).toMatchObject({ timestamp: 12, revision: 6 });
      if (pending) {
        dispatch(pending);
      }

      documentText += " + 後続の入力";
      savedWrites.push({ observedRevision, text: documentText });
      expect(savedWrites).toEqual([{
        observedRevision: 6,
        text: `${operation}中の外部変更2 + 後続の入力`,
      }]);
      expect(pendingRef.current).toBeNull();
    }
  });
});

describe("successful autosave bookkeeping", () => {
  it("records an in-flight save after effect cleanup when typing resumes in the same file", () => {
    const oldDocument = { text: "保存前" };
    const savedDocument = { text: "保存済み" };
    const savedByFileId = new Map();
    const observedRevisionRef = { current: 4 as number | null };
    const lastSavedDocumentRef = { current: oldDocument };
    const lastSavedDirtyRevisionRef = { current: 1 };
    const lastSyncedDocumentRef = { current: oldDocument };

    expect(recordSuccessfulDocumentSave({
      savedByFileId,
      save: { fileId: "file_1", document: savedDocument, revision: 5, dirtyRevision: 2 },
      activeFileId: "file_1",
      observedRevisionRef,
      lastSavedDocumentRef,
      lastSavedDirtyRevisionRef,
      lastSyncedDocumentRef,
    })).toBe(true);
    expect(savedByFileId.get("file_1")).toMatchObject({ revision: 5, dirtyRevision: 2 });
    expect(observedRevisionRef.current).toBe(5);
    expect(lastSavedDocumentRef.current).toBe(savedDocument);
    expect(lastSavedDirtyRevisionRef.current).toBe(2);
    expect(lastSyncedDocumentRef.current).toBe(savedDocument);
  });

  it("records an inactive file save without mutating the active document refs", () => {
    const activeDocument = { text: "別タブ" };
    const savedByFileId = new Map();
    const observedRevisionRef = { current: 9 as number | null };
    const lastSavedDocumentRef = { current: activeDocument };
    const lastSavedDirtyRevisionRef = { current: 7 };
    const lastSyncedDocumentRef = { current: activeDocument };

    expect(recordSuccessfulDocumentSave({
      savedByFileId,
      save: { fileId: "file_old", document: { text: "保存済み" }, revision: 5, dirtyRevision: 2 },
      activeFileId: "file_active",
      observedRevisionRef,
      lastSavedDocumentRef,
      lastSavedDirtyRevisionRef,
      lastSyncedDocumentRef,
    })).toBe(false);
    expect(savedByFileId.get("file_old")).toMatchObject({ revision: 5, dirtyRevision: 2 });
    expect(observedRevisionRef.current).toBe(9);
    expect(lastSavedDocumentRef.current).toBe(activeDocument);
    expect(lastSavedDirtyRevisionRef.current).toBe(7);
    expect(lastSyncedDocumentRef.current).toBe(activeDocument);
  });
});

describe("document replacement save gate", () => {
  it("keeps the current tab open and starts conflict recovery on a CAS mismatch", async () => {
    let activeFileId = "file_current";
    let conflictRecoveryRequested = false;
    const canSwitch = await saveBeforeDocumentReplacement({
      save: async () => ({ ok: false, code: "revision-mismatch", error: "revision mismatch" }),
      isDirtyAfterSave: () => true,
      onFailure: (result) => {
        conflictRecoveryRequested = result.code === "revision-mismatch";
      },
    });
    if (canSwitch) {
      activeFileId = "file_next";
    }

    expect(canSwitch).toBe(false);
    expect(activeFileId).toBe("file_current");
    expect(conflictRecoveryRequested).toBe(true);
  });

  it.each([
    "external-change-pending",
    "ai-write-in-progress",
    "revision-unknown",
    "embedded",
    "workspace-not-ready",
    "document-open-failed",
    undefined,
  ])("blocks a dirty skipped boundary before replacement (%s)", async (skippedReason) => {
    const onFailure = vi.fn();
    const canSwitch = await saveBeforeDocumentReplacement({
      save: async () => ({ ok: true, skipped: true, skippedReason }),
      isDirtyAfterSave: () => true,
      onFailure,
    });

    expect(canSwitch).toBe(false);
    expect(onFailure).toHaveBeenCalledWith({ ok: true, skipped: true, skippedReason });
  });

  it("allows a clean skipped boundary before replacement", async () => {
    const onFailure = vi.fn();
    const canSwitch = await saveBeforeDocumentReplacement({
      save: async () => ({ ok: true, skipped: true, skippedReason: "workspace-not-ready" }),
      isDirtyAfterSave: () => false,
      onFailure,
    });

    expect(canSwitch).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

/**
 * 外部変更通知をどう扱うかの分類。
 *
 * **`resetEditorDocument` は `documentHistory.clear()` + オーバーレイ再マウントで、
 * 「軽い再読込」ではない。** そして **undo できるかは「誰が書いたか」で決まる** ——
 * 自分たちの自動適用 (AI 承認) は 1 手として積み、本物の外部書き込みは積まない
 * (積むと ⌘Z + autosave で外部の書き手の変更をディスク上から消してしまう)。
 * どの入力でどこへ行くかを表で固定する。
 */
describe("decideExternalDocumentChange", () => {
  const base = { id: "base" };
  const mine = { id: "mine" };
  const theirs = { id: "theirs" };
  const merged = { id: "merged" };

  const equivalentById = (a: { id: string }, b: { id: string }) => a.id === b.id;
  const mergeSucceeds = () => ({ ok: true as const, merged });
  const mergeFails = () => ({ ok: false as const, reason: "conflict" });

  function decide(overrides: Partial<Parameters<typeof decideExternalDocumentChange<{ id: string }>>[0]> = {}) {
    return decideExternalDocumentChange<{ id: string }>({
      fileId: "file_1",
      loadedDocument: theirs,
      loadedRevision: 7,
      currentDocument: mine,
      lastSyncedDocument: base,
      lastSuccessfulSave: undefined,
      isDirty: false,
      isOwnAutomation: false,
      areEquivalent: equivalentById,
      merge: mergeSucceeds,
      ...overrides,
    });
  }

  function savedAs(document: { id: string }, revision: number, fileId = "file_1") {
    return { fileId, document, revision, dirtyRevision: 1 };
  }

  it("treats a notification carrying our own save as a self write", () => {
    // 2 つの await の間に打鍵が入ると `currentDocument` が動き、内容の等価判定だけでは
    // 自分の保存だと分からなくなる。revision で見分ける。
    expect(decide({ loadedRevision: 7, lastSuccessfulSave: savedAs(theirs, 7) }))
      .toEqual({ kind: "selfWrite" });
  });

  it("does not call a newer revision our own save", () => {
    // 保存は CAS で守られていて revision はファイル単位で単調増加する。外部 writer が
    // 我々のあとに書けば必ず `> lastSave.revision` になる。
    expect(decide({ loadedRevision: 8, lastSuccessfulSave: savedAs(theirs, 7) }))
      .not.toEqual({ kind: "selfWrite" });
  });

  it("does not call another file's save our own", () => {
    expect(decide({ loadedRevision: 7, lastSuccessfulSave: savedAs(theirs, 7, "file_2") }))
      .not.toEqual({ kind: "selfWrite" });
  });

  it("still calls it a self write when normalization drifted the payload", () => {
    // **内容の一致を AND で足してはいけない。** 比べる相手は「正規化後のディスク内容」と
    // 「正規化前の自分が書いた文書」で、最上位 id が重複した文書では
    // `repairDuplicateTopLevelIds` がリロードのたびに新しい id を振り直すので常に不一致になる
    // —— つまり保険どころか、実機で最も疑わしい並びをちょうど取りこぼす。
    expect(decide({
      loadedRevision: 7,
      lastSuccessfulSave: savedAs({ id: "normalized-differently" }, 7),
    })).toEqual({ kind: "selfWrite" });
  });

  it("stays a no-op when the payload already matches the current document", () => {
    expect(decide({ loadedDocument: mine })).toEqual({ kind: "alreadyInSync" });
  });

  it("reloads a clean foreign write instead of keeping history", () => {
    // **他者の書き込みで履歴を残してはいけない。** undo は文書を丸ごと差し替えるので、
    // 採用前のスナップショットがスタックに残っていると ⌘Z 1 回で外部の変更がメモリから
    // 消え、dirty 判定になった autosave が採用済み revision で書き戻して
    // **ディスク上の他者の変更を消す**。
    expect(decide({ isDirty: false, isOwnAutomation: false }))
      .toEqual({ kind: "backupAndReload", reason: "foreign whole-document replacement" });
  });

  it("adopts our own clean automation as one undo step", () => {
    // AI 承認はユーザーから見れば自分の操作。⌘Z で戻せなければならない。
    expect(decide({ isDirty: false, isOwnAutomation: true })).toEqual({
      kind: "adoptAsHistoryStep",
      document: theirs,
      backupFirst: false,
      replacesWholeDocument: true,
    });
  });

  it("adopts a foreign merge without touching history at all", () => {
    // 積みも消しもしない軽量経路。打鍵中に着弾するので選択やパネルにも触らない。
    expect(decide({ isDirty: true, isOwnAutomation: false, merge: mergeSucceeds }))
      .toEqual({ kind: "adoptMergedFromForeignWrite", merged });
  });

  it("records our own automation even when it had to merge", () => {
    expect(decide({ isDirty: true, isOwnAutomation: true, merge: mergeSucceeds })).toEqual({
      kind: "adoptAsHistoryStep",
      document: merged,
      backupFirst: false,
      // マージ結果は全文置換ではないので、後始末はしない。
      replacesWholeDocument: false,
    });
  });

  it("keeps history for our own automation that could not merge", () => {
    // 退避してから 1 手として積む。**ここを全消しに落とすと、この PR が名指しした経路
    // (AI 挿入直後) でむしろ悪化する。**
    expect(decide({ isDirty: true, isOwnAutomation: true, merge: mergeFails })).toEqual({
      kind: "adoptAsHistoryStep",
      document: theirs,
      backupFirst: true,
      replacesWholeDocument: true,
    });
  });

  it("falls back to backup and reload for a foreign write that cannot merge", () => {
    expect(decide({ isDirty: true, isOwnAutomation: false, merge: mergeFails }))
      .toEqual({ kind: "backupAndReload", reason: "conflict" });
  });

  it("prefers the self-write verdict over a dirty merge", () => {
    expect(decide({
      isDirty: true,
      merge: mergeFails,
      loadedRevision: 7,
      lastSuccessfulSave: savedAs(theirs, 7),
    })).toEqual({ kind: "selfWrite" });
  });
});

/**
 * 履歴を全消しする権利が 1 か所に閉じているか。
 *
 * `resetEditorDocument` は `documentHistory.clear()` + オーバーレイ再マウントで、
 * **一度呼ばれたらそれ以前の人手編集は二度と戻せない**。分岐が増えたときに 2 つ目の
 * 呼び出しが紛れ込んでも、ふるまいのテストからは「たまたまその経路を踏まなかった」と
 * 区別がつかないので、構造で固定する。
 */
const shellSource = readFileSync(
  fileURLToPath(new URL("../EditorShell.tsx", import.meta.url)),
  "utf8",
);
const storageSyncSource = readFileSync(
  fileURLToPath(new URL("./document-storage-sync.ts", import.meta.url)),
  "utf8",
);

function processDocumentChangeBody(): string {
  const start = storageSyncSource.indexOf("  const processDocumentChange = (event: DocumentStorageChangeEvent) => {");
  expect(start, "processDocumentChange が見つからない").toBeGreaterThan(0);
  const end = storageSyncSource.indexOf("  documentStorageChangeProcessorRef.current = processDocumentChange;", start);
  expect(end, "processDocumentChange の終端が見つからない").toBeGreaterThan(start);
  return storageSyncSource.slice(start, end);
}

describe("external document change wiring", () => {
  it("keeps exactly one history-clearing entry point", () => {
    const body = processDocumentChangeBody();
    expect(body.match(/resetEditorDocument\(/gu)?.length ?? 0).toBe(1);
  });

  it("reaches that entry point only after a backup was attempted", () => {
    // 退避せずに履歴を消すと、未保存の編集が黙って消える。
    const body = processDocumentChangeBody();
    const backup = body.lastIndexOf("await saveUnsavedEditBackup()");
    const reset = body.indexOf("resetEditorDocument(");
    expect(backup).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(backup);
  });

  it("classifies through the shared decision instead of inlining the branches again", () => {
    const body = processDocumentChangeBody();
    expect(body).toContain("decideExternalDocumentChange<SigmaDocument>({");
    // 自分の保存かどうかは revision で見分ける。内容の等価判定だけに戻すと、
    // 2 つの await の間の打鍵でまた履歴が消える。
    expect(body).toContain("lastSuccessfulSave: successfulDocumentSavesRef.current.get(eventFileId)");
    // 作者で分ける。ここを固定値にすると、他者の書き込みが 1 手として積まれて
    // ⌘Z + autosave でディスク上から消える (あるいは AI 適用が戻せなくなる)。
    expect(body).toContain("isOwnAutomation: autoAppliedProposalIds.length > 0");
  });

  it("waits for an in-flight save before classifying", () => {
    // self-write 判定は保存完了後に書かれる記録を読む。待たないと 1 つ前の保存を見て
    // 「外部変更」と誤判定し、古い lastSynced に対してマージ → 衝突 → 履歴全消しになる。
    const body = processDocumentChangeBody();
    const drain = body.indexOf("while (inFlightSavePromiseRef.current)");
    const classify = body.indexOf("decideExternalDocumentChange<SigmaDocument>({");
    expect(drain).toBeGreaterThan(0);
    expect(classify).toBeGreaterThan(drain);
  });

  it("binds each adoption call to the flag that is supposed to decide it", () => {
    // **存在検査では足りない** —— 3 つの呼び出しが「在る」ことだけを見ると、分岐順を
    // 入れ替えて `replacesWholeDocument` を無視しても緑のまま通る。どのフラグがどの
    // 呼び出しを決めるかを固定する。
    const body = processDocumentChangeBody();

    const ownBranch = body.indexOf('if (outcome.kind === "adoptAsHistoryStep") {');
    expect(ownBranch).toBeGreaterThan(0);
    const foreignMergeBranch = body.indexOf('if (outcome.kind === "adoptMergedFromForeignWrite") {');
    expect(foreignMergeBranch).toBeGreaterThan(ownBranch);

    // 自分たちの適用 → 記録経路。退避は `backupFirst`、後始末は `replacesWholeDocument`。
    const own = body.slice(ownBranch, foreignMergeBranch);
    expect(own).toContain("applyAutoApprovedExternalDocument({");
    expect(own).toContain("outcome.backupFirst ? await saveUnsavedEditBackup() : null");
    expect(own).not.toContain("resetEditorDocument(");
    expect(own).not.toContain("applyMergedExternalDocument(");

    // 他者のマージ採用 → 軽量経路。履歴にも退避にも触らない。
    const foreignMerge = body.slice(foreignMergeBranch, body.indexOf("// ここから下だけが履歴を失う経路", foreignMergeBranch));
    expect(foreignMerge).toContain("applyMergedExternalDocument(outcome.merged");
    expect(foreignMerge).not.toContain("saveUnsavedEditBackup()");
    expect(foreignMerge).not.toContain("resetEditorDocument(");
    expect(foreignMerge).not.toContain("applyAutoApprovedExternalDocument(");
  });

  it("consumes the pending proposal ids as soon as it reads them", () => {
    // 取り残すと、次の純粋な他者書き込みが own automation と誤判定され、1 手として
    // 積まれて ⌘Z + autosave で相手の変更をディスクから消す。
    const body = processDocumentChangeBody();
    const read = body.indexOf("const autoAppliedProposalIds =");
    const consume = body.indexOf("pendingAutoAppliedProposalIdsByFileRef.current.delete(eventFileId);", read);
    const classify = body.indexOf("decideExternalDocumentChange<SigmaDocument>({");
    expect(read).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(read);
    expect(classify).toBeGreaterThan(consume);
  });

  it("asks the shared rule how far to move the observed revision", () => {
    // 採り方は結末で違う (`selfWrite` は後退させない / `alreadyInSync` はディスクに従う)。
    // **その場に `Math.max` を書くと `alreadyInSync` まで clamp して保存が壊れる**ので、
    // 判断は純関数に置いて振る舞いテスト側で押さえる (上の `nextObservedRevisionAfterQuietOutcome`)。
    const body = processDocumentChangeBody();
    const selfWrite = body.indexOf('if (outcome.kind === "selfWrite"');
    expect(selfWrite).toBeGreaterThan(0);
    const branch = body.slice(selfWrite, body.indexOf('if (outcome.kind === "adopt") {', selfWrite));
    expect(branch).toContain("nextObservedRevisionAfterQuietOutcome({");
    expect(branch).toContain("outcome: outcome.kind,");
    expect(branch).not.toContain("Math.max(");
  });
});

describe("external document adoption", () => {
  function bodyOf(from: string, to: string): string {
    const start = shellSource.indexOf(from);
    expect(start, `${from} が見つからない`).toBeGreaterThan(0);
    const end = shellSource.indexOf(to, start);
    expect(end).toBeGreaterThan(start);
    return shellSource.slice(start, end);
  }

  it("always clears history when it replaces the document wholesale", () => {
    // 「後始末はするが履歴は残す」形は採れない —— 採用前のスナップショットが残っていると
    // ⌘Z 1 回で外部の変更が消え、autosave がそれをディスクへ書き戻す。
    const body = bodyOf("  const resetEditorDocument = useCallback((", "\n  const rememberLeavingEditorTabViewState");
    expect(body).toContain("documentHistory.clear();");
    expect(body).not.toContain("preserveHistory");
  });

  it("leaves the merged adoption path light", () => {
    // 打鍵中に着弾するので、数式欄の編集中に選択を落とさない。
    const body = bodyOf("  const applyMergedExternalDocument = useCallback((", "  }, [setDocument, setSelectedId]);");
    expect(body).not.toContain("documentHistory.record(");
    expect(body).not.toContain("documentHistory.clear(");
    expect(body).not.toContain("setSelectedInlineMath(null)");
    expect(body).not.toContain("materialBlockSelectionRef.current = null");
    // ただし id 重複の修復は通す (マージ結果は mine と theirs の継ぎ合わせ)。
    expect(body).toContain("repairDuplicateTopLevelIds(");
  });

  it("records the AI approval adoption instead of clearing history", () => {
    // ここが `resetEditorDocument` を呼んでいた頃は、承認のたびに履歴が全消しになっていた。
    // 現在は承認待ち中の入力と競合しても同じ教材内でAI側を優先してマージし、
    // 採用直前の文書を1手として積むため、別教材への退避も履歴全消去も行わない。
    const body = bodyOf("  const applyAiApprovedDocument = useCallback((", "  const refreshDocumentMetadatas");
    expect(body).not.toContain("resetEditorDocument(");
    expect(body).toContain("documentHistory.record({");
    expect(body).toContain("decideAiApprovedDocument({");
  });
});

describe("nextObservedRevisionAfterQuietOutcome", () => {
  it("never walks the observed revision backwards for its own echo", () => {
    // 自分の保存のエコー。古い watcher 読み取りで ref を下げると次の保存が CAS 失敗する。
    expect(nextObservedRevisionAfterQuietOutcome({
      outcome: "selfWrite",
      currentObservedRevision: 12,
      loadedRevision: 9,
    })).toBe(12);
  });

  it("takes the loaded revision when it has moved forward", () => {
    expect(nextObservedRevisionAfterQuietOutcome({
      outcome: "selfWrite",
      currentObservedRevision: 12,
      loadedRevision: 15,
    })).toBe(15);
  });

  it("falls back to the loaded revision when nothing was observed yet", () => {
    expect(nextObservedRevisionAfterQuietOutcome({
      outcome: "selfWrite",
      currentObservedRevision: null,
      loadedRevision: 4,
    })).toBe(4);
  });

  it("lets a legitimately lower revision through when the disk already matches", () => {
    // **ここを clamp すると保存が再起動まで壊れる。** 台帳の再構築やバックアップからの
    // 復元でディスクの revision は正当に下がる。ref が上に張り付いたままだと、以降の
    // `ObservedDocumentWrite` が**すべて** CAS 失敗する。素の代入は自己修復していた。
    expect(nextObservedRevisionAfterQuietOutcome({
      outcome: "alreadyInSync",
      currentObservedRevision: 40,
      loadedRevision: 3,
    })).toBe(3);
  });

  it("still follows the disk upward when it matches", () => {
    expect(nextObservedRevisionAfterQuietOutcome({
      outcome: "alreadyInSync",
      currentObservedRevision: 3,
      loadedRevision: 40,
    })).toBe(40);
  });
});
