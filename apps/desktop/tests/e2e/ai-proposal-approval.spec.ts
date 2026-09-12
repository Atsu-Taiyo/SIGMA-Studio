import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

// AI提案承認まわりの改修 (Issue 1〜4) のe2e。desktop runtime mockの疑似AI実行を使う:
// - Issue 1: 別ブロックへの2つ目のrunをロック係合中でも並列開始でき、独立に確定できる。
//   サイドバーからの別ブロック依頼は走行中runを待たず新しい部屋で並列開始される。
// - Issue 2: 承認確定後の提案が後から pending として復活しない。
// - Issue 3: 適用後 Ctrl+Z 1手で本文が戻り提案ストアが reverted になる (Ctrl+Shift+Z で再適用)。
// - Issue 4: 複数runの編集案がたまったとき「すべて適用」1クリックでまとめて確定できる。

test.describe.configure({ timeout: 120_000 });

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function createDocument(): SigmaDocument {
  const content: SigmaBlock[] = [
    paragraph("para_a", "一次関数のグラフは直線であり、傾きと切片で形が決まります。"),
    paragraph("para_filler_1", "この単元では、変化の割合の意味を確認しながら進めます。"),
    paragraph("para_b", "二次関数のグラフは放物線であり、頂点の座標が重要になります。"),
  ];
  for (let index = 0; index < 12; index += 1) {
    content.push(paragraph(`para_pad_${index}`, `補足の本文です。この行はページを縦に伸ばすための段落 ${index + 1} です。`));
  }
  return {
    version: "2.0",
    docId: "ai_proposal_approval_e2e_doc",
    metadata: { title: "AI提案承認E2E" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

function createRotatedShapeDocument(): SigmaDocument {
  const document = createDocument();
  return {
    ...document,
    pageLayout: {
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [{
            id: "e2e_shape_1",
            type: "geo",
            x: 40,
            y: 40,
            rotation: Math.PI / 6,
            opacity: 0.4,
            anchor: { type: "block", blockId: "para_pad_11", dy: 0 },
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "solid",
              color: "#111111",
              fillColor: "#ffffff",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          }],
          assets: {},
        },
      },
    },
  } as unknown as SigmaDocument;
}

function createProblemDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "ai_problem_proposal_preview_e2e_doc",
    metadata: { title: "AI問題提案プレビューE2E" },
    content: [{
      id: "problem_1",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [paragraph("problem_prompt_1", "一次関数の傾きを求めなさい。")],
      hints: [],
      solution: [paragraph("problem_solution_1", "二点の座標差から傾きを求めます。")],
      answer: { type: "math", expected: "2" },
      numbering: { value: 7 },
    }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

async function setup(page: Page, document: SigmaDocument = createDocument()): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, document, { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function selectParagraphText(page: Page, blockId: string): Promise<void> {
  // プレビュー描画やロック表示の再レンダー中は、対象段落が一瞬DOMから消える。掴めるまで待つ。
  await expect.poll(async () => page.evaluate((targetBlockId) => Array.from(
    document.querySelectorAll<HTMLElement>(`.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`),
  ).filter((element) => element.getClientRects().length > 0 && Boolean(element.textContent?.trim())).length, blockId))
    .toBeGreaterThan(0);
  await page.evaluate((targetBlockId) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(
      `.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`,
    )).find((element) => element.getClientRects().length > 0 && Boolean(element.textContent?.trim()));
    if (!target) {
      throw new Error(`selection target not found: ${targetBlockId}`);
    }
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, blockId);
  await expect.poll(async () => page.evaluate(
    () => window.getSelection()?.toString().trim().length ?? 0,
  )).toBeGreaterThan(0);
}

async function startInlineRun(page: Page, blockId: string, instruction: string): Promise<void> {
  await selectParagraphText(page, blockId);
  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();
  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();
}

async function closeInlineSurface(page: Page): Promise<void> {
  const catcher = page.locator(".ai-inline-catcher");
  if (await catcher.count()) {
    await catcher.first().click({ position: { x: 6, y: 500 }, force: true });
  }
  await expect(catcher).toBeHidden();
  await expect(page.locator(".ai-chat-composer--inline")).toBeHidden();
}

async function listProposalStatuses(page: Page): Promise<Record<string, string>> {
  const proposals = await page.evaluate(async () => {
    const api = (window as unknown as { desktopAPI: { storage: { listMcpEditProposals: (options: { status: string }) => Promise<Array<{ proposalId: string; status: string }>> } } }).desktopAPI;
    return api.storage.listMcpEditProposals({ status: "all" });
  });
  return Object.fromEntries(proposals.map((proposal) => [proposal.proposalId, proposal.status]));
}

test("Issue 1: run B starts on another block while run A's lock is engaged, and both confirm independently", async ({ page }) => {
  await setup(page);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  // Run A: SLOW PROPOSAL on para_a。最初のstreamイベントで running になりロック(shimmer)が係合する。
  await startInlineRun(page, "para_a", "SLOW PROPOSAL 一次関数の説明を詳しくして");
  await closeInlineSurface(page);
  await expect(page.locator('.text-flow-editor .ai-edit-locked-block').first()).toBeVisible({ timeout: 15_000 });

  // Run B on para_b while A is still running AND its lock is engaged.
  await startInlineRun(page, "para_b", "PROPOSAL 二次関数の頂点の説明を追加して");
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(2);
  await closeInlineSurface(page);

  const runPayloads = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { instruction: string }[] }).__aiEditRunPayloads);
  expect(runPayloads).toHaveLength(2);

  // Run B (fast) finishes first: its card appears while A is still running, and applies independently.
  const previewDialogs = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialogs).toHaveCount(1, { timeout: 20_000 });
  await previewDialogs.first().locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(previewDialogs).toHaveCount(0);

  // Issue 2: 確定済み提案が(mockのwatcher通知後も)pendingとして復活しない。
  await page.waitForTimeout(500);
  await expect(previewDialogs).toHaveCount(0);

  // A finishes: its own card appears and applies independently too.
  await expect(previewDialogs).toHaveCount(1, { timeout: 25_000 });
  await previewDialogs.first().locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(previewDialogs).toHaveCount(0);

  const statuses = await listProposalStatuses(page);
  expect(Object.values(statuses)).toEqual(["approved", "approved"]);

  const updateDepthErrors = consoleErrors.filter((text) => text.includes("Maximum update depth"));
  expect(updateDepthErrors).toEqual([]);
});

