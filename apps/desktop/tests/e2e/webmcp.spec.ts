import { expect, test, type Page } from "@playwright/test";

async function installWebMcpMock(page: Page, rejectedToolName: string | null = null) {
  await page.addInitScript(({ rejectedToolName }) => {
    type RegisteredTool = { name: string; execute(input: unknown): Promise<unknown> | unknown };
    const tools = new Map<string, RegisteredTool>();
    const contexts: Array<{ instructions: string }> = [];
    Object.defineProperty(window, "__sigmaWebMcpTools", { value: tools });
    Object.defineProperty(window, "__sigmaWebMcpContexts", { value: contexts });
    Object.defineProperty(Document.prototype, "modelContext", {
      configurable: true,
      get: () => ({
        registerTool: async (tool: RegisteredTool, options?: { signal?: AbortSignal }) => {
          if (tool.name === rejectedToolName) throw new Error(`Registration rejected for ${tool.name}`);
          tools.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => tools.delete(tool.name), { once: true });
        },
        provideContext: async (context: { instructions: string }) => { contexts.push(context); },
      }),
    });
  }, { rejectedToolName });
}

for (const whiteboard of [false, true]) {
test(`WebMCP SVG image preview, revision, approval and reload retain the source (${whiteboard ? "whiteboard" : "paper"})`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.has("insert_svg_image"))).toBe(true);
  await page.locator(".document-tab-action-hover").hover();
  await page.getByRole("menu", { name: "新規教材" }).getByRole("menuitem", { name: whiteboard ? "ホワイトボード" : "空の教材", exact: true }).click();
  if (whiteboard) await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.has("insert_svg_image"))).toBe(true);
  type Tools = Map<string, { execute(input: unknown): Promise<unknown> | unknown }>;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="12" fill="#eff6ff"/><path d="M30 125 L150 25 L270 125 Z" fill="#ef4444" stroke="#172554" stroke-width="3"/><text x="160" y="150" text-anchor="middle" font-size="18">三角形の面積</text></svg>';
  const result = await page.evaluate(async ({ svg, whiteboard }) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({ detail: "full" }) as { revision: number; document: { content: Array<{ id: string }> } };
    return tools.get("insert_svg_image")!.execute({ expectedRevision: context.revision, targetId: whiteboard ? "CANVAS" : context.document.content[0].id, svg, name: "三角形の面積", w: 320 });
  }, { svg, whiteboard });
  expect(result).toMatchObject({ ok: true, status: "pending_approval" });
  const ghost = page.locator('.ai-diff-ghost-shape').filter({ has: page.locator('img[src^="data:image/svg+xml;base64,"]') });
  await expect(ghost).toBeVisible();
  const image = ghost.locator("img");
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("svg-proposal.png") });
  const shapeId = await ghost.getAttribute("data-overlay-shape-id");
  expect(shapeId).toBeTruthy();

  const revised = await page.evaluate(async ({ svg, shapeId }) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({ detail: "full" }) as { revision: number; document: { pageLayout: { overlay: { overlaySnapshot: { shapes: Array<{ id: string }> } } } } };
    const shape = context.document.pageLayout.overlay.overlaySnapshot.shapes.find((item) => item.id === shapeId);
    return tools.get("update_svg_image")!.execute({ expectedRevision: context.revision, shapeId, expectedShape: shape, svg: svg.replace('#ef4444', '#2563eb') });
  }, { svg, shapeId });
  expect(revised).toMatchObject({ ok: true, status: "pending_approval" });
  await expect.poll(() => image.getAttribute("src")).toContain(Buffer.from(svg.replace('#ef4444', '#2563eb')).toString('base64'));
  const dock = page.locator(".ai-task-dock-root");
  await dock.getByRole("button", { name: /AIタスク/ }).hover();
  await dock.getByRole("button", { name: "適用", exact: true }).click();
  await expect(ghost).toHaveCount(0);
  const applied = page.locator(`[data-overlay-shape-id="${shapeId}"] img`).first();
  await expect(applied).toBeVisible();
  await expect.poll(() => applied.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.mouse.move(1100, 700);
  await page.screenshot({ path: testInfo.outputPath("svg-applied.png") });
  const source = await applied.getAttribute("src");
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(applied).toBeVisible();
  await expect(applied).toHaveAttribute("src", source!);
  await expect.poll(() => applied.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
}

test("WebMCP converts Markdown math, previews it, and applies one draft", async ({ page }) => {
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.size)).toBe(28);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __sigmaWebMcpHeavyFallbackCount: number }
  ).__sigmaWebMcpHeavyFallbackCount)).toBe(0);

  const result = await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({}) as { revision: number };
    return tools.get("insert_markdown")!.execute({
      expectedRevision: context.revision,
      targetId: "END_OF_DOCUMENT",
      markdown: "式 $x^2+y^2=1$ を考える。金額は \\$5。",
    });
  });
  expect(result).toMatchObject({ ok: true, status: "pending_approval", operationCount: 1 });
  const preview = page.locator(".ai-inline-preview-dialog").filter({ hasText: "式" });
  const liveBlock = page.locator(".editor-canvas [data-sigma-doc-type=\"paragraph\"]")
    .filter({ hasText: "金額は $5" })
    .last();
  await expect(preview).toBeVisible();
  await expect(liveBlock).toHaveCount(0);
  await preview.getByRole("button", { name: "適用", exact: true }).click();
  await expect(liveBlock).toContainText("式");
  await expect(liveBlock).toContainText("金額は $5");
  await expect(liveBlock.locator('.inline-math-node[data-tex="x^2+y^2=1"]')).toBeVisible();
});

