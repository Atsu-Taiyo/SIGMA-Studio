import { expect, test, type Page } from "@playwright/test";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { getDefaultPageLayout } from "@/lib/page-layout";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

// Regression harness for the AI edit proposal's overlay-shape approval preview.
// Overlay proposals must render their decision UI in the overlay layer rather
// than inserting an approval card into the measured body flow. Reuses the
// desktop runtime mock's "PROPOSAL"/"SHAPE" instruction keywords (see
// desktop-runtime-mock.ts): "PROPOSAL SHAPE" produces a pending proposal whose
// draft is a single updateOverlayShape mutationOperation against the document's
// (auto-synthesized) overlay shape instead of the default text-replace draft.

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
  ];
  // The desktop runtime mock anchors its auto-synthesized overlay shape fixture
  // to the LAST paragraph-type block (see ensureOverlayShapeFixture) — these
  // trailing filler paragraphs are never selected/clicked by this spec, so the
  // shape never sits on top of para_a's text-selection click target.
  for (let index = 0; index < 6; index += 1) {
    content.push(paragraph(`para_pad_${index}`, `補足の本文です。この行はページを縦に伸ばすための段落 ${index + 1} です。`));
  }
  return {
    version: "2.0",
    docId: "ai_shape_proposal_e2e_doc",
    metadata: { title: "AI図形提案E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function createBackgroundShapeDocument(): SigmaDocument {
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
            rotation: 0,
            stackLayer: "background",
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
            anchor: { type: "block", blockId: "para_pad_5", dy: 0 },
          }],
          assets: {},
        },
      },
    },
  } as unknown as SigmaDocument;
}

function createWhiteboardDocument(): SigmaDocument {
  return {
    ...createDocument(),
    docId: "ai_whiteboard_shape_proposal_e2e_doc",
    metadata: { title: "AIホワイトボード図形提案E2E" },
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("whiteboard"),
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [{
            id: "whiteboard_shape_1",
            type: "geo",
            x: 180,
            y: 140,
            props: {
              w: 180,
              h: 100,
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
  };
}

async function setup(page: Page, document: SigmaDocument = createDocument()): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, document, { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  // The startup splash overlays the whole page for a moment and would hide the
  // selection action UI.
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function readAiDiffOpacity(
  page: Page,
  beforeSelector: string,
  afterSelector: string,
): Promise<{ before: string; after: string }> {
  return page.evaluate(({ beforeSelector: before, afterSelector: after }) => {
    const beforeElement = document.querySelector<HTMLElement>(before);
    const afterElement = document.querySelector<HTMLElement>(after);
    return {
      before: beforeElement ? window.getComputedStyle(beforeElement).opacity : "missing",
      after: afterElement ? window.getComputedStyle(afterElement).opacity : "missing",
    };
  }, { beforeSelector, afterSelector });
}

async function selectParagraphText(page: Page, blockId: string): Promise<void> {
  const selectedText = await page.evaluate((targetBlockId) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(
      `.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`,
    )).find((element) => element.getClientRects().length > 0 && Boolean(element.textContent?.trim()));
    if (!target) {
      throw new Error(`selection target not found: ${targetBlockId}`);
    }

    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!(textNode instanceof Text) || !textNode.data) {
      throw new Error(`selection text not found: ${targetBlockId}`);
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const selectionLength = Math.min(8, textNode.data.length);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, selectionLength);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return textNode.data.slice(0, selectionLength);
  }, blockId);
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe(selectedText);
}

// Selects text in the block, opens the inline AI composer through the
// selection-action popover, and sends the given instruction.
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

async function insertAndSelectRectangle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "図形", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "四角形", exact: true }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 220, box!.y + 180);
  await page.mouse.down();
  await page.mouse.move(box!.x + 380, box!.y + 280, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".overlay-shape-geo.selected")).toHaveCount(1);
}

