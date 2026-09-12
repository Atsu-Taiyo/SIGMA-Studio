import { expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Regression cover for two callout (吹き出し) bugs fixed alongside PR #333's overlay text
 * overflow fix:
 *
 * 1. `handleTextChange` in `OverlayCanvasEditorClient.tsx` used to gate on `shape?.type !== "text"`,
 *    which silently dropped every edit made inside a callout's rich text editor: typing, bold,
 *    italic, and inline math all appeared live while editing but vanished the moment the editor
 *    lost focus (e.g. pressing Escape), because the shape's stored blocks were never updated.
 * 2. The DOM auto-size measurement loop (`text-shape-editor.tsx`) only ever measured `text` shapes
 *    with `autoSize` set, so a callout's saved `props.h` could drift out of sync with what was
 *    actually drawn on screen (which `getCalloutBodySize` already grows to fit content
 *    regardless of `props.h` -- see `overlay-text-overflow.spec.ts`).
 *
 * Both fixes are asserted against the *rendered* DOM (not just the saved document), because the
 * bug was specifically that the rendered/editing state and the persisted state diverged.
 */

const CALLOUT_ID = "shape_callout_rt";
// `[data-overlay-shape-id]` alone is ambiguous once the shape is selected: the block-anchor
// handle button (`.overlay-anchor-handle`) also carries the shape's id as a data attribute.
// Scoping to the shape wrapper's own class keeps every locator below a single-element match.
const CALLOUT_SELECTOR = `.overlay-shape-callout[data-overlay-shape-id="${CALLOUT_ID}"]`;

function calloutRichTextDocument(): SigmaDocument {
  const problem = sampleDocument.content.find((block) => block.type === "problem");
  if (!problem || problem.type !== "problem") {
    throw new Error("Overlay callout rich text E2E fixture requires the sample problem");
  }

  return {
    ...sampleDocument,
    content: [{ ...problem, lead: [], hints: [], solution: [] }],
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            {
              id: CALLOUT_ID,
              type: "callout",
              x: 60,
              y: 420,
              rotation: 0,
              props: {
                w: 180,
                h: 28,
                radius: 14,
                tail: {
                  baseStart: { x: 60, y: 28 },
                  baseEnd: { x: 100, y: 28 },
                  tip: { x: 40, y: 52 },
                },
                blocks: [{ type: "paragraph", id: "overlay_callout_rich_text_spec_45", children: [] }],
                color: "#111111",
                size: "m",
                dash: "solid",
                strokeWidth: "m",
              },
            },
          ],
        },
      },
    },
  } as SigmaDocument;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, calloutRichTextDocument());
});

interface SavedOverlayRichTextNode {
  type?: string;
  text?: string;
  marks?: string[];
  children?: SavedOverlayRichTextNode[];
}

interface SavedOverlayShape {
  id: string;
  props?: { h?: number; w?: number; blocks?: SavedOverlayRichTextNode[] };
}

function savedRichTextPlainText(node: SavedOverlayRichTextNode): string {
  return (node.text ?? "") + (node.children ?? []).map(savedRichTextPlainText).join("");
}

/**
 * Freshly loading a page renders every overlay shape through the *read-only* preview layer
 * (`PageCanvasEditor`'s `OverlayPreview` / `OverlayShapeReadOnlyView`, `aria-hidden`, wired to
 * `noopShapeDoubleClick`) until that page's overlay editing session is activated
 * (`pageOverlayEditing`). The first pointerdown on that preview hands off to a freshly-mounted
 * interactive `OverlayCanvasEditorClient` *synchronously* (`flushSync`), swapping the DOM under
 * the cursor mid-gesture -- so a single Playwright `.dblclick()` (which fires both physical
 * clicks from one cached target/position) can have its second click land on stale coordinates
 * from before the swap. Two separate `.click()` calls close together don't have this problem:
 * each one re-resolves the locator against whatever is *currently* mounted (preview, then the
 * live interactive shape), and Chromium still recognizes them as a native double-click purely
 * from their timing/position -- which is what actually drives `handleShapeDoubleClick`'s
 * `editText` transition.
 */
async function dblclickIntoCalloutBody(page: Page, callout: Locator): Promise<void> {
  const box = await callout.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width * 0.25, y: box!.y + box!.height * 0.35 };
  // 本文モードからは明示操作で掴んでから、もう一度押して本文編集に入る。
  await grabShapeFromBody(page, point);
  await page.mouse.click(point.x, point.y);
}

async function getSavedOverlayShapeById(page: Page, shapeId: string): Promise<SavedOverlayShape | null> {
  const shapes = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const doc = raw ? JSON.parse(raw) : null;
    const collectShapes = (value: unknown): SavedOverlayShape[] => {
      if (!value || typeof value !== "object") {
        return [];
      }
      if (Array.isArray((value as { shapes?: unknown }).shapes)) {
        return (value as { shapes: SavedOverlayShape[] }).shapes;
      }
      if (Array.isArray((value as { overlaySnapshot?: { shapes?: unknown } }).overlaySnapshot?.shapes)) {
        return (value as { overlaySnapshot: { shapes: SavedOverlayShape[] } }).overlaySnapshot.shapes;
      }
      return Object.values(value).flatMap(collectShapes);
    };
    return collectShapes(doc) as SavedOverlayShape[];
  });
  return shapes.find((shape) => shape.id === shapeId) ?? null;
}