test("WebMCP graph labels survive a human settings edit", async ({ page }) => {
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }
  ).__sigmaWebMcpTools.size)).toBe(28);

  const existingLabelIds = await page.locator(".overlay-shape-text").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-overlay-shape-id")),
  );

  const result = await page.evaluate(async () => {
    const tools = (window as unknown as {
      __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }>;
    }).__sigmaWebMcpTools;
    const inspected = await tools.get("inspect_document")!.execute({ detail: "full" }) as {
      revision: number;
      document: { content: Array<{ id: string }> };
    };
    return tools.get("insert_graph")!.execute({
      expectedRevision: inspected.revision,
      targetId: inspected.document.content[0]!.id,
      id: "webmcp_graph_labels",
      kind: "cartesian",
      axes: { xLabel: "X軸", yLabel: "Y軸", originLabel: "O", grid: true },
      curves: [{ id: "curve_webmcp", expr: "x^2", label: "f" }],
      points: [{ id: "point_webmcp", x: "1", y: "1", label: "P" }],
      annotations: [{ id: "annotation_webmcp", x: "2", y: "2", text: "注記" }],
      showFormulaLabels: true,
    });
  });
  expect(result).toMatchObject({
    ok: true,
    status: "pending_approval",
    operationCount: 7,
  });

  const taskDock = page.locator(".ai-task-dock-root");
  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();

  const graph = page.locator("#webmcp_graph_labels");
  await expect(graph).toBeVisible();
  const graphWrapper = page.locator(".overlay-shape").filter({ has: graph }).first();
  // The starter document may already contain graph labels. Track only this insertion.
  const labels = page.locator(".overlay-shape-text" + existingLabelIds.map((id) =>
    `:not([data-overlay-shape-id=${JSON.stringify(id)}])`,
  ).join(""));
  await expect(labels).toHaveCount(6);
  await expect(labels).toContainText(["X軸", "Y軸", "O", "P", "注記", "f"]);

  const graphBox = await graph.boundingBox();
  expect(graphBox).not.toBeNull();
  await page.mouse.click(
    graphBox!.x + graphBox!.width * 0.5,
    graphBox!.y + graphBox!.height * 0.65,
  );
  await expect(graphWrapper).toHaveClass(/selected/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent(
    "sigma-studio:open-overlay-graph-settings",
    { detail: { shapeId: "webmcp_graph_labels" } },
  )));

  const settings = page.getByRole("dialog", { name: "グラフの設定" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "表示範囲", exact: true }).click();
  await settings.getByLabel("グリッド", { exact: true }).uncheck();

  await expect(labels).toHaveCount(6);
  await expect(labels).toContainText(["X軸", "Y軸", "O", "P", "注記", "f"]);
});