test("problem and solution proposals keep their page-area layout in the preview", async ({ page }) => {
  await setup(page, createProblemDocument());

  await startInlineRun(page, "problem_prompt_1", "PROPOSAL 問題文を書き換えて");
  await closeInlineSurface(page);
  let previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await expect(previewDialog.locator('.ai-inline-preview-operation[data-problem-area="prompt"]')).toBeVisible();
  await expect(previewDialog.locator(".ai-inline-preview-problem-area-label")).toHaveText("問7 問題文");
  await previewDialog.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(previewDialog).toBeHidden();

  await startInlineRun(page, "problem_solution_1", "PROPOSAL 解答を書き換えて");
  await closeInlineSurface(page);
  previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await expect(previewDialog.locator('.ai-inline-preview-operation[data-problem-area="solution"]')).toBeVisible();
  await expect(previewDialog.locator(".ai-inline-preview-problem-area-label")).toHaveText("解答");
});

test("問題挿入プレビューが問題番号と枠線付きで描かれる", async ({ page }) => {
  await setup(page, createDocument());

  await startInlineRun(page, "para_a", "PROPOSAL PROBLEM 問題を追加して");
  await closeInlineSurface(page);

  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await expect(previewDialog.locator(".print-problem-area.with-frame")).toBeVisible();
  await expect(previewDialog.locator(".print-problem-number")).toHaveText("1");
});