test("a selected overlay shape is kept as a small PNG in the chat turn", async ({ page }) => {
  await setup(page);
  await insertAndSelectRectangle(page);

  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await expect(page.locator(".overlay-shape-geo.selected")).toHaveCount(1);
  await expect(composer.locator(".ai-chat-overlay-preview-stage")).toBeVisible();
  await expect(composer.locator(".ai-chat-overlay-preview-stage svg")).toBeVisible();
  await expect(composer.locator(".ai-chat-attachment-name")).toHaveText("図形1");
  const previewBox = await composer.locator(".ai-chat-overlay-preview").boundingBox();
  const previewStageBox = await composer.locator(".ai-chat-overlay-preview-stage").boundingBox();
  const shapeLabelBox = await composer.locator(".ai-chat-shape-label-chip").boundingBox();
  const referenceChipBox = await composer.locator('.ai-chat-chip[data-reference-kind="block"]').first().boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewStageBox).not.toBeNull();
  expect(shapeLabelBox).not.toBeNull();
  expect(referenceChipBox).not.toBeNull();
  expect(previewStageBox!.width / previewStageBox!.height).toBeGreaterThan(1.35);
  expect(shapeLabelBox!.x).toBeGreaterThanOrEqual(previewStageBox!.x);
  expect(shapeLabelBox!.y).toBeGreaterThanOrEqual(previewStageBox!.y);
  expect(shapeLabelBox!.x + shapeLabelBox!.width).toBeLessThanOrEqual(previewStageBox!.x + previewStageBox!.width);
  expect(shapeLabelBox!.y + shapeLabelBox!.height).toBeLessThanOrEqual(previewStageBox!.y + previewStageBox!.height);
  expect(Math.abs(
    previewBox!.y + previewBox!.height - referenceChipBox!.y - referenceChipBox!.height,
  )).toBeLessThanOrEqual(2);
  await composer.locator("textarea").fill("この図形を見やすく調整して");
  await composer.locator(".ai-chat-send-button").click();

  const openSidebar = page.getByRole("button", { name: "サイドチャットで開く" }).last();
  await expect(openSidebar).toBeVisible({ timeout: 20_000 });
  await openSidebar.click();

  const userTurn = page.locator('.ai-edit-panel[data-variant="sidebar"] .ai-chat-turn.user').last();
  await expect(userTurn).toBeVisible();
  await expect(userTurn.locator("figcaption")).toHaveText("図形1");
  const thumbnail = userTurn.locator(".ai-chat-user-attachment-image");
  await expect(thumbnail).toBeVisible();
  await expect.poll(async () => thumbnail.getAttribute("style")).toContain("data:image/png;base64,");
});

test("a selected whiteboard shape can start an AI edit proposal without a body block", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createWhiteboardDocument(), { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();

  const editorShape = page.locator('.overlay-canvas-editor [data-overlay-shape-id="whiteboard_shape_1"]').first();
  await expect(editorShape).toBeVisible();
  await editorShape.click();
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="whiteboard_shape_1"]')).toBeVisible();

  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".ai-chat-overlay-preview-stage")).toBeVisible();
  await composer.locator("textarea").fill("PROPOSAL SHAPE この図形を右へ移動して");
  await composer.locator(".ai-chat-send-button").click();

  await expect.poll(async () => page.evaluate(() => (
    (window as unknown as { __aiEditRunPayloads?: unknown[] }).__aiEditRunPayloads?.length ?? 0
  ))).toBe(1);
  const payload = await page.evaluate(() => (
    (window as unknown as { __aiEditRunPayloads: Array<{
      selectedId: string | null;
      references: Array<{ targetId: string; overlaySelection?: { selectedShapeIds?: string[] } }>;
    }> }).__aiEditRunPayloads[0]
  ));
  expect(payload.selectedId).toBe("whiteboard_shape_1");
  expect(payload.references[0]).toMatchObject({
    targetId: "whiteboard_shape_1",
    overlaySelection: { selectedShapeIds: ["whiteboard_shape_1"] },
  });

  await expect(page.locator(".whiteboard-canvas .ai-overlay-approval-widget")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.whiteboard-canvas .overlay-shape.ai-diff-ghost-shape[data-overlay-shape-id="whiteboard_shape_1"]')).toBeVisible();
});

async function startShapeRun(page: Page, shapeId: string, instruction: string): Promise<void> {
  const previewShape = page.locator(`.page-overlay-preview [data-overlay-shape-id="${shapeId}"]`).first();
  await expect(previewShape).toBeVisible();
  await grabShapeFromBody(page, previewShape);

  const selectedShape = page.locator(`.overlay-shape.selected[data-overlay-shape-id="${shapeId}"]`).first();
  await expect(selectedShape).toBeVisible();
  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();
}

