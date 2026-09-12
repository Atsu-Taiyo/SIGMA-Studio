import { expect, test } from "@playwright/test";

test("single agent draft reports a stale guard after a human edits the document", async ({ page }) => {
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
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.size)).toBe(26);

  await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({}) as { revision: number };
    await tools.get("insert_markdown")!.execute({
      expectedRevision: context.revision,
      targetId: "END_OF_DOCUMENT",
      markdown: "基準となる説明です。",
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

  const proposalRevision = await page.evaluate(async (blockId) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({ targetId: blockId }) as { revision: number };
    await tools.get("edit_text")!.execute({
      expectedRevision: context.revision,
      operations: [{ op: "replace_text", target: { type: "block", blockId }, replacement: "AIが提案した説明です。" }],
    });
    return context.revision;
  }, targetId);
  await humanTarget.click();
  await humanTarget.press("End");
  await humanTarget.pressSequentially(" 人間の追記");
  await expect(humanTarget).toContainText("人間の追記");

  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await expect(taskDock.locator(".ai-task-dock")).toBeVisible();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();
  await expect(taskDock.locator(".ai-task-dock-error")).toHaveText("変更を適用できませんでした。エージェントに現在の内容を読み直してもらい、もう一度依頼してください。");

  const nextWriteError = await page.evaluate(async (expectedRevision) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
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
  expect(nextWriteError).toContain("read the current context");
  await expect(page.locator("[data-sigma-doc-id]").filter({ hasText: "stale write" })).toHaveCount(0);
});
