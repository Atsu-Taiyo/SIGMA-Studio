import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * **自分の保存が undo スタックを消さないこと。**
 *
 * 実機の fs watcher は「誰が書いたか」を知らないので、自分の autosave でも
 * `storage:changed` が返ってくる。レンダラがそれを外部変更と誤読すると
 * `resetEditorDocument` → `documentHistory.clear()` まで走り、⌘Z が
 * 「戻せる操作がありません」になる —— 報告された「AI で挿入した時に戻せない」の正体。
 *
 * 通知が届くまでに `refreshDocumentMetadatas` と `loadWorkspaceDocument` の 2 つの await が
 * あるので、その間の打鍵で内容の等価判定は落ちる。**revision で自分の書き込みだと
 * 見分けられるか**がここで測っていること。
 *
 * ⚠️ **この 3 本は修正の証明にはならない** (実測)。修正前の `EditorShell` に戻しても緑のまま
 * だった。理由も特定済みで、この mock 経由の autosave では 3-way マージが必ず成功してしまい
 * (`lastSyncedDocumentRef` が毎回追いつくので両側が同じブロックを触った形にならない)、
 * 履歴を消す `backupAndReload` へ到達しない。到達には `lastSyncedDocumentRef` が古いまま
 * 残る並びが要るが、決定的に作れなかった。
 *
 * したがって修正の証明は `editor-shell/document-state-sync.test.ts` が持つ —— 分類の真理値表
 * (どの入力がどの結末になるか) と、`resetEditorDocument` の入口が 1 つだけであることの構造
 * 検査で、どちらも変異に 1:1 で反応する。ここが押さえるのは「利用者から見て autosave をまたい
 * でも ⌘Z が効く」という回帰網まで。
 */

const BODY_BLOCK_ID = "p_autosave_undo";
const TYPED_TEXT = "自動保存のあとに戻せる本文";

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_autosave_undo_survival";
  document.metadata = { ...document.metadata, title: "自動保存と Undo の E2E" };
  document.content = [{
    type: "paragraph",
    id: BODY_BLOCK_ID,
    children: [{ type: "text", text: "元の本文" }],
  }];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument(), { emitWatcherEventOnSave: true });
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(".page-flow .text-flow-editor").first()).toBeVisible();
}

/** 保存済みの本文 (mock が localStorage に置く正本)。 */
async function savedBodyText(page: Page): Promise<string> {
  return page.evaluate((blockId) => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const value: unknown = raw ? JSON.parse(raw) : null;
    const find = (entry: unknown): string | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (record.id === blockId && Array.isArray(record.children)) {
        return (record.children as Array<{ text?: string }>).map((child) => child.text ?? "").join("");
      }
      for (const child of Object.values(record)) {
        const found = find(child);
        if (found !== null) return found;
      }
      return null;
    };
    return find(value) ?? "";
  }, BODY_BLOCK_ID);
}

test("keeps the undo stack across an autosave of our own edit", async ({ page }) => {
  await openEditor(page);
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first();

  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(TYPED_TEXT);
  await expect(paragraph).toContainText(TYPED_TEXT);

  // 自動保存 (450ms デバウンス) が落ちて、その watcher 通知まで往復するのを待つ。
  await expect.poll(async () => savedBodyText(page), { timeout: 10_000 }).toContain(TYPED_TEXT);

  await page.keyboard.press("ControlOrMeta+Z");

  await expect(paragraph).not.toContainText(TYPED_TEXT);
  await expect(page.locator(".save-state").first()).not.toContainText("戻せる変更がありません");
});

test("keeps typing after an autosave undoable when the caret keeps moving", async ({ page }) => {
  // 2 つの await の間も打鍵が続くケース。内容の等価判定は必ず落ちるので、
  // revision で見分けられていないとここで履歴が消える。
  await openEditor(page);
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first();

  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("最初の追記");
  await expect.poll(async () => savedBodyText(page), { timeout: 10_000 }).toContain("最初の追記");

  await page.keyboard.type("続きの追記");
  await expect(paragraph).toContainText("続きの追記");
  await expect.poll(async () => savedBodyText(page), { timeout: 10_000 }).toContain("続きの追記");

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraph).not.toContainText("続きの追記");

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraph).not.toContainText("最初の追記");
});

test("survives a watcher notification that lands mid-load while typing continues", async ({ page }) => {
  // **実機で踏んでいるのはこの窓。** watcher 通知を受けてから文書を読み直すまでに
  // `refreshDocumentMetadatas` と `loadWorkspaceDocument` の 2 つの await があり、その間の
  // 打鍵で `documentRef.current` が動く。すると内容の等価判定が落ち、同じブロックを両側が
  // 触った形になって 3-way マージも失敗し、**退避 + 全文リロード = `documentHistory.clear()`**
  // まで走る。読み込みを遅らせてその窓を確実に開ける。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument(), {
    emitWatcherEventOnSave: true,
    storageLoadDelayMs: 700,
  });
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first();
  await expect(paragraph).toBeVisible();

  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("あ");
  // 自動保存 (450ms デバウンス) が落ちて watcher 通知が動き出し、読み込みで止まっている頃。
  await page.waitForTimeout(600);
  await page.keyboard.type("い");
  await expect(paragraph).toContainText("元の本文あい");
  // 遅延読み込みが解決して分類が走り切るまで待つ。
  await page.waitForTimeout(1500);

  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Z");

  // 履歴が消えていれば 1 手目で「戻せる変更がありません」になり、ここまで戻らない。
  await expect(paragraph).toHaveText("元の本文");
});
