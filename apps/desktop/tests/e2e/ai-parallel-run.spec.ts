import { expect, test, type Locator, type Page } from "@playwright/test";

import { installDesktopRuntimeMock, type DesktopRuntimeMockOptions } from "./desktop-runtime-mock";
import { normalizePageLayout } from "@/lib/page-layout";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

// Review harness for the parallel AI chat features (R1-R5 + proposal card).
// Uses the desktop runtime mock's fake AI runtime: instruction keywords control
// each run ("SLOW" = 15s, "FAIL" = reject, "PROPOSAL" = pending MCP proposal on
// completion). Screenshots are written to the test output directory for visual review.


test.describe.configure({ timeout: 90_000 });

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
  for (let index = 0; index < 24; index += 1) {
    content.push(paragraph(`para_pad_${index}`, `補足の本文です。この行はページを縦に伸ばすための段落 ${index + 1} です。`));
  }
  return {
    version: "2.0",
    docId: "ai_parallel_e2e_doc",
    metadata: { title: "AI並列E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function createTwoColumnAiDocument(): SigmaDocument {
  const document = createDocument();
  document.docId = "ai_column_e2e_doc";
  document.metadata = { title: "AI段組E2E" };
  document.content = [
    paragraph("column_left", "左段の本文です。AI表示と挿入案は左段だけに収まります。"),
    {
      ...paragraph("column_right", "右段の本文です。AI表示と挿入案は右段だけに収まります。"),
      pagination: { break: true },
    },
    paragraph("column_filler", "図形テスト用の後続本文です。"),
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 2, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

function createTwoColumnMathAiDocument(): SigmaDocument {
  const document = createTwoColumnAiDocument();
  document.docId = "ai_column_math_e2e_doc";
  document.metadata = { title: "AI段組数式E2E" };
  document.content = [
    {
      id: "column_left_math",
      type: "paragraph",
      children: [
        { type: "text", text: "式：" },
        {
          type: "mathInline",
          id: "e2e_two_column_math",
          tex: "(n+1)^7=n^7+7n^6+21n^5+35n^4+35n^3+21n^2+7n+1",
          display: "inline",
          semanticRole: "expression",
        },
      ],
    },
    {
      ...paragraph("column_right_math", "右段の本文です。"),
      pagination: { break: true },
    },
  ];
  return document;
}

function createLocalColumnAiDocument(): SigmaDocument {
  const document = createDocument();
  document.docId = "ai_local_column_e2e_doc";
  document.metadata = { title: "AI局所段組E2E" };
  document.content = [
    {
      type: "problem",
      id: "local_column_problem",
      tags: [],
      lead: [],
      prompt: [paragraph("local_column_prompt", "次の説明を確認しなさい。")],
      answer: { type: "math", expected: "" },
      solution: [{
        type: "layoutSection",
        id: "local_ai_columns",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: Array.from({ length: 10 }, (_, index) => paragraph(
          `local_col_${index}`,
          `局所段組の説明 ${index + 1}。左右の段でAI表示が混ざらないことを確認します。`,
        )),
      }],
      hints: [],
    },
    paragraph("local_column_fixture_tail", "図形fixture用の後続本文です。"),
  ];
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 1, columnGapMm: 8 };
  pageLayout.overlay = undefined;
  document.pageLayout = pageLayout;
  return document;
}

async function setup(
  page: Page,
  document: SigmaDocument = createDocument(),
  options: DesktopRuntimeMockOptions = {},
): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, document, {
    ...options,
    ai: { ...options.ai, enabled: true },
  });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  // The startup splash overlays the whole page for a moment and would swallow
  // the selection drag's mouse events.
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function expectPopoverInsideViewport(popover: Locator): Promise<void> {
  const bounds = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
}

async function selectParagraphText(page: Page, blockId: string): Promise<void> {
  await selectParagraphContentsProgrammatically(page, blockId);
}

async function selectParagraphContentsProgrammatically(page: Page, blockId: string): Promise<void> {
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
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString().trim().length ?? 0)).toBeGreaterThan(0);
}

async function selectParagraphTextRangeProgrammatically(
  page: Page,
  blockId: string,
  from: number,
  to: number,
): Promise<void> {
  await page.evaluate(({ targetBlockId, startOffset, endOffset }) => {
    const target = document.querySelector<HTMLElement>(
      `.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`,
    );
    const textNode = target?.firstChild;
    if (!target || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error(`text selection target not found: ${targetBlockId}`);
    }
    target.scrollIntoView({ block: "center", inline: "nearest" });
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { targetBlockId: blockId, startOffset: from, endOffset: to });
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? "")).toHaveLength(to - from);
}

// Selects text in the block, opens the inline AI composer through the
// selection-action popover, and sends the given instruction.
async function startInlineRun(page: Page, blockId: string, instruction: string): Promise<void> {
  await selectParagraphText(page, blockId);
  // Not filtered on data-reference-kind: the first selection yields
  // kind="textSelection", but while another run's inline anchor is pinned a
  // new selection is offered as a block reference (kind="block").
  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();
}