test("the top-left dock owns the whole web AI surface: instructions, apply, and the result row", async ({ page }) => {
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  // ツールの本数はこのテストの関心ではない (registration が終わったことだけを待つ)。
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }).__sigmaWebMcpTools.size)).toBeGreaterThan(0);

  // 提案がまだ無くても、デスクトップと同じように常駐している。
  const taskDock = page.locator(".ai-task-dock-root");
  const dockToggle = taskDock.getByRole("button", { name: /AIタスク/ });
  // 指示欄にフォーカスが残っているあいだ dock は開いたままになる (入力が飛ばないように)。
  // 開いているときに hover し直すと、広がったパネル自身がトグルを覆って動かない。
  const openDock = async () => {
    if (!await taskDock.locator(".ai-task-dock").isVisible()) {
      await dockToggle.hover();
    }
    await expect(taskDock.locator(".ai-task-dock")).toBeVisible();
  };
  await expect(dockToggle).toBeVisible();
  await openDock();

  // 接続状態と指示欄はdockの中。右上の独自カードも右のAIパネルも作らない。
  const dockPanel = taskDock.locator(".ai-task-dock-webmcp");
  await expect(dockPanel).toContainText("接続済み");
  await expect(page.locator(".webmcp-proposal-dock")).toHaveCount(0);
  await expect(page.locator(".ai-web-placeholder")).toHaveCount(0);
  await expect(page.locator(".ai-sidebar-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^AI$/ })).toHaveCount(0);

  const instructions = dockPanel.getByLabel("Web版でこの教材を編集するエージェントへ、守ってほしい指示を入力します。");
  await instructions.fill("既存の記号と日本語の文体を保つ。");
  // 入力中にポインタがdockから外れても畳まない (textareaがこの中にあるため)。
  await page.mouse.move(10, 400);
  await expect(taskDock.locator(".ai-task-dock")).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    const result = await tools.get("inspect_document")!.execute({ detail: "full" }) as { document: { docId: string } };
    return localStorage.getItem(`sigma-studio:webmcp-agent-instructions:v2:${encodeURIComponent(result.document.docId)}`);
  })).toBe("既存の記号と日本語の文体を保つ。");
  const instructionResult = await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    return tools.get("get_agent_instructions")!.execute({});
  });
  expect(instructionResult).toMatchObject({ userInstructions: "既存の記号と日本語の文体を保つ。", trust: { userInstructions: "untrusted_user_content" } });
  expect(await page.evaluate(() => (window as unknown as { __sigmaWebMcpContexts: Array<{ instructions: string }> }).__sigmaWebMcpContexts.some((context) => context.instructions.includes("既存の記号")))).toBe(false);

  const insertMarkdown = (markdown: string) => page.evaluate(async (body) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }> }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({}) as { revision: number };
    await tools.get("insert_markdown")!.execute({ expectedRevision: context.revision, targetId: "END_OF_DOCUMENT", markdown: body });
  }, markdown);

  await insertMarkdown("Web AI panel reference");
  await openDock();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();
  const paragraph = page.locator("[data-sigma-doc-id]").filter({ hasText: "Web AI panel reference" }).last();
  await expect(paragraph).toContainText("Web AI panel reference");

  // ストリームは無いので、残るのは結果だけ。行ごと消えない。
  await openDock();
  await expect(taskDock.locator(".ai-task-dock-chip--applied")).toHaveCount(1);
  await expect(taskDock.locator(".ai-task-dock-row").filter({ hasText: "WebMCP" }).first()).toContainText("適用済み");
  // 巻き戻しの裏付けがWebには無いので、そのボタンは出さない (取り消しは⌘Z)。
  await expect(taskDock.getByRole("button", { name: "元に戻す" })).toHaveCount(0);
  await expect(taskDock.getByRole("button", { name: "再提案" })).toHaveCount(0);

  await insertMarkdown("Web AI panel discarded draft");
  await openDock();
  await taskDock.getByRole("button", { name: "破棄", exact: true }).click();
  await expect(page.locator("[data-sigma-doc-id]").filter({ hasText: "Web AI panel discarded draft" })).toHaveCount(0);
  await openDock();
  await expect(taskDock.locator(".ai-task-dock-chip--rejected")).toHaveCount(1);
  await expect(taskDock.locator(".ai-task-dock-chip--applied")).toHaveCount(1);

  await paragraph.dblclick();
  await expect(page.getByRole("button", { name: "AIに追加" })).toHaveCount(0);
});