test("問題文へのAI依頼中は、問題エリアにもロックのshimmerと停止ボタンが出る", async ({ page }) => {
  // 回帰: 問題ブロックは textFlow ユニットではないため BlockEditor 経路で描かれるが、
  // そこへ TextFlowEditPolicy が渡されていなかった。guard が無いと
  // ai-edit-locked-block / ai-edit-lock-char の ProseMirror decoration が付かず、
  // 「ロック表示が一切ないのに commitDocumentChange が変更を拒否する」状態になっていた。
  await setup(page, createProblemDocument());

  await startInlineRun(page, "problem_prompt_1", "SLOW PROPOSAL 問題文をもっと詳しくして");
  await closeInlineSurface(page);

  const lockedBlock = page.locator(".text-flow-editor .ai-edit-locked-block").first();
  await expect(lockedBlock).toBeVisible({ timeout: 15_000 });
  // shimmer本体は1文字/1数式アトム単位のinline decoration。
  await expect(page.locator(".ai-edit-lock-char, .ai-edit-lock-atom").first()).toBeVisible();
  // ロックを解除する導線 (「AIを停止して編集」) も同じ decoration 経由で出る。
  await expect(lockedBlock.locator(".ai-edit-lock-stop-button")).toHaveCount(1);

  // 依頼していない解答エリアは実行中でも編集可能なまま (粒度別ロックの前提)。
  await expect(
    page.locator('[data-edit-guard-block-id="problem_solution_1"]'),
  ).toHaveCount(0);
});

test("Issue 1: submitting a different-block request from the sidebar mid-run forks a parallel run instead of queueing", async ({ page }) => {
  await setup(page);

  // Sidebar run on para_a (SLOW so it is still running when the second request goes out).
  const sidebar = page.locator(".ai-sidebar-panel");
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
  await expect(sidebar).toBeVisible();
  await page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first().click();
  const composer = page.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
  await composer.locator("textarea").fill("SLOW 一次関数の説明を整えて");
  await composer.locator(".ai-chat-send-button").click();
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(1);

  // While A runs, select ANOTHER block and send from the same sidebar composer.
  await page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first().click();
  await composer.locator("textarea").fill("二次関数の頂点の説明を追加して");
  await composer.locator(".ai-chat-send-button").click();

  // 並列fork: 送信待ちpillにはならず、2つ目のrunが即座に始まる (別部屋)。
  await expect(page.locator(".ai-chat-queued-pill")).toHaveCount(0);
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(2);
  await expect.poll(async () =>
    page.evaluate(() => (window as unknown as { __aiEditRunPayloads: unknown[] }).__aiEditRunPayloads.length),
  ).toBe(2);

  // 同じブロックへの依頼は従来どおりキュー (直列) のまま。
  await page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first().click();
  await composer.locator("textarea").fill("さらに頂点の求め方も追記して");
  await composer.locator(".ai-chat-send-button").click();
  await expect(page.locator(".ai-chat-queued-pill")).toHaveText("送信待ち");
});

test("Issue 3: Ctrl+Z undoes an applied proposal in one step (body restored + store reverted), and redo re-applies", async ({ page }) => {
  await setup(page);

  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const originalText = "一次関数のグラフは直線であり、傾きと切片で形が決まります。";
  await expect(paragraphA).toContainText(originalText.slice(0, 12));

  await startInlineRun(page, "para_a", "PROPOSAL この段落を書き換えて");
  await closeInlineSurface(page);
  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await previewDialog.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(previewDialog).toBeHidden();
  await expect(paragraphA).toContainText("E2E提案で書き換えた本文");

  const statuses = await listProposalStatuses(page);
  expect(Object.values(statuses)).toEqual(["approved"]);
  const proposalId = Object.keys(statuses)[0];

  // 本文と提案statusは承認の後処理より先に反映される。処理中のUndoを止める既存ガードの解除を待つ。
  await expect(page.locator('[data-edit-guard-id="ai-document-write-in-progress"]')).toHaveCount(0);

  // Ctrl+Z 1手: 本文が適用前に戻り、提案ストアも reverted になる。
  await page.locator(".editor-canvas").click({ position: { x: 8, y: 400 } });
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraphA).toContainText(originalText.slice(0, 12));
  await expect(paragraphA).not.toContainText("E2E提案で書き換えた本文");
  await expect.poll(async () => (await listProposalStatuses(page))[proposalId]).toBe("reverted");

  // redo (Shift+Ctrl+Z): 本文が再適用され、ストアも approved に戻る。
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(paragraphA).toContainText("E2E提案で書き換えた本文");
  await expect.poll(async () => (await listProposalStatuses(page))[proposalId]).toBe("approved");
});