test("a shape run removes the nearby icon and opens its AI card from the shape hover", async ({ page }) => {
  await setup(page);
  await startShapeRun(page, "e2e_shape_1", "SLOW この図形を整えてください");

  const shape = page.locator('.overlay-shape[data-overlay-shape-id="e2e_shape_1"]').first();
  await expect(shape).toHaveClass(/ai-edit-locked-shape/);
  await expect(page.locator(".ai-run-anchor-badge")).toHaveCount(0);
  await expect(page.locator(".ai-inline-catcher")).toHaveCount(0);

  await shape.hover();
  const card = page.getByRole("dialog", { name: "AIの作業状況" });
  await expect(card).toBeVisible();
  await card.hover();
  await expect(card).toBeVisible();
});

test("a shape-mutation proposal shows a contextual overlay approval widget and canvas diff ghost", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL SHAPE 図形を右に移動して");

  const approvalWidget = page.locator(".ai-overlay-approval-widget");
  await expect(approvalWidget).toBeVisible({ timeout: 20_000 });
  await expect(approvalWidget).toContainText("AI図形の変更案");
  await expect(page.locator(".ai-inline-preview-dialog")).toHaveCount(0);

  // Dismiss the floating inline result card (and its full-viewport outside-click
  // catcher) so it does not intercept clicks meant for the overlay widget below.
  const inlineResultClose = page.locator(".ai-chat-host--inline").getByRole("button", { name: "閉じる" });
  if (await inlineResultClose.count()) {
    await inlineResultClose.first().click();
    await expect(inlineResultClose).toBeHidden();
  }
  await expect(approvalWidget).toBeVisible();

  // Decision buttons are present and enabled.
  const applyButton = approvalWidget.locator('.ai-inline-preview-action.apply[aria-label="適用"]');
  await expect(applyButton).toBeVisible();
  await expect(applyButton).toBeEnabled();
  await expect(approvalWidget.locator('.ai-inline-preview-action.discard[aria-label="破棄"]')).toBeVisible();

  // "続けて修正" opens the existing conversation-history card in a body
  // portal instead of expanding a cramped composer inside the proposal widget.
  await approvalWidget.getByRole("button", { name: "続けて修正" }).click();
  await expect(approvalWidget.locator(".ai-run-card-composer")).toHaveCount(0);
  const conversationCard = page.getByRole("dialog", { name: "AIの作業状況" });
  await expect(conversationCard).toBeVisible();
  await expect(conversationCard.locator(".ai-run-anchor-card-transcript")).toContainText("図形を右に移動して");
  const followUpInput = conversationCard.getByRole("textbox", { name: "AIへの追加指示" });
  await expect(followUpInput).toBeFocused();
  await expect(followUpInput).toHaveCSS("font-size", "14px");
  const cardModelButton = conversationCard.getByRole("button", { name: "モデルと思考の深さを選択" });
  await expect(cardModelButton).toBeVisible();
  await cardModelButton.click();
  const modelMenu = page.locator(".ai-chat-model-menu");
  await expect(modelMenu.getByRole("menuitem", { name: /モデル/ })).toBeVisible();
  await expect(modelMenu.getByRole("menuitem", { name: /エフォート/ })).toBeVisible();
  await conversationCard.getByRole("button", { name: "閉じる" }).click();
  await expect(conversationCard).toBeHidden();

  // Canvas diff: a ghost of the post-apply shape state (ghost, but NOT the
  // "added" class — this is a modification, not an insertion), while the live
  // shape keeps its dashed "will change" outline. Both share the same
  // data-overlay-shape-id, so the diff classes are the only way to tell them
  // apart.
  const ghostShape = page.locator('.overlay-shape.ai-diff-ghost-shape[data-overlay-shape-id="e2e_shape_1"]');
  await expect(ghostShape).toBeVisible();
  await expect(ghostShape).not.toHaveClass(/ai-diff-added-shape/);
  await expect(ghostShape).toHaveClass(/ai-diff-after-shape/);
  await expect(ghostShape).toHaveCSS("outline-width", "3px");
  await expect(ghostShape).toHaveCSS("outline-style", "dashed");
  // The before/after phases used to be one clock on `.page-canvas` driving custom properties.
  // PR #350 moved them onto the shapes themselves (`ai-overlay-diff-before-phase` /
  // `-after-phase`), because the live shape and its ghost can live in different overlay layers and
  // a remount of one desynchronised the pair. The sibling test at the bottom of this file was
  // updated then; this one kept asserting the retired shared clock and a static `opacity: 1`,
  // which an alternating phase can never satisfy.
  await expect(ghostShape).toHaveCSS("animation-name", "ai-overlay-diff-after-phase");
  const liveShape = page.locator('.overlay-shape.ai-diff-modified-shape[data-overlay-shape-id="e2e_shape_1"]');
  await expect(liveShape).toBeVisible();
  await expect(liveShape).toHaveClass(/ai-diff-before-shape/);
  await expect(liveShape).toHaveCSS("outline-width", "3px");
  await expect(liveShape).toHaveCSS("outline-style", "dashed");
  await expect(liveShape).toHaveCSS("animation-name", "ai-overlay-diff-before-phase");

  // The run has completed, but the touched shape remains locked until the
  // human resolves the proposal. Selection is allowed; moving it is not.
  const beforeSelectionBox = await liveShape.boundingBox();
  expect(beforeSelectionBox).not.toBeNull();
  // 本文モードでは未選択の図形が透過するので、明示操作で掴む。
  await grabShapeFromBody(page, liveShape);
  const lockedSelectedShape = page.locator('.overlay-shape.selected.ai-edit-locked-shape[data-overlay-shape-id="e2e_shape_1"]');
  await expect(lockedSelectedShape).toBeVisible();
  const beforeDragBox = await lockedSelectedShape.boundingBox();
  expect(beforeDragBox).not.toBeNull();
  await page.mouse.move(beforeDragBox!.x + beforeDragBox!.width / 2, beforeDragBox!.y + beforeDragBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDragBox!.x + beforeDragBox!.width / 2 + 80, beforeDragBox!.y + beforeDragBox!.height / 2 + 20);
  await page.mouse.up();
  const afterDragBox = await lockedSelectedShape.boundingBox();
  expect(afterDragBox).not.toBeNull();
  expect(Math.abs(afterDragBox!.x - beforeDragBox!.x)).toBeLessThan(1);
  expect(Math.abs(afterDragBox!.y - beforeDragBox!.y)).toBeLessThan(1);

  // The left task row has no redundant "提案あり" label. Clicking the row
  // jumps to the owning chat, where the AI summary is immediately followed by
  // the shape image and the same ×/○ decision controls.
  await page.locator(".ai-task-dock-toggle").click();
  const taskPanel = page.locator(".ai-task-dock");
  await expect(taskPanel).toBeVisible();
  await expect(taskPanel).not.toContainText("提案あり");
  await taskPanel.locator(".ai-task-dock-row-label").first().click();
  const sidebar = page.locator('.ai-sidebar-panel:not(.is-hidden)');
  await expect(sidebar).toBeVisible();
  const sidebarProposal = sidebar.locator(".ai-chat-result-proposal");
  await expect(sidebarProposal).toBeVisible();
  // The pending-decision widget now shows the same GitHub風 diff as an applied change
  // (提案された変更), with the new shape rendered in its shapes section.
  const diffShapes = sidebarProposal.locator(".ai-chat-result-proposal-diff svg");
  await expect(diffShapes).toHaveCount(2);
  await expect(diffShapes.first()).toBeVisible();
  await expect(diffShapes.last()).toBeVisible();
  const sidebarDismiss = sidebarProposal.getByRole("button", { name: "破棄" });
  const sidebarApply = sidebarProposal.getByRole("button", { name: "適用" });
  await expect(sidebarDismiss).toHaveCSS("color", "rgb(85, 85, 85)");
  await expect(sidebarApply).toHaveCSS("color", "rgb(255, 255, 255)");

  // Applying from the sidebar resolves every mirrored proposal surface.
  await sidebarApply.click();
  await expect(approvalWidget).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes
      ?.find((shape: { id?: string }) => shape.id === "e2e_shape_1")?.x ?? null;
  })).toBe(160);
});