test("an agent pins a comment, names which AI it is, and the panel shows that vendor's logo", async ({ page }) => {
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }
  ).__sigmaWebMcpTools.size)).toBe(28);

  const posted = await page.evaluate(async () => {
    const tools = (window as unknown as {
      __sigmaWebMcpTools: Map<string, { execute(input: unknown): Promise<unknown> | unknown }>;
    }).__sigmaWebMcpTools;
    const context = await tools.get("inspect_document")!.execute({}) as { outline: Array<{ id: string; type: string }> };
    const paragraph = context.outline.find((item) => item.type === "paragraph")!;
    const before = await tools.get("list_comments")!.execute({}) as { total: number };
    const created = await tools.get("add_comment")!.execute({
      author: { name: "ChatGPT", vendor: "openai", model: "gpt-5" },
      target: { blockId: paragraph.id },
      text: "ここは $x^2$ の定義を先に置くと読みやすいです。",
    }) as { threadId: string };
    await tools.get("reply_comment")!.execute({
      author: { name: "Claude", vendor: "anthropic" },
      threadId: created.threadId,
      text: "同意です。",
    });
    return { ...created, previousTotal: before.total, listed: await tools.get("list_comments")!.execute({}) };
  });
  expect(posted.listed).toMatchObject({ total: posted.previousTotal + 1 });

  // コメントは提案ドラフトを通らない: AIタスクの承認待ちは増えない。
  const taskDock = page.locator(".ai-task-dock-root");
  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await expect(taskDock.getByRole("button", { name: "適用", exact: true })).toHaveCount(0);

  // 本文レイアウトのコメント欄は紙面右のガター。ホワイトボードでは同じパネルがdockに入る。
  const card = page.locator(`.page-comment-gutter [data-comment-card-key=${JSON.stringify(posted.threadId)}]`);
  await expect(card).toContainText("ChatGPT");
  await expect(card).toContainText("gpt-5");
  await expect(card).toContainText("ここは");
  await expect(card.locator('.inline-math-node[data-tex="x^2"]').first()).toBeVisible();
  // どのAIが書いたかはロゴで分かる (人のコメントは頭文字のまま)。
  await expect(card.locator(".comment-author-avatar.agent svg").first()).toBeVisible();
  await expect(card.getByRole("img", { name: "ChatGPT（OpenAIのAI）のアイコン" })).toBeVisible();
  await expect(card.locator(".comment-reply-avatars .comment-author-avatar")).toHaveCount(1);

  await card.getByRole("button", { name: "解決", exact: true }).click();
  await expect(card).toHaveClass(/resolved/);
});

test("the dock reports a partially registered tool set", async ({ page }) => {
  await installWebMcpMock(page, "update_overlay");
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const taskDock = page.locator(".ai-task-dock-root");
  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await expect(taskDock.locator(".ai-task-dock-webmcp")).toContainText("一部の編集ツールを登録できませんでした");
  await expect(taskDock.locator(".ai-task-dock-webmcp")).toContainText("update_overlay");
});

