import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensurePageLayout, type InlineNode, type SigmaDocument } from "@/features/document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { findBlock } from "@/lib/document-tree";
import { sampleDocument } from "@/lib/sample-document";

/**
 * 提案の後に人が対象を直しても、承認は三者マージで両方を残す (MISS R2)。実アプリ (Electron main の
 * 承認・保存、実際のローカル MCP サーバー、renderer のプレビュー) で、作成 → 人の編集 → 紙面の
 * プレビュー → 承認 → 保存 → Undo/Redo → 再起動 (R4) までを通す。
 *
 * - 人の編集は紙面への打鍵 (保留中の提案の対象はロックしない) と保存 IPC (外部の変更・別の窓の
 *   保存と同じ) の両方で入れ、提案の後に対象が変わった状態を作る。合成できない対象 (base を持たない
 *   旧レコードの対象) だけは、従来どおり紙面で読み取り専用になる。
 * - 重なりの無い通常の承認では、合成のフォールバックの印 (renderer の `AiProposalMerge.*` と main の
 *   ledger の `proposal-merge-fallback`) が 0 (R3)。renderer の印は計測が有効なビルド (next dev) で
 *   だけ読めるので、静的ビルドでは main の ledger だけを見る。
 * - base を持たない旧レコードは従来どおり content-stale の競合として残り、紙面にカードを出さない。
 */

const APP_ROOT = path.resolve(__dirname, "../..");
const BASE_TEXT = "The cat sat on the mat.";

function text(value: string): InlineNode {
  return { type: "text", text: value };
}

function paragraphText(document: SigmaDocument | null, id: string): string {
  const block = document ? findBlock(document, id) : null;
  const children = (block as { children?: InlineNode[] } | null)?.children ?? [];
  return children.map((node) => (node.type === "text" ? node.text : "")).join("");
}

function withParagraphText(document: SigmaDocument, id: string, value: string): SigmaDocument {
  return {
    ...document,
    content: document.content.map((block) => (block.id === id ? { ...block, children: [text(value)] } as typeof block : block)),
  };
}