async function startInlineRunForParagraphRange(
  page: Page,
  startBlockId: string,
  endBlockId: string,
  instruction: string,
): Promise<void> {
  await page.evaluate(({ startBlockId: startId, endBlockId: endId }) => {
    const root = document.querySelector<HTMLElement>(".text-flow-editor");
    const start = root?.querySelector<HTMLElement>(`[data-sigma-doc-id="${startId}"]`);
    const end = root?.querySelector<HTMLElement>(`[data-sigma-doc-id="${endId}"]`);
    if (!start || !end) {
      throw new Error("range target paragraphs not found");
    }
    start.scrollIntoView({ block: "center", inline: "nearest" });
    const range = document.createRange();
    range.selectNodeContents(start);
    range.setEnd(end, end.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { startBlockId, endBlockId });
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);

  // The block-level action can still be visible during the text-selection
  // debounce. Wait for the action bound to the actual multi-block range.
  const aiButton = page.locator(
    '.selection-action-popover button[aria-label="AIに追加"][data-reference-kind="textSelection"]',
  );
  await expect(aiButton).toBeVisible();
  await aiButton.click();
  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();
}

// Closes the inline surface (the run keeps going in the background) so the
// document body accepts a new selection.
async function closeInlineSurface(page: Page): Promise<void> {
  const catcher = page.locator(".ai-inline-catcher");
  if (await catcher.count()) {
    // Click the transparent catcher in the left gutter (top-left corner is
    // covered by the app menu bar, which would swallow the mousedown).
    await catcher.first().click({ position: { x: 6, y: 500 }, force: true });
  }
  await expect(catcher).toBeHidden();
  await expect(page.locator(".ai-chat-composer--inline")).toBeHidden();
}

function sidebarComposer(page: Page): Locator {
  return page.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
}

async function expectInlineComposerClearOfMenubar(page: Page): Promise<void> {
  const host = page.locator(".ai-sidebar-panel.ai-chat-host--inline:not(.is-hidden)");
  const surface = host.locator(".ai-chat-composer--inline").first();
  await expect(surface).toBeVisible();
  const placement = await surface.evaluate((element) => {
    const host = element.closest<HTMLElement>(".ai-sidebar-panel.ai-chat-host--inline");
    const surfaceRect = element.getBoundingClientRect();
    const menubar = document.querySelector<HTMLElement>(".editor-menubar");
    const menubarRect = menubar?.getBoundingClientRect();
    const hostZIndex = Number.parseInt(host ? getComputedStyle(host).zIndex : "0", 10);
    const menubarZIndex = Number.parseInt(menubar ? getComputedStyle(menubar).zIndex : "0", 10);
    return {
      hostTop: surfaceRect.top,
      hostBottom: surfaceRect.bottom,
      menubarBottom: menubarRect?.bottom ?? 0,
      viewportHeight: window.innerHeight,
      parentIsBody: host?.parentElement === document.body,
      hostZIndex,
      menubarZIndex,
    };
  });
  expect(placement.parentIsBody).toBe(true);
  expect(placement.hostZIndex).toBeGreaterThan(placement.menubarZIndex);
  expect(placement.hostTop).toBeGreaterThanOrEqual(placement.menubarBottom);
  expect(placement.hostBottom).toBeLessThanOrEqual(placement.viewportHeight);
}

// Opens the docked AI sidebar via the AI menu (AIチャットを開く), selects the
// given block as the reference, and sends an instruction from the sidebar
// composer. Used for the queue scenarios so the queued pill is visible in the
// docked transcript throughout. (Runs survive panel remounts either way now —
// see the promote-mid-run test.)
async function startSidebarRun(page: Page, blockId: string, instruction: string): Promise<void> {
  const sidebar = page.locator(".ai-sidebar-panel");
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    await expect(sidebar).toBeVisible();
  }
  await page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`).first().click();
  const composer = sidebarComposer(page);
  // Selection -> active reference is a React state transition. Confirm the
  // sidebar has received it before sending, otherwise a loaded dev server can
  // start an unanchored run and make the anchor assertion race the update.
  await expect(composer.locator(".ai-chat-chip")).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();
}

test("the inline composer opens in front of and below the menu bar", async ({ page }) => {
  await setup(page);

  await page.keyboard.press("Control+K");
  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await expectInlineComposerClearOfMenubar(page);
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/i1-inline-composer-menu-safe.png`, fullPage: false });
});

test("model and effort choices open as runtime-backed hover submenus", async ({ page }) => {
  await setup(page);

  await page.keyboard.press("Control+K");
  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator(".ai-chat-model-button").click();

  const menu = page.locator(".ai-chat-model-menu");
  await expect(menu).toBeVisible();
  const menuPlacement = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      parentIsBody: element.parentElement === document.body,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(menuPlacement.parentIsBody).toBe(true);
  expect(menuPlacement.top).toBeGreaterThanOrEqual(0);
  expect(menuPlacement.left).toBeGreaterThanOrEqual(0);
  expect(menuPlacement.right).toBeLessThanOrEqual(menuPlacement.viewportWidth);
  expect(menuPlacement.bottom).toBeLessThanOrEqual(menuPlacement.viewportHeight);
  const modelTrigger = menu.locator(".ai-chat-model-submenu-trigger").filter({ hasText: "モデル" });
  await modelTrigger.hover();
  const modelSubmenu = menu.locator('.ai-chat-model-submenu[data-kind="model"]');
  await expect(modelSubmenu).toBeVisible();
  await expectPopoverInsideViewport(modelSubmenu);
  await expect(modelSubmenu).toContainText("GPT E2E Runtime");
  await expect(modelSubmenu).toContainText("ChatGPT");

  await modelSubmenu.getByRole("menuitemradio", { name: "GPT E2E Runtime" }).click();
  await expect(composer.locator(".ai-chat-model-button")).toContainText("ChatGPT");
  await expect(composer.locator(".ai-chat-model-button")).toContainText("GPT E2E Runtime");
  await expect(composer.locator(".ai-chat-model-button")).toContainText("最大");

  await composer.locator(".ai-chat-model-button").click();
  const effortTrigger = page.locator(".ai-chat-model-menu .ai-chat-model-submenu-trigger").filter({ hasText: "エフォート" });
  await effortTrigger.hover();
  const effortSubmenu = page.locator('.ai-chat-model-submenu[data-kind="effort"]');
  await expect(effortSubmenu).toBeVisible();
  await expectPopoverInsideViewport(effortSubmenu);
  await expect(effortSubmenu.getByRole("menuitemradio", { name: "なし" })).toBeVisible();
  await expect(effortSubmenu.getByRole("menuitemradio", { name: "最大" })).toBeVisible();
});

test("the portalled model menu supports keyboard navigation and restores trigger focus", async ({ page }) => {
  await setup(page);

  await page.keyboard.press("Control+K");
  const composer = page.locator(".ai-chat-composer--inline");
  const modelButton = composer.locator(".ai-chat-model-button");
  // Control+K focuses the inline composer asynchronously. Wait for that
  // initialization before deliberately moving focus to the model trigger,
  // otherwise its pending focus task can race the focus-restoration check.
  await expect(composer.locator("textarea")).toBeFocused();
  await modelButton.focus();
  await modelButton.press("Enter");

  const menu = page.locator(".ai-chat-model-menu");
  const firstProvider = menu.getByRole("menuitemradio", { name: "ChatGPT", exact: true });
  await expect(firstProvider).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(modelButton).toBeFocused();

  await modelButton.press("Enter");
  await expect(firstProvider).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const modelTrigger = menu.locator(".ai-chat-model-submenu-trigger").filter({ hasText: "モデル" });
  await expect(modelTrigger).toBeFocused();
  const modelSubmenu = menu.locator('.ai-chat-model-submenu[data-kind="model"]');
  await expect(modelSubmenu.getByRole("menuitemradio", { name: "GPT E2E Runtime" })).toBeVisible();
  await modelTrigger.press("ArrowRight");
  await expect(modelSubmenu.getByRole("menuitemradio").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(modelButton).toContainText("GPT E2E Runtime");
  await expect(modelButton).toBeFocused();
});

test("Windows restores provider, model, and effort immediately after reload", async ({ page }) => {
  await setup(page, createDocument(), {
    platform: "win32",
    preserveAiModelPreferences: true,
  });

  await page.keyboard.press("Control+K");
  let composer = page.locator(".ai-chat-composer--inline");
  let modelButton = composer.locator(".ai-chat-model-button");
  await modelButton.click();
  const menu = page.locator(".ai-chat-model-menu");
  await menu.getByRole("menuitemradio", { name: "Claude", exact: true }).click();
  const effortTrigger = menu.locator(".ai-chat-model-submenu-trigger").filter({ hasText: "エフォート" });
  await effortTrigger.hover();
  await menu.locator('.ai-chat-model-submenu[data-kind="effort"]')
    .getByRole("menuitemradio", { name: "最大" })
    .click();
  await expect(modelButton).toContainText("Claude");
  await expect(modelButton).toContainText("最大");
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:ai-edit-model-preferences");
    return raw ? JSON.parse(raw) : null;
  })).toMatchObject({ provider: "claude", claudeModel: "sonnet", reasoningEffort: "max" });

  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.keyboard.press("Control+K");
  composer = page.locator(".ai-chat-composer--inline");
  modelButton = composer.locator(".ai-chat-model-button");
  await expect(modelButton).toContainText("Claude");
  await expect(modelButton).toContainText("Claude Sonnet 5");
  await expect(modelButton).toContainText("最大");
});