test("a shape proposal keeps its alternating before/after diff after selecting the target", async ({ page }) => {
  await setup(page);
  await startShapeRun(page, "e2e_shape_1", "PROPOSAL SHAPE 図形を右に移動して");

  await expect(page.locator(".ai-overlay-approval-widget")).toBeVisible({ timeout: 20_000 });
  const selectedShape = page.locator('.overlay-shape.selected.ai-edit-locked-shape[data-overlay-shape-id="e2e_shape_1"]');
  const ghostShape = page.locator('.overlay-shape.ai-diff-ghost-shape[data-overlay-shape-id="e2e_shape_1"]');
  // Starting from a selected target keeps the live interactive canvas mounted.
  // The same before/after diff must remain visible on that surface.
  await expect(selectedShape).toHaveCount(1);
  await expect(selectedShape).toHaveClass(/ai-diff-modified-shape/);
  await expect(selectedShape).toHaveClass(/ai-diff-before-shape/);
  await expect(selectedShape).toHaveCSS("outline-width", "3px");
  await expect(ghostShape).toHaveCount(1);
  await expect(ghostShape).toHaveClass(/ai-diff-after-shape/);
  await expect(ghostShape).toHaveCSS("outline-width", "3px");
  await expect(selectedShape).toHaveCSS("animation-name", "ai-overlay-diff-before-phase");
  await expect(ghostShape).toHaveCSS("animation-name", "ai-overlay-diff-after-phase");

  const beforeSelector = '.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="e2e_shape_1"]';
  const afterSelector = '.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="e2e_shape_1"]';
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "1", after: "0" });
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "0", after: "0.76" });
});

