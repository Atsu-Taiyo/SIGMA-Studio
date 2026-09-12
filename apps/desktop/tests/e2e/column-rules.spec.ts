import { expect, test, type Page } from "@playwright/test";
import { getDefaultPageLayout, type ColumnRule, type LayoutSectionNode, type SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

const section = (id: string): LayoutSectionNode => ({
  type: "layoutSection", id,
  layout: { columnCount: 2, columnGapMm: 8, columnStartIds: [id + "_left", id + "_right"], columnWidths: [6000, 4000] },
  children: ["left", "right"].map(side => ({ type: "paragraph", id: id + "_" + side, children: [{ type: "text", text: side === "left" ? "左の本文" : "右の本文" }] })),
});

function seed(columnCount = 2): SigmaDocument {
  const layout = getDefaultPageLayout();
  return {
    version: "2.0", docId: "column_rules", metadata: { title: "段間の線" },
    pageLayout: { ...layout, flow: { ...layout.flow, columnCount } },
    content: [
      section("outside"),
      { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [section("inside")] },
      ...Array.from({ length: 100 }, (_, index) => ({
        type: "paragraph" as const, id: "body_" + index, children: [{ type: "text" as const, text: "ページ共通の線を確認する本文 " + index }],
      })),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}
async function saved(page: Page): Promise<SigmaDocument> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!));
}
function local(doc: SigmaDocument, id: "inside" | "outside"): LayoutSectionNode {
  const node = id === "outside" ? doc.content[0] : doc.content[1].type === "boxBlock" ? doc.content[1].blocks[0] : null;
  if (node?.type !== "layoutSection") throw new Error("missing columns");
  return node;
}
async function open(page: Page, doc = seed()) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, doc);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
}
async function openLocal(page: Page, id: string) {
  await page.locator(`.page-flow [data-sigma-doc-id="${id}_left"]`).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "段間の線", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "段間の線", exact: true })).toBeVisible();
}
async function chooseStyle(page: Page, style: string) {
  await page.getByRole("dialog").filter({ has: page.locator(".column-rule-controls") }).getByRole("button", { name: /^線種/ }).click();
  await page.getByRole("menuitemradio", { name: style, exact: true }).click();
}
async function ruleCss(page: Page, id: string) {
  return page.locator(`.page-flow [data-layout-section-id="${id}"] .column-rule-separator`).first().evaluate(element => {
    const style = getComputedStyle(element);
    return { style: style.borderLeftStyle, width: style.borderLeftWidth, color: style.borderLeftColor };
  });
}

test("page column rules apply to every page and remain separate from local settings", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
  await chooseStyle(page, "破線");
  const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
  await dialog.getByRole("button", { name: /^線幅/ }).click();
  await page.getByRole("menuitemradio", { name: "中", exact: true }).click();
  await dialog.getByRole("button", { name: "線の色", exact: true }).click();
  await page.getByRole("option", { name: /#3b6ef7/i }).click();
  await dialog.locator("#page-settings-columns").scrollIntoViewIfNeeded();
  await page.mouse.move(1200, 100);
  await page.screenshot({ path: "test-results/column-rule-page-settings.png" });
  await dialog.getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => (await saved(page)).pageLayout?.flow.columnRule).toEqual({ style: "dashed", widthPx: 2, color: "#3b6ef7" });
  await expect.poll(() => page.locator(".page-column-rules").count()).toBeGreaterThan(1);
  const rules = await page.locator(".page-column-rules > span").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderLeftStyle));
  expect(rules.every(style => style === "dashed")).toBe(true);
  expect(local(await saved(page), "inside").layout.columnRule).toBeUndefined();
  expect(local(await saved(page), "outside").layout.columnRule).toBeUndefined();
  const doc = await saved(page);
  await installDesktopRuntimeMock(page, doc);
  await page.reload();
  await expect(page.locator(".page-column-rules > span").first()).toHaveCSS("border-left-color", "rgb(59, 110, 247)");
});

test("local rules share controls inside and outside boxes and survive typing, undo and reload", async ({ page }) => {
  await open(page, seed(1));
  for (const [id, style, expected] of [["inside", "二重線", "double"], ["outside", "点線", "dotted"]] as const) {
    await openLocal(page, id);
    await chooseStyle(page, style);
    await page.screenshot({ path: `test-results/column-rule-${id}-settings.png` });
    await page.getByRole("dialog", { name: "段間の線", exact: true }).getByRole("button", { name: "適用", exact: true }).click();
    await expect.poll(async () => local(await saved(page), id).layout.columnRule?.style).toBe(expected);
    await expect.poll(async () => (await ruleCss(page, id)).style).toBe(expected);
  }
  expect((await saved(page)).pageLayout?.flow.columnRule).toBeUndefined();
  await openLocal(page, "inside");
  await chooseStyle(page, "線なし");
  await page.getByRole("dialog", { name: "段間の線", exact: true }).getByRole("button", { name: "キャンセル", exact: true }).click();
  expect((await ruleCss(page, "inside")).style).toBe("double");

  const target = page.locator('.page-flow [data-sigma-doc-id="inside_left"]').first();
  await target.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("設定を保持");
  await expect.poll(async () => JSON.stringify(local(await saved(page), "inside"))).toContain("設定を保持");
  expect(local(await saved(page), "inside").layout.columnRule?.style).toBe("double");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(async () => JSON.stringify(local(await saved(page), "inside"))).not.toContain("設定を保持");
  expect(local(await saved(page), "inside").layout.columnRule?.style).toBe("double");
  await openLocal(page, "inside");
  await chooseStyle(page, "線なし");
  await page.getByRole("dialog", { name: "段間の線", exact: true }).getByRole("button", { name: "適用", exact: true }).click();
  await expect.poll(async () => local(await saved(page), "inside").layout.columnRule?.style).toBe("none");
  await expect(page.locator('.page-flow [data-layout-section-id="inside"] > .column-rule-separator')).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect.poll(async () => local(await saved(page), "inside").layout.columnRule?.style).toBe("double");
  await expect.poll(async () => (await ruleCss(page, "inside")).style).toBe("double");
  await installDesktopRuntimeMock(page, await saved(page));
  await page.reload();
  await expect.poll(async () => (await ruleCss(page, "inside")).style).toBe("double");
  await expect.poll(async () => (await ruleCss(page, "outside")).style).toBe("dotted");
});

test("configured page and local separators remain visible in the settled output surface", async ({ page }) => {
  const doc = seed();
  const rule: ColumnRule = { style: "solid", widthPx: 2, color: "#123456" };
  doc.pageLayout!.flow.columnRule = rule;
  local(doc, "inside").layout.columnRule = { ...rule, style: "double", widthPx: 3 };
  local(doc, "outside").layout.columnRule = { ...rule, style: "dashed" };
  await installDesktopRuntimeMock(page, doc);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher");
  await waitForPagedSurfaceSettled(page);
  await expect(page.locator(".page-column-rules > span").first()).toBeVisible();
  await expect(page.locator(".page-column-rules > span").first()).toHaveCSS("border-left-style", "solid");
  await expect.poll(async () => (await ruleCss(page, "inside")).style).toBe("double");
  await expect.poll(async () => (await ruleCss(page, "outside")).style).toBe("dashed");
});