test("WebMCP on a whiteboard rejects body text, previews proposed shapes as ghosts, and applies them", async ({ page }) => {
  await installWebMcpMock(page);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }
  ).__sigmaWebMcpTools.size)).toBe(28);

  // 「新規教材」はホバーで開くメニュー。そこから新しいホワイトボードを開く。
  await page.locator(".document-tab-action-hover").hover();
  const newDocMenu = page.getByRole("menu", { name: "新規教材" });
  await expect(newDocMenu).toBeVisible();
  await newDocMenu.getByRole("menuitem", { name: "ホワイトボード" }).click();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
  // ツール登録は教材ごとに張り直されるので、新しい教材の分を待つ。
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __sigmaWebMcpTools: Map<string, unknown> }
  ).__sigmaWebMcpTools.size)).toBe(28);

  type Tools = Map<string, { execute(input: unknown): Promise<unknown> | unknown }>;
  const inspected = await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    return tools.get("inspect_document")!.execute({}) as Promise<{ revision: number; documentMode: string; guidance?: string }>;
  });
  expect(inspected.documentMode).toBe("whiteboard");
  expect(inspected.guidance).toContain("create_overlay");

  // 本文は入れられない。理由と代替 (create_overlay kind:text) がエラー文で伝わる。
  const bodyError = await page.evaluate(async ({ revision }) => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    try {
      await tools.get("insert_markdown")!.execute({ expectedRevision: revision, targetId: "END_OF_DOCUMENT", markdown: "本文" });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, { revision: inspected.revision });
  expect(bodyError).toContain("WHITEBOARD_NO_BODY");
  expect(bodyError).toContain('create_overlay kind:"text"');
  const pendingAfterFailure = await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    return tools.get("get_pending_proposal")!.execute({}) as Promise<{ pending: boolean }>;
  });
  expect(pendingAfterFailure.pending).toBe(false);

  // 文章は overlay text (Markdown 複数ブロック)、図形は CANVAS 絶対座標で提案する。
  // 新規教材は開いた直後に revision が進みうるので、提案直前に読み直す。
  const proposal = await page.evaluate(async () => {
    const tools = (window as unknown as { __sigmaWebMcpTools: Tools }).__sigmaWebMcpTools;
    const { revision } = await tools.get("inspect_document")!.execute({}) as { revision: number };
    await tools.get("create_overlay")!.execute({
      expectedRevision: revision,
      targetId: "CANVAS",
      id: "webmcp_wb_text",
      kind: "text",
      x: 120,
      y: 96,
      w: 360,
      markdown: "## 円の方程式\n\n式 $x^2+y^2=1$ を考える。\n\n- 中心は $O$\n- 半径は $1$",
    });
    return tools.get("create_overlay")!.execute({
      expectedRevision: revision,
      targetId: "CANVAS",
      id: "webmcp_wb_rect",
      kind: "rectangle",
      start: { x: 560, y: 120 },
      end: { x: 760, y: 240 },
    }) as Promise<{ ok: boolean; status: string; operationCount: number }>;
  });
  expect(proposal).toMatchObject({ ok: true, status: "pending_approval", operationCount: 2 });

  // 適用前: キャンバス上に破線ゴーストと承認ウィジェットが見える。実図形はまだ無い。
  const canvas = page.locator(".whiteboard-canvas");
  const textGhost = canvas.locator('.overlay-shape.ai-diff-ghost-shape[data-overlay-shape-id="webmcp_wb_text"]');
  const rectGhost = canvas.locator('.overlay-shape.ai-diff-ghost-shape[data-overlay-shape-id="webmcp_wb_rect"]');
  await expect(textGhost).toBeVisible();
  await expect(rectGhost).toBeVisible();
  await expect(textGhost).toContainText("円の方程式");
  await expect(textGhost).toContainText("中心は");
  await expect(textGhost.locator('.inline-math-node[data-tex="x^2+y^2=1"]')).toBeVisible();
  await expect(canvas.locator(".ai-overlay-approval-widget")).toBeVisible();
  await expect(page.locator('.overlay-canvas-editor [data-overlay-shape-id="webmcp_wb_rect"]')).toHaveCount(0);

  const taskDock = page.locator(".ai-task-dock-root");
  await taskDock.getByRole("button", { name: /AIタスク/ }).hover();
  await taskDock.getByRole("button", { name: "適用", exact: true }).click();

  // 適用後: ゴーストは消え、実図形が同じ場所に居る。
  await expect(canvas.locator(".overlay-shape.ai-diff-ghost-shape")).toHaveCount(0);
  const appliedText = page.locator('.overlay-canvas-editor [data-overlay-shape-id="webmcp_wb_text"]');
  await expect(appliedText).toBeVisible();
  await expect(appliedText).toContainText("円の方程式");
  await expect(appliedText.locator('.inline-math-node[data-tex="x^2+y^2=1"]')).toBeVisible();
  await expect(page.locator('.overlay-canvas-editor [data-overlay-shape-id="webmcp_wb_rect"]')).toBeVisible();
});