test("the docked sidebar model submenu remains visible over the editor", async ({ page }) => {
  await setup(page);

  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();

  const sidebar = page.locator(".ai-sidebar-panel:not(.ai-chat-host--inline)");
  await expect(sidebar).toBeVisible();
  const composer = sidebarComposer(page);
  await composer.locator(".ai-chat-model-button").click();
  const modelMenu = page.locator(".ai-chat-model-menu");
  const modelTrigger = modelMenu.locator(".ai-chat-model-submenu-trigger").filter({ hasText: "モデル" });
  await modelTrigger.hover();

  const modelSubmenu = modelMenu.locator('.ai-chat-model-submenu[data-kind="model"]');
  await expect(modelSubmenu).toBeVisible();
  await expect(modelSubmenu).toContainText("GPT E2E Runtime");
  const placement = await modelSubmenu.evaluate((element) => {
    const sidebarElement = document.querySelector<HTMLElement>(".ai-sidebar-panel:not(.ai-chat-host--inline)");
    if (!sidebarElement) {
      throw new Error("AI sidebar not found");
    }
    const submenuRect = element.getBoundingClientRect();
    const sidebarRect = sidebarElement.getBoundingClientRect();
    const exposedRight = Math.min(submenuRect.right, sidebarRect.left);
    const sampleX = (submenuRect.left + exposedRight) / 2;
    const sampleY = submenuRect.top + submenuRect.height / 2;
    const topmostElement = document.elementFromPoint(sampleX, sampleY);
    return {
      extendsOverEditor: submenuRect.left < sidebarRect.left,
      exposedPartIsInteractive: topmostElement !== null && element.contains(topmostElement),
    };
  });
  expect(placement).toEqual({
    extendsOverEditor: true,
    exposedPartIsInteractive: true,
  });
});

test("Claude Sonnet exposes effort choices and Shift+Arrow changes the effort", async ({ page }) => {
  await setup(page);

  await page.keyboard.press("Control+K");
  const composer = page.locator(".ai-chat-composer--inline");
  const modelButton = composer.locator(".ai-chat-model-button");
  await modelButton.click();
  await page.locator(".ai-chat-model-menu").getByRole("menuitemradio", { name: "Claude", exact: true }).click();
  await expect(modelButton).toContainText("Claude");
  await expect(modelButton).toContainText("Claude Sonnet 5");
  await expect(modelButton).toContainText("低");

  const effortTrigger = page.locator(".ai-chat-model-menu .ai-chat-model-submenu-trigger").filter({ hasText: "エフォート" });
  await effortTrigger.hover();
  const effortSubmenu = page.locator('.ai-chat-model-submenu[data-kind="effort"]');
  await expect(effortSubmenu.getByRole("menuitemradio", { name: "低" })).toBeVisible();
  await expect(effortSubmenu.getByRole("menuitemradio", { name: "最大" })).toBeVisible();

  await modelButton.click();
  const input = composer.locator("textarea");
  await input.focus();
  await input.press("Shift+ArrowUp");
  await expect(modelButton).toContainText("中");
});

test("a model without effort support is labeled explicitly", async ({ page }) => {
  await setup(page);

  await page.keyboard.press("Control+K");
  const composer = page.locator(".ai-chat-composer--inline");
  const modelButton = composer.locator(".ai-chat-model-button");
  await modelButton.click();

  const menu = page.locator(".ai-chat-model-menu");
  await menu.getByRole("menuitemradio", { name: "Antigravity", exact: true }).click();
  await expect(modelButton).toContainText("Antigravity");
  await expect(modelButton).toContainText("エフォート非対応");

  const effortTrigger = menu.locator(".ai-chat-model-submenu-trigger").filter({ hasText: "エフォート" });
  await expect(effortTrigger).toBeDisabled();
  await expect(effortTrigger).toContainText("このモデルでは非対応");
});

test("an AI-locked body block rejects Japanese IME text as well as direct input", async ({ page }) => {
  await setup(page);
  await startSidebarRun(page, "para_a", "SLOW この段落を整えてください");

  const block = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const originalText = await block.textContent();
  await expect(block).toHaveClass(/ai-edit-locked-block/);
  await expect(block).toHaveAttribute("contenteditable", "false");
  await block.click({ force: true });
  await page.keyboard.insertText("日本語入力");
  await expect(block).toHaveText(originalText ?? "");
});

test("a block outside the run's target stays editable during the run", async ({ page }) => {
  await setup(page);
  await startInlineRun(page, "para_a", "SLOW この段落を整えてください");

  await expect(
    page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first(),
  ).toHaveClass(/ai-edit-locked-block/);

  const unrelatedBlock = page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first();
  await expect(unrelatedBlock).not.toHaveClass(/ai-edit-locked-block/);
  await expect(unrelatedBlock).not.toHaveClass(/ai-edit-readonly-block/);
  await expect(unrelatedBlock.locator(".ai-edit-lock-char, .ai-edit-lock-atom")).toHaveCount(0);
  await expect(unrelatedBlock).not.toHaveAttribute("contenteditable", "false");

  // The inline composer's click-away catcher still covers the page while the run
  // streams. Dismissing it does not cancel the run; it only moves the ⌘K field
  // out of the way, exactly as clicking away normally does.
  await page.locator(".ai-inline-catcher").click({ force: true });
  await expect(page.locator(".ai-inline-catcher")).toHaveCount(0);

  await unrelatedBlock.click();
  await page.keyboard.insertText("人間の編集");
  await expect(unrelatedBlock).toContainText("人間の編集");
  // The run keeps going, so its own target stays locked while the human types.
  await expect(
    page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first(),
  ).toHaveClass(/ai-edit-locked-block/);
});