test("an inserted overlay shape keeps its approval widget out of body flow", async ({ page }) => {
  await setup(page);

  const pageFlow = page.locator(".page-flow");
  const bodyFlowHeightBefore = await pageFlow.evaluate((element) => element.scrollHeight);

  await startInlineRun(page, "para_a", "PROPOSAL SHAPE INSERT 図形を挿入して");

  const approvalWidget = page.locator(".ai-overlay-approval-widget");
  await expect(approvalWidget).toBeVisible({ timeout: 20_000 });
  await expect(approvalWidget).toContainText("AI図形の挿入案");
  await expect(approvalWidget.locator(".ai-proposal-provider-identity")).toHaveCount(0);
  await expect(page.locator(".ai-inline-preview-dialog")).toHaveCount(0);
  await expect(page.locator('.overlay-shape.ai-diff-added-shape.ai-diff-ghost-shape[data-overlay-shape-id="e2e_inserted_shape_1"]'))
    .toBeVisible();

  const floatingShapeArtifact = page.getByRole("figure", { name: "挿入する図形" });
  await expect(floatingShapeArtifact).toBeVisible();
  await expect(floatingShapeArtifact.locator("svg")).toBeVisible();

  const bodyFlowHeightAfter = await pageFlow.evaluate((element) => element.scrollHeight);
  expect(bodyFlowHeightAfter).toBe(bodyFlowHeightBefore);

  await page.locator(".ai-chat-host--inline").getByRole("button", { name: "サイドチャットで開く" }).click();
  const appliedChange = page.locator('.ai-edit-panel[data-variant="sidebar"]')
    .getByRole("region", { name: "適用した変更" });
  await expect(appliedChange).toHaveCount(0);
  await approvalWidget.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(approvalWidget).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes
      ?.some((shape: { id?: string }) => shape.id === "e2e_inserted_shape_1") ?? false;
  })).toBe(true);
  await expect(appliedChange).toBeVisible();
  await expect(appliedChange).toContainText("+1図形");
});

