import { createCanvas } from "@napi-rs/canvas";
import { expect, test } from "@playwright/test";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { grabShapeFromBody } from "./body-overlay-entry";

function image(color: string, id: string, width = 120, height = 80) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(0, 0, width, height);
  const bytes = canvas.toBuffer("image/png");
  return { id, name: "生成画像", width, height, mimeType: "image/png", fileSize: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

test("discarding a generated image replacement preserves the saved original", async ({ page }) => {
  page.setDefaultTimeout(10_000);
  const data = fixture(false, true);
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, data.document, { ai: { enabled: true, generatedImageFixture: {
    draft: data.draft.draft, changedIds: data.draft.changedIds,
    imageId: data.generatedImage.id, dataUrl: data.generatedImage.dataUrl,
    previewDataUrl: image("red", "thumb", 60, 40).dataUrl,
  } } });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await grabShapeFromBody(page, page.locator(`[data-overlay-shape-id="${data.shapeId}"]`).first());
  await page.locator('.selection-action-popover button[aria-label="AIに追加"]').click();
  const composer = page.locator(".ai-chat-composer--inline");
  await composer.locator("textarea").fill("PROPOSAL SHAPE 画像を編集して");
  await composer.locator(".ai-chat-send-button").click();
  await expect(page.locator(".ai-activity-item-image-thumb").last()).toBeVisible();
  const discard = page.locator(".ai-inline-result").getByRole("button", { name: "破棄", exact: true }).first();
  await discard.click();
  await expect(discard).toBeHidden();
  const saved = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document"));
  expect(saved).toContain(data.originalImage.dataUrl);
  expect(saved).not.toContain(data.generatedImage.dataUrl);
  await expect(page.locator(`[data-overlay-shape-id="${data.shapeId}"] img`).first()).toHaveAttribute("src", data.originalImage.dataUrl);
});