test("a one-character AI reference lets the rest of its paragraph edit and persist", async ({ page }) => {
  await setup(page);
  await selectParagraphTextRangeProgrammatically(page, "para_a", 0, 1);

  const aiButton = page.locator(
    '.selection-action-popover button[aria-label="AIに追加"][data-reference-kind="textSelection"]',
  );
  await expect(aiButton).toBeVisible();
  await aiButton.click();
  const composer = page.locator(".ai-chat-composer--inline");
  await composer.locator("textarea").fill("SLOW 選択した一文字だけを確認してください");
  await composer.locator(".ai-chat-send-button").click();

  const targetBlock = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const unrelatedBlock = page.locator('.text-flow-editor [data-sigma-doc-id="para_b"]').first();
  await expect(targetBlock).toHaveClass(/ai-edit-locked-block-partial/);
  await expect(targetBlock.locator(".ai-edit-lock-char")).toHaveCount(1);
  await expect(unrelatedBlock).not.toHaveClass(/ai-edit-locked-block/);
  await expect(unrelatedBlock).not.toHaveClass(/ai-edit-readonly-block/);
  await expect(unrelatedBlock.locator(".ai-edit-lock-char, .ai-edit-lock-atom")).toHaveCount(0);
  await expect(targetBlock).not.toHaveAttribute("contenteditable", "false");
  // Real browser input at the editable tail, followed by an edit before the reserved character.
  const placeCaret = async (atStart: boolean) => targetBlock.evaluate((block, start) => {
    const editor = block.closest<HTMLElement>('[contenteditable="true"]');
    editor?.focus();
    const range = document.createRange();
    if (start) {
      const firstCharacter = block.querySelector(".ai-edit-lock-char");
      if (!firstCharacter?.firstChild) throw new Error("reserved character missing");
      range.setStart(firstCharacter.firstChild, 0);
    } else {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      while (walker.nextNode()) {
        if (!walker.currentNode.parentElement?.closest('[contenteditable="false"]')) last = walker.currentNode;
      }
      if (!last) throw new Error("editable tail missing");
      range.setStart(last, last.textContent?.length ?? 0);
    }
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, atStart);
  await placeCaret(false);
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "n", selectionStart: 1, selectionEnd: 1 });
  await ime.send("Input.imeSetComposition", { text: "の", selectionStart: 1, selectionEnd: 1 });
  await ime.send("Input.insertText", { text: "の" });
  await ime.detach();
  await page.keyboard.insertText("人間の追記");
  await expect(targetBlock).toContainText("の人間の追記");
  await targetBlock.locator(".ai-edit-lock-char").evaluate((character) => {
    const range = document.createRange();
    range.selectNodeContents(character);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.keyboard.insertText("誤った置換");
  await expect(targetBlock.locator(".ai-edit-lock-char")).toHaveText("一");
  await expect(targetBlock).not.toContainText("誤った置換");
  await placeCaret(true);
  // Commit the DOM caret through a browser key event after the rejected replacement.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.insertText("先頭への追記");
  await expect(targetBlock).toContainText("先頭への追記");
  await expect(targetBlock.locator(".ai-edit-lock-char")).toHaveText("一");
  await expect(targetBlock).toHaveClass(/ai-edit-locked-block-partial/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document")))
    .toContain("先頭への追記");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
  const savedParagraph = saved.content.find((block) => block.id === "para_a") as ParagraphNode;
  const savedText = savedParagraph.children.map((node) => node.type === "text" ? node.text : node.tex).join("");
  expect(savedText).toBe("先頭への追記一次関数のグラフは直線であり、傾きと切片で形が決まります。の人間の追記");
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first()).toHaveText(savedText);
});

test("a multi-paragraph run shimmers every covered block without a blue anchor line", async ({ page }) => {
  await setup(page);
  await startInlineRunForParagraphRange(
    page,
    "para_a",
    "para_b",
    "SLOW 選択した複数段落をまとめて整えてください",
  );

  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __aiEditRunPayloads?: Array<{ references?: unknown[] }> }
  ).__aiEditRunPayloads?.[0]?.references ?? [])).toMatchObject([{
    kind: "textSelection",
    textRange: {
      start: { blockId: "para_a" },
      end: { blockId: "para_b" },
    },
  }]);

  for (const blockId of ["para_a", "para_filler_1", "para_b"]) {
    await expect(
      page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"].ai-edit-locked-block`).first(),
    ).toBeVisible();
  }
  await expect(page.locator(".ai-edit-lock-stop-button")).toHaveCount(1);
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(1);
  const rangeBadgeBox = await page.locator(".ai-run-anchor-badge").boundingBox();
  const firstBlockBox = await page.locator('[data-sigma-doc-id="para_a"]').first().boundingBox();
  const lastBlockBox = await page.locator('[data-sigma-doc-id="para_b"]').first().boundingBox();
  expect(rangeBadgeBox).not.toBeNull();
  expect(firstBlockBox).not.toBeNull();
  expect(lastBlockBox).not.toBeNull();
  const rangeBadgeCenterY = rangeBadgeBox!.y + rangeBadgeBox!.height / 2;
  expect(rangeBadgeCenterY).toBeGreaterThan(firstBlockBox!.y);
  expect(rangeBadgeCenterY).toBeLessThan(lastBlockBox!.y + lastBlockBox!.height);
  await expect(page.locator(".ai-run-anchor-block-highlight")).toHaveCount(0);
});

test("one body run shows a centered AI icon on every disconnected reference island", async ({ page }) => {
  await setup(page);
  await selectParagraphText(page, "para_a");
  const addReferenceButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(addReferenceButton).toBeVisible();
  await addReferenceButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await selectParagraphContentsProgrammatically(page, "para_b");
  // The open AI surface automatically includes the current live selection in
  // addition to the already pinned first reference.
  await expect(composer.locator(".ai-chat-chip")).toHaveCount(2);

  await composer.locator("textarea").fill("SLOW 離れた2箇所を確認してください");
  await composer.locator(".ai-chat-send-button").click();

  const firstBadge = page.locator('.ai-run-anchor-badge[data-anchor-block-id="para_a"]');
  const secondBadge = page.locator('.ai-run-anchor-badge[data-anchor-block-id="para_b"]');
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(2);
  await expect(firstBadge).toBeVisible();
  await expect(secondBadge).toBeVisible();

  for (const [badge, blockId] of [[firstBadge, "para_a"], [secondBadge, "para_b"]] as const) {
    const badgeBox = await badge.boundingBox();
    const blockBox = await page.locator(`[data-sigma-doc-id="${blockId}"]`).first().boundingBox();
    expect(badgeBox).not.toBeNull();
    expect(blockBox).not.toBeNull();
    const centerX = badgeBox!.x + badgeBox!.width / 2;
    const centerY = badgeBox!.y + badgeBox!.height / 2;
    expect(centerX).toBeGreaterThanOrEqual(blockBox!.x);
    expect(centerX).toBeLessThanOrEqual(blockBox!.x + blockBox!.width);
    expect(centerY).toBeGreaterThanOrEqual(blockBox!.y);
    expect(centerY).toBeLessThanOrEqual(blockBox!.y + blockBox!.height);
  }
});

async function widgetForBlock(page: Page, blockId: string): Promise<Locator> {
  // Widgets carry no room identifier; match by vertical position against the
  // target block's top (both live in the same viewport coordinates).
  const blockBox = await page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"]`).first().boundingBox();
  expect(blockBox).not.toBeNull();
  const widgets = page.locator(".ai-run-anchor-badge");
  const count = await widgets.count();
  let best: { index: number; distance: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const widgetBox = await widgets.nth(index).boundingBox();
    if (!widgetBox) {
      continue;
    }
    const distance = Math.abs(widgetBox.y - blockBox!.y);
    if (!best || distance < best.distance) {
      best = { index, distance };
    }
  }
  expect(best).not.toBeNull();
  return widgets.nth(best!.index);
}