test("an approval merges the human's edit made after the proposal, survives a restart and undoes to the pre-approval document", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-ai-proposal-merge-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const ledgerPath = path.join(profile, "data", "logs", "ledger.log");
  const readLedger = () => {
    try {
      return readFileSync(ledgerPath, "utf8");
    } catch {
      return "";
    }
  };

  let app: ElectronApplication = await launch();
  let client = new Client({ name: "ai-proposal-merge-regression", version: "1" });
  try {
    let page: Page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    const source = ensurePageLayout({ ...sampleDocument, docId: "ai_proposal_merge", metadata: { title: "提案の合成" }, content: [
      { type: "paragraph", id: "p_quiet", children: [text("Quiet target paragraph.")] },
      { type: "paragraph", id: "p_diff", children: [text(BASE_TEXT)] },
      { type: "paragraph", id: "p_typed", children: [text(BASE_TEXT)] },
      { type: "paragraph", id: "p_same", children: [text(BASE_TEXT)] },
      { type: "paragraph", id: "p_legacy", children: [text("Legacy target paragraph.")] },
    ] });
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const fileId = created.file.fileId;
    await page.reload();
    await expect(page.locator('[data-sigma-doc-id="p_diff"]').first()).toBeVisible();

    const connect = async () => {
      client = new Client({ name: "ai-proposal-merge-regression", version: "1" });
      await client.connect(new StdioClientTransport({
        command: await app.evaluate(() => process.execPath),
        args: [path.join(APP_ROOT, "dist-electron/sigma-doc-mcp-server.cjs")],
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_MCP_TOOL_PROFILE: "app" },
        stderr: "pipe",
      }));
    };
    await connect();

    const revision = async () => (await page.evaluate(() => window.desktopAPI!.storage.listFiles()))
      .find((file) => file.fileId === fileId)!.revision;
    const pendingProposals = () => page.evaluate(() => window.desktopAPI!.storage.listMcpEditProposals({ status: "pending" }));
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    /** AI がこの段落の語を書き換える提案を、実際の MCP ツールで作る。 */
    const propose = async (blockId: string, from: string, to: string) => {
      const result = await client.callTool({ name: "edit_text", arguments: {
        fileId,
        expectedRevision: await revision(),
        edit: { action: "patch", operations: [{ op: "replace_text", target: { type: "text", blockId, text: from }, replacement: to }] },
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
      const proposal = (await pendingProposals()).find((item) => item.fileId === fileId && item.changedIds.includes(blockId));
      expect(proposal, `pending proposal for ${blockId}`).toBeDefined();
      return proposal!;
    };
    /** 人の編集を保存する (保存 IPC。renderer の自動保存と同じ CAS を通る)。 */
    const saveHumanEdit = async (blockId: string, value: string) => {
      const current = await saved();
      const result = await page.evaluate(async ({ id, document, expectedRevision }) => (
        window.desktopAPI!.storage.saveDocument(id, document, { expectedRevision })
      ), { id: fileId, document: withParagraphText(current!, blockId, value), expectedRevision: await revision() });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    };
    const reload = async () => {
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden();
      await expect(page.locator('[data-sigma-doc-id="p_diff"]').first()).toBeVisible();
    };
    const pageCard = (blockId: string) => page.locator(`.page-flow [data-flow-extension-node-id^="extension:ai-proposal:${blockId}:"] > [data-ai-proposal-card="page"]`);
    const bodyParagraph = (blockId: string) => page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`).first();
    /** 紙面の段落の末尾にキャレットを置いて打鍵する (人の編集を実際の編集面から入れる)。 */
    const typeAtParagraphEnd = async (blockId: string, value: string) => {
      await page.evaluate((targetBlockId) => {
        const target = Array.from(document.querySelectorAll<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`))
          .find((element) => element.getClientRects().length > 0);
        const walker = target ? document.createTreeWalker(target, NodeFilter.SHOW_TEXT) : null;
        let last: Text | null = null;
        for (let node = walker?.nextNode(); node; node = walker?.nextNode()) last = node as Text;
        if (!target || !last) throw new Error(`caret target not found: ${targetBlockId}`);
        target.scrollIntoView({ block: "center" });
        target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
        const range = document.createRange();
        range.setStart(last, last.data.length);
        range.collapse(true);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      }, blockId);
      await page.keyboard.insertText(value);
    };
    const approveOnPage = async (blockId: string) => {
      await pageCard(blockId).getByRole("button", { name: "適用", exact: true }).click();
      await expect.poll(async () => (await pendingProposals()).filter((item) => item.fileId === fileId).length).toBe(0);
      // 承認の書き込み中の編集停止が解けてから次へ進む (その間の Undo・入力は受け付けない)。
      await expect(page.locator(".ai-edit-readonly-block")).toHaveCount(0);
    };
    const mergeCounters = () => page.evaluate(() => Object.entries(
      (window as unknown as { __SIGMA_STUDIO_PERFORMANCE__?: { counters: Record<string, number> } })
        .__SIGMA_STUDIO_PERFORMANCE__?.counters ?? {},
    )
      .filter(([name]) => name.startsWith("AiProposalMerge."))
      .map(([name, count]) => `${name}=${count}`));
    const clickMenuAccelerator = (accelerator: string) => app.evaluate(({ Menu }, wanted) => {
      const find = (menu: Electron.Menu | null): Electron.MenuItem | null => {
        for (const item of menu?.items ?? []) {
          if (item.accelerator === wanted) return item;
          const nested = find(item.submenu ?? null);
          if (nested) return nested;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu());
      item?.click();
      return Boolean(item);
    }, accelerator);

    // 1. 誰も対象を直していない通常の承認: 合成は起きず、フォールバックの印は 0 (R3)。
    await propose("p_quiet", "Quiet", "Calm");
    await reload();
    await expect(pageCard("p_quiet")).toBeVisible();
    await expect(pageCard("p_quiet").locator("[data-ai-proposal-merge-notice]")).toHaveCount(0);
    await approveOnPage("p_quiet");
    expect(paragraphText(await saved(), "p_quiet")).toBe("Calm target paragraph.");
    expect(await mergeCounters()).toEqual([]);
    expect(readLedger()).not.toContain("proposal-merge-fallback");

    // 2. 提案の後に人が同じ段落の別の位置を直す: 紙面のプレビューも承認の結果も両方を含む。
    await propose("p_diff", "cat", "dog");
    await saveHumanEdit("p_diff", "The cat sat on the red mat.");
    await reload();
    const diffCard = pageCard("p_diff");
    await expect(diffCard.locator("[data-ai-proposal-content]")).toContainText("The dog sat on the red mat.");
    await expect(diffCard.locator("[data-ai-proposal-bar-details] [data-ai-proposal-merge-notice]")).toHaveText("あなたの編集と合わせた内容です");
    expect((await pendingProposals()).filter((item) => item.conflict)).toEqual([]);
    await diffCard.screenshot({ path: testInfo.outputPath("merged-preview-card.png") });
    await page.screenshot({ path: testInfo.outputPath("merged-preview-page.png") });
    await approveOnPage("p_diff");
    expect(paragraphText(await saved(), "p_diff")).toBe("The dog sat on the red mat.");
    // 重なりの無い合成も「通常の承認」: フォールバックの印は 0。
    expect(await mergeCounters()).toEqual([]);
    expect(readLedger()).not.toContain("proposal-merge-fallback");

    // 2b. 保留中の提案の対象は紙面でロックしない: 人がその段落へ打鍵すると、カードは合成後の内容に
    //     なり、承認は人の打鍵と AI の変更の両方を保存する。
    await propose("p_typed", "cat", "dog");
    await reload();
    const typedCard = pageCard("p_typed");
    await expect(typedCard).toBeVisible();
    await expect(bodyParagraph("p_typed")).not.toHaveClass(/ai-edit-readonly-block/);
    await typeAtParagraphEnd("p_typed", " Typed by hand.");
    await expect(bodyParagraph("p_typed")).toContainText(`${BASE_TEXT} Typed by hand.`);
    await expect(typedCard.locator("[data-ai-proposal-content]")).toContainText("The dog sat on the mat. Typed by hand.");
    await expect(typedCard.locator("[data-ai-proposal-bar-details] [data-ai-proposal-merge-notice]")).toHaveText("あなたの編集と合わせた内容です");
    await typedCard.screenshot({ path: testInfo.outputPath("typed-merged-card.png") });
    await approveOnPage("p_typed");
    expect(paragraphText(await saved(), "p_typed")).toBe("The dog sat on the mat. Typed by hand.");
    await expect(bodyParagraph("p_typed")).toHaveText("The dog sat on the mat. Typed by hand.");
    expect(await mergeCounters()).toEqual([]);
    expect(readLedger()).not.toContain("proposal-merge-fallback");

    // 3. 人と AI が同じ語を直す: 同じ範囲も両方を残す (文字単位で、人 → AI の順)。人の語は base の
    //    文字を含まないものにする (含むと、その文字は人が残し AI が消した文字として扱われる)。
    await propose("p_same", "cat", "dog");
    await saveHumanEdit("p_same", "The emu sat on the mat.");
    await reload();
    const sameCard = pageCard("p_same");
    await expect(sameCard.locator("[data-ai-proposal-merge-notice]")).toBeVisible();
    const previewText = await sameCard.locator("[data-ai-proposal-content]").textContent();
    const beforeApproval = await saved();
    await approveOnPage("p_same");
    const approvedText = paragraphText(await saved(), "p_same");
    expect(approvedText).toBe("The emudog sat on the mat.");
    // 紙面で見せた内容が、そのまま保存された。
    expect(previewText).toContain(approvedText);

    // 4. Ctrl+Z (編集メニューの取り消し) で承認前の文書と同じ内容に戻り、やり直しで承認後に戻る (R2)。
    await expect(page.locator('[data-sigma-doc-id="p_same"]').first()).toContainText(approvedText);
    expect(await clickMenuAccelerator("CmdOrCtrl+Z")).toBe(true);
    await expect(page.locator('[data-sigma-doc-id="p_same"]').first()).toContainText("The emu sat on the mat.");
    await expect.poll(async () => areSigmaDocumentsEquivalent((await saved())!, beforeApproval!), { timeout: 20_000 }).toBe(true);
    expect(await clickMenuAccelerator("CmdOrCtrl+Shift+Z")).toBe(true);
    await expect.poll(async () => paragraphText(await saved(), "p_same"), { timeout: 20_000 }).toBe(approvedText);

    // 5. 閉じて開き直しても同じ (R4)。
    await client.close();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('[data-sigma-doc-id="p_diff"]').first()).toContainText("The dog sat on the red mat.");
    await expect(page.locator('[data-sigma-doc-id="p_same"]').first()).toContainText(approvedText);
    await expect(page.locator('[data-sigma-doc-id="p_typed"]').first()).toHaveText("The dog sat on the mat. Typed by hand.");
    expect(paragraphText(await saved(), "p_diff")).toBe("The dog sat on the red mat.");
    expect(paragraphText(await saved(), "p_typed")).toBe("The dog sat on the mat. Typed by hand.");
    expect(paragraphText(await saved(), "p_same")).toBe(approvedText);
    await connect();

    // 6. base を持たない旧レコードは従来どおり: 対象の変更は content-stale の競合で、紙面にカードを出さない。
    const legacy = await propose("p_legacy", "Legacy", "Old");
    const proposalsDir = path.join(profile, "data", "proposals");
    const legacyFile = readdirSync(proposalsDir)
      .map((name) => path.join(proposalsDir, name))
      .find((file) => file.endsWith(".proposal.json") && readFileSync(file, "utf8").includes(legacy.proposalId));
    expect(legacyFile).toBeDefined();
    const record = JSON.parse(readFileSync(legacyFile!, "utf8")) as Record<string, unknown>;
    expect(record.mergeBasis).toBeDefined();
    delete record.mergeBasis;
    writeFileSync(legacyFile!, JSON.stringify(record, null, 2));
    // 合成できない旧レコードの対象は、従来どおり紙面で読み取り専用。打鍵は断られ、理由を知らせる。
    await reload();
    await expect(bodyParagraph("p_legacy")).toHaveClass(/ai-edit-readonly-block/);
    await typeAtParagraphEnd("p_legacy", " refused");
    await expect(page.locator(".text-flow-edit-guard-notice")).toHaveText(
      "この箇所は、あなたの編集と合わせられないAI提案の確認待ちです。適用または破棄を選ぶと編集できます。",
    );
    await expect(bodyParagraph("p_legacy")).toHaveText("Legacy target paragraph.");
    await saveHumanEdit("p_legacy", "Legacy target paragraph, edited by hand.");
    await reload();
    await expect.poll(async () => (await pendingProposals()).find((item) => item.proposalId === legacy.proposalId)?.conflict?.reason)
      .toBe("content-stale");
    await expect(pageCard("p_legacy")).toHaveCount(0);
    const approval = await page.evaluate((ids) => window.desktopAPI!.storage.approveMcpEditProposals(ids), [legacy.proposalId]);
    expect(approval).toMatchObject({ ok: false, code: "conflict" });
    expect(paragraphText(await saved(), "p_legacy")).toBe("Legacy target paragraph, edited by hand.");
    await page.evaluate((ids) => window.desktopAPI!.storage.rejectMcpEditProposals!(ids), [legacy.proposalId]);
  } finally {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