test("a deleted overlay shape stays visible with the red removal treatment until approval", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL SHAPE DELETE 図形を削除して");

  const approvalWidget = page.locator(".ai-overlay-approval-widget");
  await expect(approvalWidget).toBeVisible({ timeout: 20_000 });
  await expect(approvalWidget).toContainText("AI図形の削除案");
  await expect(approvalWidget.locator(".ai-proposal-provider-identity")).toHaveCount(0);
  await expect(page.locator(".ai-inline-preview-dialog")).toHaveCount(0);

  const removedShape = page.locator(
    '.overlay-shape.ai-diff-removed-shape[data-overlay-shape-id="e2e_shape_1"]',
  );
  await expect(removedShape).toBeVisible();
  await expect(removedShape).toHaveCSS("outline-style", "dashed");
  await expect(removedShape).toHaveCSS("outline-color", /(?:rgb|color)\(/);
  const inlineResultClose = page.locator(".ai-chat-host--inline").getByRole("button", { name: "閉じる" });
  if (await inlineResultClose.count()) {
    await inlineResultClose.first().click();
    await expect(inlineResultClose).toBeHidden();
  }
  await approvalWidget.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click();
  await expect(approvalWidget).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes
      ?.some((shape: { id?: string }) => shape.id === "e2e_shape_1") ?? false;
  })).toBe(false);
});

test("a same-run shape deletion and insertion share one replacement approval at the old placement", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL SHAPE REPLACE 図形を置き換えて");

  const approvalWidget = page.locator(".ai-overlay-approval-widget");
  await expect(approvalWidget).toHaveCount(1);
  await expect(approvalWidget).toBeVisible({ timeout: 20_000 });
  await expect(approvalWidget).toContainText("AI図形の置き換え案");
  await expect(approvalWidget).not.toHaveAttribute("data-proposal-ids");

  const removedShape = page.locator(
    '.overlay-shape.ai-diff-removed-shape[data-overlay-shape-id="e2e_shape_1"]',
  );
  const replacementGhost = page.locator(
    '.overlay-shape.ai-diff-added-shape.ai-diff-ghost-shape[data-overlay-shape-id="e2e_shape_1"]',
  );
  await expect(removedShape).toBeVisible();
  await expect(replacementGhost).toBeVisible();
  const [removedBox, replacementBox] = await Promise.all([
    removedShape.boundingBox(),
    replacementGhost.boundingBox(),
  ]);
  expect(removedBox).not.toBeNull();
  expect(replacementBox).not.toBeNull();
  expect(Math.abs(removedBox!.x - replacementBox!.x)).toBeLessThan(1);
  expect(Math.abs(removedBox!.y - replacementBox!.y)).toBeLessThan(1);

  const beforeSelector = '.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="e2e_shape_1"]';
  const afterSelector = '.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="e2e_shape_1"]';
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "1", after: "0" });
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "0", after: "0.76" });
});

test("a background shape replacement alternates across separate overlay layers", async ({ page }) => {
  await setup(page, createBackgroundShapeDocument());

  await startInlineRun(page, "para_a", "PROPOSAL SHAPE REPLACE 背景図形を置き換えて");

  await expect(page.locator(".ai-overlay-approval-widget")).toBeVisible({ timeout: 20_000 });
  const beforeSelector = '.page-overlay-background-layer .overlay-shape.ai-diff-before-shape[data-overlay-shape-id="e2e_shape_1"]';
  const afterSelector = '.page-overlay-layer .overlay-shape.ai-diff-after-shape[data-overlay-shape-id="e2e_shape_1"]';
  await expect(page.locator(beforeSelector)).toHaveCount(1);
  await expect(page.locator(afterSelector)).toHaveCount(1);
  await expect(page.locator(beforeSelector)).toHaveCSS("animation-name", "ai-overlay-diff-before-phase");
  await expect(page.locator(afterSelector)).toHaveCSS("animation-name", "ai-overlay-diff-after-phase");
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "1", after: "0" });
  await expect.poll(() => readAiDiffOpacity(page, beforeSelector, afterSelector))
    .toEqual({ before: "0", after: "0.76" });
});

test("a plain replace proposal uses color-only diff treatment without symbol markers", async ({ page }) => {
  await setup(page);

  await startInlineRun(page, "para_a", "PROPOSAL この段落を書き換えて");

  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });
  await expect(previewDialog.locator(".ai-inline-preview-diff-added")).toHaveCount(1);
  await expect(previewDialog.locator(".ai-inline-preview-diff-removed")).toHaveCount(0);
  await expect(previewDialog.locator(".ai-inline-preview-diff-marker")).toHaveCount(0);
});