test("in-body run widget anchors to the target block and follows scroll", async ({ page }) => {
  await setup(page);
  await startInlineRun(page, "para_a", "SLOW この段落を整えてください");

  const widget = page.locator(".ai-run-anchor-badge");
  await expect(widget).toBeVisible();
  await expect(widget).toHaveAttribute("data-status", /preparing|running/);
  await expect(page.locator(".ai-run-anchor-block-highlight")).toHaveCount(0);

  const block = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const widgetBoxBefore = await widget.boundingBox();
  const blockBoxBefore = await block.boundingBox();
  expect(widgetBoxBefore).not.toBeNull();
  expect(blockBoxBefore).not.toBeNull();
  // The widget sits at the center of the measured text region.
  const widgetCenterBefore = {
    x: widgetBoxBefore!.x + widgetBoxBefore!.width / 2,
    y: widgetBoxBefore!.y + widgetBoxBefore!.height / 2,
  };
  expect(widgetCenterBefore.x).toBeGreaterThanOrEqual(blockBoxBefore!.x);
  expect(widgetCenterBefore.x).toBeLessThanOrEqual(blockBoxBefore!.x + blockBoxBefore!.width);
  expect(widgetCenterBefore.y).toBeGreaterThanOrEqual(blockBoxBefore!.y);
  expect(widgetCenterBefore.y).toBeLessThanOrEqual(blockBoxBefore!.y + blockBoxBefore!.height);

  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/a1-inline-run-widget.png`, fullPage: false });
  await widget.screenshot({ path: `${test.info().outputPath("review-shots")}/a2-widget-closeup.png` });

  // Scroll the document: the widget must move with the content.
  await page.locator(".editor-canvas").evaluate((element) => {
    element.scrollTop += 250;
  });
  await expect.poll(async () => {
    const blockBox = await block.boundingBox();
    return blockBox ? Math.round(blockBoxBefore!.y - blockBox.y) : null;
  }).toBeGreaterThan(200);

  const widgetBoxAfter = await widget.boundingBox();
  const blockBoxAfter = await block.boundingBox();
  expect(widgetBoxAfter).not.toBeNull();
  expect(blockBoxAfter).not.toBeNull();
  const offsetBefore = widgetBoxBefore!.y - blockBoxBefore!.y;
  const offsetAfter = widgetBoxAfter!.y - blockBoxAfter!.y;
  expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(3);

  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/a3-widget-after-scroll.png`, fullPage: false });
});

test("two-column AI activity stays inside the target column", async ({ page }) => {
  await setup(page, createTwoColumnAiDocument());
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const leftBlock = page.locator('[data-sigma-doc-id="column_left"]').first();
  const rightBlock = page.locator('[data-sigma-doc-id="column_right"]').first();
  const leftBlockBox = await leftBlock.boundingBox();
  const rightBlockBox = await rightBlock.boundingBox();
  expect(leftBlockBox).not.toBeNull();
  expect(rightBlockBox).not.toBeNull();
  expect(rightBlockBox!.x).toBeGreaterThan(leftBlockBox!.x + leftBlockBox!.width);

  await startInlineRun(page, "column_left", "SLOW 左段だけを整えてください");
  await closeInlineSurface(page);
  await startInlineRun(page, "column_right", "SLOW 右段だけを整えてください");
  await closeInlineSurface(page);

  const leftBadge = page.locator('.ai-run-anchor-badge[data-anchor-block-id="column_left"]');
  const rightBadge = page.locator('.ai-run-anchor-badge[data-anchor-block-id="column_right"]');
  await expect(leftBadge).toBeVisible();
  await expect(rightBadge).toBeVisible();

  const leftBadgeBox = await leftBadge.boundingBox();
  const rightBadgeBox = await rightBadge.boundingBox();
  expect(leftBadgeBox).not.toBeNull();
  expect(rightBadgeBox).not.toBeNull();
  const leftBadgeCenterX = leftBadgeBox!.x + leftBadgeBox!.width / 2;
  const rightBadgeCenterX = rightBadgeBox!.x + rightBadgeBox!.width / 2;
  expect(leftBadgeCenterX).toBeGreaterThanOrEqual(leftBlockBox!.x);
  expect(leftBadgeCenterX).toBeLessThanOrEqual(leftBlockBox!.x + leftBlockBox!.width);
  expect(rightBadgeCenterX).toBeGreaterThanOrEqual(rightBlockBox!.x);
  expect(rightBadgeCenterX).toBeLessThanOrEqual(rightBlockBox!.x + rightBlockBox!.width);

  await leftBadge.click();
  const leftCard = page.locator(".ai-run-anchor-card");
  await expect(leftCard).toBeVisible();
  const leftCardBox = await leftCard.boundingBox();
  expect(leftCardBox).not.toBeNull();
  expect(leftCardBox!.x).toBeGreaterThanOrEqual(leftBlockBox!.x - 2);
  expect(leftCardBox!.x + leftCardBox!.width).toBeLessThanOrEqual(leftBlockBox!.x + leftBlockBox!.width + 2);
  await leftCard.getByRole("button", { name: "閉じる" }).click();

  await rightBadge.click();
  const rightCard = page.locator(".ai-run-anchor-card");
  await expect(rightCard).toBeVisible();
  const rightCardBox = await rightCard.boundingBox();
  expect(rightCardBox).not.toBeNull();
  expect(rightCardBox!.x).toBeGreaterThanOrEqual(rightBlockBox!.x - 2);
  expect(rightCardBox!.x + rightCardBox!.width).toBeLessThanOrEqual(rightBlockBox!.x + rightBlockBox!.width + 2);
});

test("two-column body replacement proposal keeps its standard width and can be closed", async ({ page }) => {
  await setup(page, createTwoColumnAiDocument());
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const leftBlock = page.locator('[data-sigma-doc-id="column_left"]').first();
  const leftBlockBox = await leftBlock.boundingBox();
  expect(leftBlockBox).not.toBeNull();

  await startInlineRun(page, "column_left", "PROPOSAL 左段の本文を更新して");
  const replacement = page.locator('.ai-column-preview-anchor[data-ai-preview-target-id="column_left"]');
  await expect(replacement).toBeVisible({ timeout: 20_000 });
  await expect(replacement).toContainText("E2E提案で書き換えた本文");
  const dialog = replacement.locator('.ai-inline-preview-dialog');
  await expect(dialog).toHaveCSS("width", "440px");
  const replacementBox = await dialog.boundingBox();
  expect(replacementBox).not.toBeNull();
  expect(replacementBox!.x).toBeGreaterThanOrEqual(leftBlockBox!.x - 2);
  expect(replacementBox!.y).toBeGreaterThanOrEqual(leftBlockBox!.y + leftBlockBox!.height - 2);
  const applyButtonBox = await replacement.locator('.ai-inline-preview-action.apply[aria-label="適用"]').boundingBox();
  expect(applyButtonBox).not.toBeNull();
  expect(applyButtonBox!.x + applyButtonBox!.width).toBeLessThanOrEqual(
    replacementBox!.x + replacementBox!.width + 2,
  );
  const close = dialog.getByRole("button", { name: "閉じる", exact: true });
  const closeBox = await close.boundingBox();
  expect(closeBox!.x).toBeGreaterThan(replacementBox!.x + replacementBox!.width / 2);
  // The completion summary is a separate floating surface above the body card.
  const summary = page.locator('.ai-chat-host--inline .ai-inline-result');
  await expect(summary).toBeVisible();
  await summary.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(summary).toBeHidden();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(leftBlock).not.toContainText("E2E提案で書き換えた本文");
});