test("auto-applied proposal is one undo step and preserves earlier document history", async ({ page }) => {
  await setup(page);

  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const paragraphB = page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first();
  const originalA = "一次関数のグラフは直線であり、傾きと切片で形が決まります。";
  const originalB = "二次関数のグラフは放物線であり、頂点の座標が重要になります。";

  // 自動承認より前の通常編集も履歴に残っている状態を作る。
  await selectParagraphText(page, "para_b");
  await page.keyboard.type("人手で先に編集した本文");
  await expect(paragraphB).toContainText("人手で先に編集した本文");

  await startInlineRun(page, "para_a", "PROPOSAL この段落を書き換えて");
  await closeInlineSurface(page);
  await expect(page.locator(".ai-inline-preview-dialog")).toBeVisible({ timeout: 20_000 });

  const proposalId = await page.evaluate(() => (
    window as unknown as { __autoApplyFirstPendingProposal: () => string | null }
  ).__autoApplyFirstPendingProposal());
  expect(proposalId).toBeTruthy();
  await expect(page.locator(".ai-inline-preview-dialog")).toBeHidden();
  await expect(paragraphA).toContainText("E2E提案で書き換えた本文");

  // 1手目は自動承認だけを戻し、それ以前の人手編集は残す。
  await page.locator(".editor-canvas").click({ position: { x: 8, y: 400 } });
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraphA).toContainText(originalA.slice(0, 12));
  await expect(paragraphB).toContainText("人手で先に編集した本文");
  await expect.poll(async () => (await listProposalStatuses(page))[proposalId!]).toBe("reverted");

  // 2手目で自動承認より前の通常編集も引き続き戻せる。
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraphB).toContainText(originalB.slice(0, 12));
});

test("適用はいま開いている教材だけを編集する: 打鍵した入力も残り、退避用の教材を作らない", async ({ page }) => {
  await setup(page);

  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const paragraphB = page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first();

  // 未保存の入力を持ったまま承認する状況を作る。
  await selectParagraphText(page, "para_b");
  await page.keyboard.type("承認前に打鍵した本文");
  await expect(paragraphB).toContainText("承認前に打鍵した本文");

  await startInlineRun(page, "para_a", "PROPOSAL この段落を書き換えて");
  await closeInlineSurface(page);

  const previewDialogs = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialogs).toHaveCount(1, { timeout: 20_000 });
  await previewDialogs.first().locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(previewDialogs).toHaveCount(0);

  // AIの変更と自分の入力が同じ教材に共存する。
  await expect(paragraphA).toContainText("E2E提案で書き換えた本文");
  await expect(paragraphB).toContainText("承認前に打鍵した本文");

  // 「〇〇（アプリ内編集の退避）」のような教材ファイルを増やさない。
  await expect
    .poll(async () => page.evaluate(() => (
      window as unknown as { __sigmaCreatedFileCount: number }
    ).__sigmaCreatedFileCount))
    .toBe(0);
  await expect(page.locator(".document-tab")).toHaveCount(1);
});