test("an AI proposal reserves only its own target, leaving the rest of the body editable", async ({ page }) => {
  await setup(page);

  const unrelatedParagraph = page.locator(
    '.text-flow-editor [data-sigma-doc-id="para_pad_0"]',
  ).first();
  const targetParagraph = page.locator('.text-flow-editor [data-sigma-doc-id="para_a"]').first();
  const originalText = await unrelatedParagraph.textContent();
  expect(originalText).not.toBeNull();

  await startInlineRun(page, "para_a", "PROPOSAL この段落を書き換えて");

  // The run owns para_a from the moment it starts. Proposal applicability is
  // checked per block by content hash at approval time, so an unrelated
  // paragraph is never reserved -- editing it here must not be refused.
  await expect(targetParagraph).toHaveClass(/ai-edit-locked-block/, { timeout: 1_500 });
  await expect(unrelatedParagraph).not.toHaveClass(/ai-edit-locked-block/);
  await expect(unrelatedParagraph).not.toHaveClass(/ai-edit-readonly-block/);
  await expect(unrelatedParagraph.locator(".ai-edit-lock-char, .ai-edit-lock-atom")).toHaveCount(0);
  await expect(unrelatedParagraph).not.toHaveAttribute("contenteditable", "false");

  // The inline composer keeps its click-away catcher up while the run streams.
  // Dismissing it does not cancel the run (the in-body widget stays); it just
  // gets the ⌘K field out of the way, exactly as clicking away normally does.
  await page.locator(".ai-inline-catcher").click({ force: true });
  await expect(page.locator(".ai-inline-catcher")).toHaveCount(0);

  await unrelatedParagraph.click();
  await page.keyboard.insertText("実行中の追記");
  await expect(unrelatedParagraph).toContainText("実行中の追記");

  const previewDialog = page.locator(".ai-inline-preview-dialog");
  await expect(previewDialog).toBeVisible({ timeout: 20_000 });

  // Once the proposal is pending, its own target is read-only (without a stop
  // button, since there is no run left to stop) while the rest still is not.
  await expect(targetParagraph).toHaveClass(/ai-edit-readonly-block/);
  await expect(unrelatedParagraph).not.toHaveClass(/ai-edit-readonly-block/);
  await unrelatedParagraph.click();
  await page.keyboard.insertText("確認待ち中の追記");
  await expect(unrelatedParagraph).toContainText("確認待ち中の追記");

  await expect(page.locator(".ai-inline-catcher")).toHaveCount(0);
  await previewDialog.locator('.ai-inline-preview-action.apply[aria-label="適用"]').click({ force: true });
  await expect(previewDialog).toBeHidden();
  await expect(targetParagraph).not.toHaveClass(/ai-edit-readonly-block/);

  // The human edits made alongside the run survive the approval write, which
  // replays the draft onto the current document rather than the run's base.
  await expect(unrelatedParagraph).toContainText("実行中の追記");
  await expect(unrelatedParagraph).toContainText("確認待ち中の追記");
});

for (const kind of ["SVG", "SHAPE", "PROBLEM"]) {
  test(`inline ${kind} insertion can be approved without opening the sidebar`, async ({ page }) => {
    await setup(page);
    await startInlineRun(page, "para_a", kind === "PROBLEM"
      ? "PROPOSAL PROBLEM 問題を挿入して"
      : `PROPOSAL SHAPE INSERT ${kind} 挿入して`);
    const inline = page.locator('.ai-chat-host--inline .ai-inline-result');
    const apply = inline.getByRole("button", { name: "適用", exact: true });
    await expect(apply).toBeVisible({ timeout: 20_000 });
    await expect(inline.getByRole("button", { name: "破棄", exact: true })).toBeVisible();
    await expect(page.locator('.ai-chat-host--sidebar')).toHaveCount(0);
    await apply.click();
    await expect(apply).toBeHidden();
    await expect.poll(async () => page.evaluate((isProblem) => {
      const saved = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null");
      return isProblem
        ? saved?.content.some((block: { id: string }) => block.id === "e2e_problem_1")
        : saved?.pageLayout?.overlay?.overlaySnapshot?.shapes.some((shape: { id: string }) => shape.id === "e2e_inserted_shape_1");
    }, kind === "PROBLEM")).toBe(true);
    if (kind !== "PROBLEM") {
      await expect(page.locator('.overlay-shape[data-overlay-shape-id="e2e_inserted_shape_1"]:not(.ai-diff-ghost-shape)')).toBeVisible();
    }
  });
}