test("two-column math replacement is visible immediately after approval", async ({ page }) => {
  const lifecycleWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("flushSync was called from inside a lifecycle method")) {
      lifecycleWarnings.push(message.text());
    }
  });
  await setup(page, createTwoColumnMathAiDocument(), {
    ai: { enabled: true, omitBatchApproveFileMetadata: true },
  });
  expect(lifecycleWarnings).toEqual([]);
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const target = page.locator('[data-sigma-doc-id="column_left_math"]').first();
  const math = target.locator('[data-id="e2e_two_column_math"]');
  const originalTex = "(n+1)^7=n^7+7n^6+21n^5+35n^4+35n^3+21n^2+7n+1";
  const proposedTex = "\\begin{aligned}(n+1)^7&=n^7+7n^6+21n^5+35n^4\\\\&\\quad+35n^3+21n^2+7n+1\\end{aligned}";
  await expect(math).toHaveAttribute("data-tex", originalTex);

  await startSidebarRun(page, "column_left_math", "PROPOSAL MATH_BREAK 数式を2行にして");
  const replacement = page.locator('.ai-column-preview-anchor[data-ai-preview-target-id="column_left_math"]');
  await expect(replacement).toBeVisible({ timeout: 20_000 });
  expect(lifecycleWarnings).toEqual([]);
  await replacement.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();

  await expect(replacement).toBeHidden();
  await expect(target.locator('[data-id="e2e_two_column_math"]')).toHaveAttribute("data-tex", proposedTex);
  expect(lifecycleWarnings).toEqual([]);
});

test("two-column body and overlay insertion proposals stay in their target columns", async ({ page }) => {
  await setup(page, createTwoColumnAiDocument());
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const leftBlock = page.locator('[data-sigma-doc-id="column_left"]').first();
  const leftBlockBox = await leftBlock.boundingBox();
  expect(leftBlockBox).not.toBeNull();

  await startInlineRun(page, "column_left", "PROPOSAL CHAIN 左段に説明を挿入して");
  const bodyInsertion = page.locator('.ai-column-preview-anchor[data-ai-preview-target-id="column_left"]');
  await expect(bodyInsertion).toBeVisible({ timeout: 20_000 });
  const bodyInsertionBox = await bodyInsertion.boundingBox();
  expect(bodyInsertionBox).not.toBeNull();
  expect(bodyInsertionBox!.x).toBeGreaterThanOrEqual(leftBlockBox!.x - 2);
  expect(bodyInsertionBox!.x + bodyInsertionBox!.width).toBeLessThanOrEqual(leftBlockBox!.x + leftBlockBox!.width + 2);
  expect(bodyInsertionBox!.y).toBeGreaterThanOrEqual(leftBlockBox!.y + leftBlockBox!.height - 2);

  await closeInlineSurface(page);
  await bodyInsertion.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(bodyInsertion).toBeHidden();

  const rightBlock = page.locator('[data-sigma-doc-id="column_right"]').first();
  const rightBlockBox = await rightBlock.boundingBox();
  expect(rightBlockBox).not.toBeNull();
  await startInlineRun(page, "column_right", "PROPOSAL SHAPE INSERT 右段に図形を挿入して");
  const overlayInsertion = page.locator(".ai-overlay-approval-widget");
  await expect(overlayInsertion).toBeVisible({ timeout: 20_000 });
  const overlayInsertionBox = await overlayInsertion.boundingBox();
  expect(overlayInsertionBox).not.toBeNull();
  expect(overlayInsertionBox!.x).toBeGreaterThanOrEqual(rightBlockBox!.x - 2);
  expect(overlayInsertionBox!.x + overlayInsertionBox!.width).toBeLessThanOrEqual(
    rightBlockBox!.x + rightBlockBox!.width + 2,
  );
});

test("local layout-section columns keep AI activity and body insertion in their own columns", async ({ page }) => {
  await setup(page, createLocalColumnAiDocument());
  const section = page.locator('[data-layout-section-id="local_ai_columns"]');
  await expect(section).toBeVisible();
  await expect.poll(async () => section.locator(".text-flow-shell").first().evaluate(
    (element) => getComputedStyle(element).columnCount,
  )).toBe("2");

  const targets = await section.locator('[data-sigma-doc-id^="local_col_"]').evaluateAll((elements) => (
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.getAttribute("data-sigma-doc-id") ?? "", x: rect.x, width: rect.width };
    })
  ));
  const leftTarget = targets.reduce((best, target) => target.x < best.x ? target : best);
  const rightTarget = targets.reduce((best, target) => target.x >= best.x ? target : best);
  expect(rightTarget.x).toBeGreaterThan(leftTarget.x + leftTarget.width);

  await startInlineRun(page, leftTarget.id, "PROPOSAL CHAIN 左段に説明を挿入して");
  const leftBadge = page.locator(`.ai-run-anchor-badge[data-anchor-block-id="${leftTarget.id}"]`);
  await expect(leftBadge).toBeVisible();
  const leftBadgeBox = await leftBadge.boundingBox();
  expect(leftBadgeBox).not.toBeNull();
  const leftBadgeCenterX = leftBadgeBox!.x + leftBadgeBox!.width / 2;
  expect(leftBadgeCenterX).toBeGreaterThanOrEqual(leftTarget.x);
  expect(leftBadgeCenterX).toBeLessThanOrEqual(leftTarget.x + leftTarget.width);

  const bodyInsertion = page.locator(`.ai-column-preview-anchor[data-ai-preview-target-id="${leftTarget.id}"]`);
  await expect(bodyInsertion).toBeVisible({ timeout: 20_000 });
  const bodyInsertionBox = await bodyInsertion.boundingBox();
  expect(bodyInsertionBox).not.toBeNull();
  expect(bodyInsertionBox!.x).toBeGreaterThanOrEqual(leftTarget.x - 2);
  expect(bodyInsertionBox!.x + bodyInsertionBox!.width).toBeLessThanOrEqual(leftTarget.x + leftTarget.width + 2);

  await closeInlineSurface(page);
  await bodyInsertion.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(bodyInsertion).toBeHidden();

  await startInlineRun(page, rightTarget.id, "SLOW 右段だけを整えてください");
  await closeInlineSurface(page);
  const rightBadge = page.locator(`.ai-run-anchor-badge[data-anchor-block-id="${rightTarget.id}"]`);
  await expect(rightBadge).toBeVisible();
  const activeRightBox = await page.locator(`[data-sigma-doc-id="${rightTarget.id}"]`).first().boundingBox();
  expect(activeRightBox).not.toBeNull();
  await rightBadge.click();
  const rightCardBox = await page.locator(".ai-run-anchor-card").boundingBox();
  expect(rightCardBox).not.toBeNull();
  expect(rightCardBox!.x).toBeGreaterThanOrEqual(activeRightBox!.x - 2);
  expect(rightCardBox!.x + rightCardBox!.width).toBeLessThanOrEqual(
    activeRightBox!.x + activeRightBox!.width + 3,
  );
});

