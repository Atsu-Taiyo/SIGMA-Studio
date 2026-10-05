import { expect, test, type Page } from "@playwright/test";

type Tools = Map<string, { execute(input: unknown): Promise<unknown> | unknown }>;

async function openWithWebMcp(page: Page) {
  await page.addInitScript(() => {
    type RegisteredTool = { name: string; execute(input: unknown): Promise<unknown> | unknown };
    const tools = new Map<string, RegisteredTool>();
    Object.defineProperty(window, "__sigmaWebMcpTools", { value: tools });
    Object.defineProperty(Document.prototype, "modelContext", {
      configurable: true,
      get: () => ({ registerTool: async (tool: RegisteredTool) => { tools.set(tool.name, tool); } }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.size)).toBe(28);
}

/** The agent writes two paragraphs at the end, and the person applies them (the human target is the second). */
async function applyBaseParagraphs(page: Page) {
  await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({}) as { revision: number };
    await tools.get("insert_markdown")!.execute({
      expectedRevision: context.revision,
      targetId: "END_OF_DOCUMENT",
      markdown: "前置きの段落です。\n\n基準となる説明です。",
    });
  });
  await expect(page.locator(".webmcp-proposal-dock")).toHaveCount(0);
  const taskDock = page.locator(".ai-task-dock-root");
  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();
  const humanTarget = page.locator("[data-sigma-doc-id]").filter({ hasText: "基準となる説明です。" }).last();
  await expect(humanTarget).toContainText("基準となる説明です。");
  const targetId = await humanTarget.getAttribute("data-sigma-doc-id");
  expect(targetId).toBeTruthy();
  return { taskDock, humanTarget, targetId: targetId! };
}

/** The agent's draft: it rewrites the head of the target paragraph ("基準" → "AIが直した"). */
async function proposeRewrite(page: Page, blockId: string) {
  return page.evaluate(async (targetId) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({ targetId }) as { revision: number };
    await tools.get("edit_text")!.execute({
      expectedRevision: context.revision,
      operations: [{ op: "replace_text", target: { type: "text", blockId: targetId, text: "基準" }, replacement: "AIが直した" }],
    });
    return context.revision;
  }, blockId);
}

const heavyFallbackCount = (page: Page) => page.evaluate(() => (
  window as unknown as { __sigmaWebMcpHeavyFallbackCount?: number }
).__sigmaWebMcpHeavyFallbackCount ?? 0);

/**
 * The approval's merge fallbacks (`AI_PROPOSAL_MERGE_COUNTERS`), which the WebMCP approval counts too. The preview's
 * own counters are left out: right after any WebMCP approval the old preview is drawn once over the applied
 * document (`previewNoPreview`), with or without a merge (unchanged by the merge).
 */
const mergeFallbackCounters = (page: Page) => page.evaluate(() => Object.fromEntries(
  Object.entries(window.__SIGMA_STUDIO_PERFORMANCE__?.counters ?? {}).filter(([name]) => [
    "overlaps", "capped", "reidentified", "editBeatsDelete", "invalidAfterMerge", "anchorRelocated", "legacyNoBase",
  ].some((counter) => name === `AiProposalMerge.${counter}`)),
));

test("a human addition and the agent's rewrite of the same paragraph are both kept on approval and after reload", async ({ page }) => {
  await openWithWebMcp(page);
  const { taskDock, humanTarget, targetId } = await applyBaseParagraphs(page);
  await proposeRewrite(page, targetId);

  await humanTarget.click();
  await humanTarget.press("End");
  await humanTarget.pressSequentially(" 人間の追記");
  await expect(humanTarget).toContainText("人間の追記");

  // The page card previews the merged content: the person's addition and the agent's rewrite together.
  const card = page.locator('[data-flow-extension-node-id] > [data-ai-proposal-card="page"]').filter({ hasText: "AIが直した" });
  await expect(card).toContainText("人間の追記");
  await expect(card).toContainText("あなたの編集と合わせた内容です");

  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await expect(taskDock.locator(".ai-task-dock")).toBeVisible();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();
  const applied = page.locator(`[data-sigma-doc-id="${targetId}"]`).first();
  await expect(applied).toHaveText(/^AIが直したとなる説明です。\s?人間の追記$/);
  await expect(taskDock.locator(".ai-task-dock-error")).toHaveCount(0);
  expect(await heavyFallbackCount(page)).toBe(0);
  expect(await mergeFallbackCounters(page)).toEqual({});

  // Reload only after the autosave has written the approved document (the tab's dot goes saving → saved).
  await expect(page.locator(".document-tab.active .document-tab-save-dot")).toHaveClass(/\bsaved\b/);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(`[data-sigma-doc-id="${targetId}"]`).first()).toHaveText(/^AIが直したとなる説明です。\s?人間の追記$/);
});

test("deleting the paragraph the agent rewrites makes the draft STALE_DRAFT", async ({ page }) => {
  await openWithWebMcp(page);
  const { taskDock, humanTarget, targetId } = await applyBaseParagraphs(page);
  const proposalRevision = await proposeRewrite(page, targetId);

  // The person deletes the whole paragraph: clear its text, then join the empty line into the previous one.
  await humanTarget.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(page.locator(`[data-sigma-doc-id="${targetId}"]`)).toHaveCount(0);

  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await expect(taskDock.locator(".ai-task-dock")).toBeVisible();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();
  await expect(taskDock.locator(".ai-task-dock-error")).toContainText("適用できませんでした");
  await expect(page.locator(`[data-sigma-doc-id]`).filter({ hasText: "AIが直した" })).toHaveCount(0);
  // The draft entered STALE_DRAFT once (MISS R3): counted, and not again while it stays there.
  await expect.poll(() => heavyFallbackCount(page)).toBe(1);

  const nextWriteError = await page.evaluate(async (expectedRevision) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    try {
      await tools.get("insert_markdown")!.execute({
        expectedRevision,
        targetId: "END_OF_DOCUMENT",
        markdown: "stale write",
      });
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, proposalRevision);
  expect(nextWriteError).toContain("STALE_DRAFT");
  expect(nextWriteError).toContain(targetId);
  expect(nextWriteError).toContain("read the current context");
  await expect(page.locator("[data-sigma-doc-id]").filter({ hasText: "stale write" })).toHaveCount(0);
});