test("applied chat result shows the real diff and reverts the apply in one click", async ({ page }) => {
  await setup(page);
  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const originalText = "一次関数のグラフは直線であり、傾きと切片で形が決まります。";

  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
  const sidebar = page.locator(".ai-sidebar-panel");
  await paragraphA.click();
  const composer = sidebar.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
  await composer.locator("textarea").fill("PROPOSAL この段落を書き換えて");
  await composer.locator(".ai-chat-send-button").click();

  const proposal = sidebar.locator(".ai-chat-result-proposal");
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  const inlinePreview = page.locator(".ai-inline-preview-dialog").first();
  await expect(inlinePreview).toBeVisible();
  await expect(inlinePreview).not.toContainText("本文を更新");
  await proposal.getByRole("button", { name: "適用", exact: true }).click();
  await expect(proposal).toBeHidden();
  await expect(paragraphA).toContainText("E2E提案で書き換えた本文");

  const appliedCard = sidebar.getByLabel("適用した変更", { exact: true });
  await expect(appliedCard).toBeVisible();
  await expect(appliedCard).toContainText(originalText);
  await expect(appliedCard).toContainText("E2E提案で書き換えた本文");
  await expect(appliedCard).toContainText("−1行");
  await expect(appliedCard).toContainText("+1行");
  await expect(appliedCard).not.toContainText("本文を更新");
  await expect(appliedCard).not.toContainText("E2E疑似編集案");
  const revertButton = appliedCard.getByRole("button", { name: "適用を元に戻す" });
  await expect(revertButton).toBeVisible();

  await revertButton.click();
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const saved = raw ? JSON.parse(raw) : null;
    return saved?.content?.find((block: { id?: string }) => block.id === "para_a")
      ?.children?.map((child: { text?: string }) => child.text ?? "")
      .join("") ?? "";
  })).toContain(originalText.slice(0, 12));
  await expect(paragraphA).toContainText(originalText.slice(0, 12));
  await expect(appliedCard).toBeHidden();
  await expect(sidebar.getByText("元に戻しました", { exact: true })).toBeVisible();
  expect(Object.values(await listProposalStatuses(page))).toEqual(["reverted"]);
});

test("a formatting-only proposal remains visible as a real pending diff", async ({ page }) => {
  await setup(page);
  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();

  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
  const sidebar = page.locator(".ai-sidebar-panel");
  await paragraphA.click();
  const composer = sidebar.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
  await composer.locator("textarea").fill("PROPOSAL FORMAT この段落を太字にして");
  await composer.locator(".ai-chat-send-button").click();

  const proposal = sidebar.locator(".ai-chat-result-proposal");
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal).toContainText("−1行");
  await expect(proposal).toContainText("+1行");
  await expect(proposal.locator('[data-change="removed"] mark')).toContainText("一次関数のグラフは直線");
  await expect(proposal.locator('[data-change="added"] mark strong')).toContainText("一次関数のグラフは直線");
});

test("a shape replacement pending diff uses the preserved rotation and opacity", async ({ page }) => {
  await setup(page, createRotatedShapeDocument());
  const paragraphA = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();

  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
  const sidebar = page.locator(".ai-sidebar-panel");
  await paragraphA.click();
  const composer = sidebar.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
  await composer.locator("textarea").fill("PROPOSAL SHAPE REPLACE 図形を置き換えて");
  await composer.locator(".ai-chat-send-button").click();

  const proposal = sidebar.locator(".ai-chat-result-proposal");
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal).toContainText("−1図形");
  await expect(proposal).toContainText("+1図形");
  const addedSvg = proposal.locator('[data-change="added"] svg');
  await expect(addedSvg).toBeVisible();
  const addedMarkup = await addedSvg.evaluate((element) => element.outerHTML);
  expect(addedMarkup).toContain('transform="rotate(');
  expect(addedMarkup).toContain('opacity="0.4"');
});

test("Issue 4: the apply-all bar approves every pending run's proposals in one click", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL 一次関数の説明を書き換えて");
  await closeInlineSurface(page);
  await startInlineRun(page, "para_b", "PROPOSAL 二次関数の説明を書き換えて");
  await closeInlineSurface(page);

  // 2run分のカードが出そろうと一括適用バーが現れる。
  const previewDialogs = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialogs).toHaveCount(2, { timeout: 25_000 });
  const applyAllBar = page.locator(".ai-apply-all-bar");
  await expect(applyAllBar).toBeVisible();
  await expect(applyAllBar).toContainText("2件のAI編集案");

  await applyAllBar.locator(".ai-apply-all-button").click();
  await expect(previewDialogs).toHaveCount(0);
  await expect(applyAllBar).toBeHidden();

  const statuses = await listProposalStatuses(page);
  expect(Object.values(statuses)).toEqual(["approved", "approved"]);
  await expect(page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first()).toContainText("E2E提案で書き換えた本文");
  await expect(page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first()).toContainText("E2E提案で書き換えた本文");
});