test("parallel inline runs create separate rooms with simultaneous widgets, and widgets focus their room", async ({ page }) => {
  await setup(page);

  // Run A on para_a.
  await startInlineRun(page, "para_a", "SLOW 一次関数の説明を詳しくして");
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(1);
  await closeInlineSurface(page);

  // Run B on para_b while A is still running.
  await startInlineRun(page, "para_b", "SLOW 二次関数の頂点の説明を追加して");
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(2);
  await closeInlineSurface(page);

  // Money shot: two in-body run widgets at the same time.
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/b1-parallel-widgets.png`, fullPage: false });

  // Two separate rooms exist (one per inline invocation) and both are running.
  const runPayloads = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { instruction: string }[] }).__aiEditRunPayloads);
  expect(runPayloads).toHaveLength(2);
  expect(runPayloads[0].instruction).toContain("一次関数");
  expect(runPayloads[1].instruction).toContain("二次関数");

  // (d) Clicking an in-body widget pins that room's conversation card in
  // place; its サイドチャットで開く button promotes the room to the sidebar. The
  // OLDER run's widget (A) goes first: this is the Bug-3 regression — the
  // promotion remounts AiEditPanel, and the async room-list load resolving
  // afterwards used to clobber the focus request with the newest room (B).
  const widgetA = await widgetForBlock(page, "para_a");
  await widgetA.click();
  const cardA = page.locator(".ai-run-anchor-card", { hasText: "一次関数" });
  await expect(cardA).toBeVisible();
  await cardA.locator(".ai-activity-popover-sidebar-button").click();
  const sidebar = page.locator(".ai-sidebar-panel");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(".ai-chat-turn.user")).toContainText("一次関数");

  // Opening run B's widget card in the sidebar switches the already-open
  // sidebar to room B.
  const widgetB = await widgetForBlock(page, "para_b");
  await widgetB.click();
  const cardB = page.locator(".ai-run-anchor-card", { hasText: "二次関数" });
  await expect(cardB).toBeVisible();
  await cardB.locator(".ai-activity-popover-sidebar-button").click();
  await expect(sidebar.locator(".ai-chat-turn.user")).toContainText("二次関数");
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/g1-sidebar-focused-room-b.png`, fullPage: false });
});

test("clicking the in-body widget mid-run promotes to the sidebar and keeps showing the live run through completion", async ({ page }) => {
  await setup(page);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  // Start an inline SLOW run, then promote it mid-run: click the in-body
  // widget to pin its conversation card and use the card's サイドチャットで開く
  // button. Promotion REMOUNTS AiEditPanel — before the run-controller
  // refactor (Bug 2) the in-flight run kept mutating the unmounted instance's
  // state and the visible panel froze on "running" forever.
  await startInlineRun(page, "para_a", "SLOW 途中で右サイドに昇格させる");
  await closeInlineSurface(page);

  const widget = page.locator(".ai-run-anchor-badge");
  await expect(widget).toHaveAttribute("data-status", /preparing|running/);
  await widget.click();

  const card = page.locator(".ai-run-anchor-card");
  await expect(card).toBeVisible();
  await card.locator(".ai-activity-popover-sidebar-button").click();

  const sidebar = page.locator(".ai-sidebar-panel");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(".ai-chat-turn.user")).toContainText("途中で右サイドに昇格させる");

  // The promoted sidebar shows the live running activity (assistant turn +
  // running badge on the history button) while the run is still in flight.
  const assistantTurn = sidebar.locator(".ai-chat-turn.assistant");
  await expect(assistantTurn).toBeVisible();
  await expect(sidebar.locator(".ai-chat-room-status-dot--badge")).toBeVisible();
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/g2-promoted-mid-run-running.png`, fullPage: false });

  // ...and the SAME (remounted) panel then observes completion — the run's
  // result lands in the visible transcript, not an orphaned closure.
  await expect(assistantTurn.locator(".ai-chat-result")).toBeVisible({ timeout: 25_000 });
  await expect(sidebar.locator(".ai-chat-room-status-dot--badge")).toBeHidden();
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/g3-promoted-mid-run-completed.png`, fullPage: false });

  // Bug 1 regression: starting an inline run and promoting mid-run must not
  // spin the portal-ready effect into a React update-depth loop.
  const updateDepthErrors = consoleErrors.filter((text) => text.includes("Maximum update depth"));
  expect(updateDepthErrors).toEqual([]);
});

test("sending while a run is active queues the message and dispatches it on completion with the same thread", async ({ page }) => {
  await setup(page);

  // Sidebar-native run: the queue lifecycle must stay within one AiEditPanel
  // instance (see startSidebarRun's comment / bug report).
  await startSidebarRun(page, "para_a", "SLOW 数式の表現を統一して");
  const sidebar = page.locator(".ai-sidebar-panel");
  await expect(page.locator(".ai-run-anchor-badge")).toBeVisible();

  // (f) History button shows the running badge while the run is active.
  await expect(sidebar.locator(".ai-chat-room-status-dot--badge")).toBeVisible();

  // (c) Send a follow-up while the run is active → queued as 送信待ち.
  const composer = sidebarComposer(page);
  await composer.locator("textarea").fill("フォローアップ: 用語の説明も加えて");
  await composer.locator(".ai-chat-send-button").click();
  const queuedPill = sidebar.locator(".ai-chat-queued-pill");
  await expect(queuedPill).toBeVisible();
  await expect(queuedPill).toHaveText("送信待ち");
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/c1-queued-pill.png`, fullPage: false });

  // When the first run completes, the queued turn dispatches automatically:
  // the pill clears and a second assistant turn starts.
  await expect(queuedPill).toBeHidden({ timeout: 25_000 });
  await expect(sidebar.locator(".ai-chat-turn.assistant")).toHaveCount(2);
  await expect(sidebar.locator(".ai-chat-turn.user").nth(1)).toContainText("フォローアップ");
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/c2-queued-dispatched.png`, fullPage: false });

  // Thread continuity: the dispatched follow-up reuses the agentThreadId that
  // the first run returned (e2e-thread-1).
  await expect.poll(async () =>
    page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { agentThreadId: string | null }[] }).__aiEditRunPayloads.length),
  ).toBe(2);
  const payloads = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { instruction: string; agentThreadId: string | null }[] }).__aiEditRunPayloads);
  expect(payloads[0].agentThreadId).toBeNull();
  expect(payloads[1].instruction).toContain("フォローアップ");
  expect(payloads[1].agentThreadId).toBe("e2e-thread-1");
});