function fixture(whiteboard: boolean, replace: boolean) {
  const document: SigmaDocument = { version: "2.0", docId: "generated-image-e2e", metadata: { title: "画像生成テスト" },
    content: whiteboard ? [] : [
      { id: "p_image", type: "paragraph", children: [{ type: "text", text: "この問題に使う挿絵を作ります。" }] },
      { id: "p_after", type: "paragraph", children: [{ type: "text", text: "次の問題です。" }] },
    ],
    pageLayout: getDefaultPageLayout(whiteboard ? "whiteboard" : "A4"),
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const originalImage = image("blue", "a".repeat(64));
  const generatedImage = image("red", "b".repeat(64), 240, 160);
  const shapeId = `ai_generated_${originalImage.id}`;
  const assetId = "original_asset";
  const shape = { id: shapeId, type: "image" as const, x: 80, y: 80, rotation: 0,
    ...(whiteboard ? {} : { anchor: { type: "block" as const, blockId: "p_image", dx: 80, dy: 80 } }),
    props: { assetId, w: 120, h: 80 },
  };
  const asset = (id: string, value: typeof originalImage) => ({ id, type: "image" as const,
    props: { src: value.dataUrl, w: value.width, h: value.height, name: value.name, mimeType: value.mimeType, fileSize: value.fileSize, isAnimated: false },
  });
  document.pageLayout!.overlay = { overlaySnapshot: { version: 1, shapes: [shape], assets: { [assetId]: asset(assetId, originalImage) } } };
  const newAssetId = "generated_asset";
  const finalShapeId = replace ? shapeId : `ai_generated_${generatedImage.id}`;
  const assets = { [newAssetId]: asset(newAssetId, generatedImage) };
  const draft: AiEditSessionDraft = { summary: "生成画像の編集案", plan: [], warnings: [],
    operations: replace ? [] : [{ operation: "insertOverlayShape", summary: "生成画像を挿入", targetId: whiteboard ? "CANVAS" : "p_image",
      overlayShape: { ...shape, id: finalShapeId, x: 260, y: 160,
        ...(whiteboard ? {} : { anchor: { type: "block", blockId: "p_image", dx: 260, dy: 160 } }),
        props: { assetId: newAssetId, w: 180, h: 120 },
      }, assets,
    }],
    ...(replace ? { mutationOperations: [{ operation: "updateOverlayShape", summary: "画像を差し替え", shapeId, patch: { props: { assetId: newAssetId } }, assets }] } : {}),
  };
  return { document, shapeId, originalImage, generatedImage, draft: { draft, changedIds: [finalShapeId] } };
}

for (const whiteboard of [false, true]) {
  for (const replace of [false, true]) {
    test(`${whiteboard ? "whiteboard" : "paper"}: generated image ${replace ? "replacement" : "insertion"} previews, approves, undoes and reloads`, async ({ page, context }) => {
      test.setTimeout(90_000);
      page.setDefaultTimeout(10_000);
      const data = fixture(whiteboard, replace);
      await page.setViewportSize({ width: 1500, height: 950 });
      await installDesktopRuntimeMock(page, data.document, { ai: { enabled: true, generatedImageFixture: {
        draft: data.draft.draft, changedIds: data.draft.changedIds,
        imageId: data.generatedImage.id, dataUrl: data.generatedImage.dataUrl,
        previewDataUrl: image("red", "thumb", 60, 40).dataUrl,
      } } });
      await page.goto("/");
      await expect(page.locator(".startup-splash")).toBeHidden();
      const originalShape = page.locator(`[data-overlay-shape-id="${data.shapeId}"]`).first();
      await expect(originalShape).toBeVisible();
      if (whiteboard) await originalShape.click();
      else await grabShapeFromBody(page, originalShape);
      await page.locator('.selection-action-popover button[aria-label="AIに追加"]').click();
      const composer = page.locator(".ai-chat-composer--inline");
      await composer.locator("textarea").fill("PROPOSAL SHAPE 画像を生成して教材に使って");
      await composer.locator(".ai-chat-send-button").click();
      await expect(page.locator(".ai-inline-summary")).toBeVisible();

      // Generated images are visible without manually expanding the activity log.
      const thumbnail = page.locator(".ai-activity-item-image-thumb").last();
      await expect(thumbnail).toBeVisible();
      await thumbnail.click();
      await expect(page.locator(".ai-activity-image-lightbox img")).toHaveAttribute("src", data.generatedImage.dataUrl);
      await page.locator(".ai-activity-image-lightbox").click();
      const approval = page.locator('.ai-inline-result').getByRole("button", { name: "適用", exact: true }).first();
      await expect(approval).toBeVisible();
      await approval.click();
      await expect(approval).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document"))).toContain(data.generatedImage.dataUrl);
      const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
      const snapshot = normalizeOverlaySnapshot(saved.pageLayout?.overlay?.overlaySnapshot);
      const expectedCount = replace ? 1 : 2;
      expect(snapshot.shapes.filter((shape) => shape.type === "image")).toHaveLength(expectedCount);
      const finalShapeId = replace ? data.shapeId : `ai_generated_${data.generatedImage.id}`;
      const renderedImage = page.locator(`[data-overlay-shape-id="${finalShapeId}"] img`).first();
      await expect(renderedImage).toHaveAttribute("src", data.generatedImage.dataUrl);

      // Keyboard Undo goes through the canonical host history after applying the proposal.
      // Saving the new image precedes releasing the approval's document write guard.
      await expect(page.locator(".ai-edit-readonly-block")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.locator(".page-canvas").first().click({ position: { x: 400, y: 400 } });
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => {
        const current = await page.evaluate(() => JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
        const undone = normalizeOverlaySnapshot(current.pageLayout?.overlay?.overlaySnapshot);
        return undone.shapes.map((shape) => ({ id: shape.id, type: shape.type, props: shape.props,
          source: shape.type === "image" ? undone.assets[shape.props.assetId]?.props.src : undefined,
        }));
      }).toEqual([{ id: data.shapeId, type: "image", props: { assetId: "original_asset", w: 120, h: 80 }, source: data.originalImage.dataUrl }]);

      // Fresh renderer reads the exact persisted result; MCP tests separately exercise real disk I/O.
      const reopened = await context.newPage();
      await installDesktopRuntimeMock(reopened, saved);
      await reopened.goto("/");
      await expect(reopened.locator(`[data-overlay-shape-id="${finalShapeId}"] img`).first()).toHaveAttribute("src", data.generatedImage.dataUrl);
      await reopened.close();
    });
  }
}