test("keeps typed callout text after Escape instead of discarding it", async ({ page }) => {
  await page.goto("/");

  const callout = page.locator(CALLOUT_SELECTOR);
  await expect(callout).toBeVisible();
  await dblclickIntoCalloutBody(page, callout);

  const editorContent = callout.locator(".overlay-text-shape-content");
  await expect(editorContent).toBeFocused();
  await page.keyboard.type("係数を確認");
  await expect(editorContent).toContainText("係数を確認");

  await page.keyboard.press("Escape");

  // Before the fix, `handleTextChange` silently dropped every callout edit, so the shape's
  // The stored blocks never changed and this reverted to empty the instant editing ended.
  await expect(editorContent).toContainText("係数を確認");
  await expect.poll(async () => {
    const shape = await getSavedOverlayShapeById(page, CALLOUT_ID);
    return shape?.props?.blocks
      ? shape.props.blocks.map(savedRichTextPlainText).join("\n").trim()
      : null;
  }).toBe("係数を確認");
});

test("keeps bold/italic marks on callout text after Escape", async ({ page }) => {
  await page.goto("/");

  const callout = page.locator(CALLOUT_SELECTOR);
  await dblclickIntoCalloutBody(page, callout);

  const editorContent = callout.locator(".overlay-text-shape-content");
  await expect(editorContent).toBeFocused();
  await page.keyboard.type("強調");
  await page.keyboard.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "太字", exact: true }).click();
  await page.getByRole("button", { name: "斜体", exact: true }).click();
  await expect(editorContent.locator("strong")).toContainText("強調");
  await expect(editorContent.locator("em")).toContainText("強調");

  await page.keyboard.press("Escape");

  await expect(editorContent.locator("strong")).toContainText("強調");
  await expect(editorContent.locator("em")).toContainText("強調");
  await expect.poll(async () => {
    const shape = await getSavedOverlayShapeById(page, CALLOUT_ID);
    const marks = shape?.props?.blocks?.[0]?.children?.[0]?.marks ?? [];
    return [...marks].sort();
  }).toEqual(["bold", "italic"]);
});

test("keeps inline math inserted into a callout after Escape", async ({ page }) => {
  await page.goto("/");

  const callout = page.locator(CALLOUT_SELECTOR);
  await dblclickIntoCalloutBody(page, callout);

  const editorContent = callout.locator(".overlay-text-shape-content");
  await expect(editorContent).toBeFocused();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("sigma-studio:insert-inline-math", {
      detail: { target: "overlay", tex: "x^2+y^2", edit: false },
    }));
  });
  await expect(editorContent.locator(".inline-math-node")).toHaveCount(1);

  await page.keyboard.press("Escape");

  await expect(callout.locator("[data-sigma-doc-math-inline]")).toHaveCount(1);
  await expect.poll(async () => {
    const shape = await getSavedOverlayShapeById(page, CALLOUT_ID);
    const inline = shape?.props?.blocks?.find((block) =>
      (block.children ?? []).some((child) => child.type === "mathInline"));
    return Boolean(inline);
  }).toBe(true);
});

test("grows a callout's saved height to fit content while editing, and never shrinks it back", async ({ page }) => {
  await page.goto("/");

  const callout = page.locator(CALLOUT_SELECTOR);
  await dblclickIntoCalloutBody(page, callout);

  const editorContent = callout.locator(".overlay-text-shape-content");
  await expect(editorContent).toBeFocused();
  const frame = callout.locator(".overlay-callout-text-frame");

  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  const baselineHeight = (await frame.boundingBox())!.height;

  const longText = "この吹き出しの本文は保存されている高さよりもずっと長く、折り返して何行にもなる内容です。";
  await page.keyboard.type(longText);

  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0)
    .toBeGreaterThan(baselineHeight * 2);
  const grownHeight = (await frame.boundingBox())!.height;

  await expect.poll(async () => {
    const shape = await getSavedOverlayShapeById(page, CALLOUT_ID);
    return shape?.props?.h ?? 0;
  }).toBeGreaterThanOrEqual(grownHeight - 2);

  // Clearing the content back down to nothing must not shrink the box back: `props.h` is a
  // grow-only write-back (see `handleTextAutoSize`), so the saved (and drawn) height should
  // stay at least as tall as it grew to, even though the *content* is now a single short line.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => editorContent.evaluate((element) => (element.textContent ?? "").trim())).toBe("");

  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(grownHeight - 2);

  await page.keyboard.press("Escape");

  await expect.poll(async () => (await frame.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(grownHeight - 2);
  await expect.poll(async () => {
    const shape = await getSavedOverlayShapeById(page, CALLOUT_ID);
    return shape?.props?.h ?? 0;
  }).toBeGreaterThanOrEqual(grownHeight - 2);
});