test("a failed run marks its widget failed and leaves the queued message as unsent with resend", async ({ page }) => {
  await setup(page);

  // SLOW+FAIL: rejects after ~15s, leaving time to queue a message behind it.
  // Sidebar-native run for the same reason as the queue-dispatch test.
  await startSidebarRun(page, "para_a", "SLOW FAIL この編集は失敗します");
  const sidebar = page.locator(".ai-sidebar-panel");
  await expect(page.locator(".ai-run-anchor-badge")).toBeVisible();

  const composer = sidebarComposer(page);
  await composer.locator("textarea").fill("この指示は未送信になるはず");
  await composer.locator(".ai-chat-send-button").click();
  await expect(sidebar.locator(".ai-chat-queued-pill")).toHaveText("送信待ち");

  // (e) After the run fails: widget shows failed, queued message flips to 未送信 + 再送信.
  const failedPill = sidebar.locator(".ai-chat-queued-pill--failed");
  await expect(failedPill).toBeVisible({ timeout: 25_000 });
  await expect(failedPill).toContainText("未送信");
  await expect(failedPill.locator(".ai-chat-queued-resend")).toHaveText("再送信");
  await expect(page.locator('.ai-run-anchor-badge[data-status="failed"]')).toBeVisible();
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/e1-failed-run-unsent-queue.png`, fullPage: false });
  await page.locator('.ai-run-anchor-badge[data-status="failed"]').screenshot({ path: `${test.info().outputPath("review-shots")}/e2-failed-widget-closeup.png` });

  // No auto-retry happened.
  const payloadCount = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: unknown[] }).__aiEditRunPayloads.length);
  expect(payloadCount).toBe(1);
});

test("a run that produces a proposal shows the redesigned inline preview card", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL この段落を提案付きで書き換えて");

  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await expect(previewDialog).toContainText("E2E提案で書き換えた本文");

  // Dismiss the floating inline result card so it does not overlap the
  // proposal card in the screenshots.
  const inlineResultClose = page.locator(".ai-chat-host--inline").getByRole("button", { name: "閉じる" });
  if (await inlineResultClose.count()) {
    await inlineResultClose.first().click();
    await expect(inlineResultClose).toBeHidden();
  }
  await expect(previewDialog).toBeVisible();
  // Decision buttons are icon-only (no text label), identified by aria-label.
  await expect(previewDialog.locator('.ai-inline-preview-action.discard[aria-label="破棄"]')).toBeVisible();
  await expect(previewDialog.locator('.ai-inline-preview-action.apply[aria-label="適用"]')).toBeVisible();

  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/f1-proposal-card-page.png`, fullPage: false });
  await previewDialog.screenshot({ path: `${test.info().outputPath("review-shots")}/f2-proposal-card-closeup.png` });

  // The completed run's AI icon STAYS put (with its "done" badge) alongside the
  // proposal card — it only clears once the proposal is applied/discarded.
  const completedBadge = page.locator('.ai-run-anchor-badge[data-status="completed"]');
  await expect(completedBadge).toBeVisible();
  await expect(completedBadge.locator(".ai-run-anchor-badge-status")).toBeVisible();
  await page.locator(".ai-run-anchor-badge-logo").first().screenshot({ path: `${test.info().outputPath("review-shots")}/f3-completed-badge-closeup.png` });

  // Applying the proposal resolves the card AND removes the AI icon together.
  await previewDialog.locator(".ai-inline-preview-action.apply").click();
  await expect(previewDialog).toBeHidden();
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(0);
});

test("a chained insertion proposal shows every candidate in one preview card", async ({ page }) => {
  await setup(page);

  // "CHAIN": the proposal inserts a run of blocks by chaining insertAfter — op 2
  // targets op 1's freshly-inserted (not-yet-existing) block id. Every candidate
  // must still appear, folded onto the real anchor block, so the preview matches
  // what applying will insert.
  await startInlineRun(page, "para_a", "PROPOSAL CHAIN 公式をまとめて挿入して");

  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });

  const operations = previewDialog.locator(".ai-inline-preview-operation");
  await expect(operations).toHaveCount(3);
  await expect(previewDialog).toContainText("E2E提案で書き換えた本文");
  await expect(previewDialog).toContainText("連鎖挿入1: 初項aの説明");
  await expect(previewDialog).toContainText("連鎖挿入2: 公式本体");

  // One consolidated decision, not one per chained op.
  await expect(previewDialog.locator(".ai-inline-preview-action.apply")).toHaveCount(1);
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/f4-chained-candidates.png`, fullPage: false });
});

test("the hover card's embedded composer sends a follow-up in place, bound to the room's provider", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "SLOW ホバーカードから追撃する");
  await closeInlineSurface(page);

  const badge = page.locator(".ai-run-anchor-badge");
  await expect(badge).toBeVisible();
  // Hover reveals the activity card with its full embedded composer (attach +
  // think-level + send), no sidebar hop.
  await badge.hover();
  const card = page.locator(".ai-run-anchor-card");
  await expect(card).toBeVisible();
  await expect.poll(async () =>
    card.evaluate((element) => element.parentElement === document.body),
  ).toBe(true);
  const placement = await card.evaluate((element) => {
    const cardRect = element.getBoundingClientRect();
    const menubarRect = document.querySelector(".editor-menubar")?.getBoundingClientRect();
    return {
      top: cardRect.top,
      bottom: cardRect.bottom,
      menubarBottom: menubarRect?.bottom ?? 0,
      viewportHeight: window.innerHeight,
    };
  });
  expect(placement.top).toBeGreaterThanOrEqual(placement.menubarBottom);
  expect(placement.bottom).toBeLessThanOrEqual(placement.viewportHeight);
  const composer = card.locator(".ai-run-card-composer");
  await expect(composer.locator(".ai-chat-icon-button")).toBeVisible();
  await composer.locator(".ai-chat-input").fill("用語も補足して");
  await composer.locator(".ai-chat-send-button").click();
  await page.screenshot({ path: `${test.info().outputPath("review-shots")}/h1-hovercard-inplace-composer.png`, fullPage: false });

  // Sent in place: while the first run is still going the follow-up queues, then
  // dispatches on completion as a second run — no sidebar promotion needed.
  await expect.poll(async () =>
    page.evaluate(() => (window as unknown as { __aiEditRunPayloads: unknown[] }).__aiEditRunPayloads.length),
    { timeout: 25_000 },
  ).toBe(2);
  const payloads = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { instruction: string; provider?: string }[] }).__aiEditRunPayloads);
  expect(payloads[1].instruction).toContain("用語も補足して");
});
