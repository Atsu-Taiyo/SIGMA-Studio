import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const LEVELS = ["h1", "h2", "h3"] as const;

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_heading_and_caret";
  document.metadata = { ...document.metadata, title: "見出しとキャレット E2E" };
  // 文字サイズを直接指定した段落。インラインの font-size は見出しレベルの CSS に
  // 必ず勝つので、変換時に落とさないと 3 段階が同じ大きさになる。
  document.content = LEVELS.map((level) => ({
    type: "paragraph" as const,
    id: `p_${level}`,
    children: [{ type: "text" as const, text: `${level} になる段落`, fontSize: 12 }],
  })) as SigmaDocument["content"];
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator('[data-sigma-doc-id="p_h1"]').first()).toBeVisible();
}

async function renderedFontSize(page: Page, blockId: string): Promise<number> {
  return page.evaluate((id) => {
    const block = document.querySelector(`[data-sigma-doc-id="${id}"]`) as HTMLElement | null;
    if (!block) return 0;
    // run が span を持てば実際に効いている値はそちら。
    const target = block.querySelector("span") ?? block;
    return Number.parseFloat(getComputedStyle(target as HTMLElement).fontSize);
  }, blockId);
}

test("見出し1/2/3は文字サイズを指定した段落から変換しても3段階になる", async ({ page }) => {
  await openEditor(page);

  for (const level of LEVELS) {
    const block = page.locator(`[data-sigma-doc-id="p_${level}"]`).first();
    const box = await block.boundingBox();
    if (!box) throw new Error(`p_${level} is not visible`);
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.getByLabel("段落スタイル").first().click();
    await page.getByRole("menu", { name: "段落スタイル" }).getByRole("menuitemradio", {
      name: level === "h1" ? "見出し 1" : level === "h2" ? "見出し 2" : "見出し 3",
      exact: true,
    }).click();
    await expect(page.locator(`${level}[data-sigma-doc-id="p_${level}"]`).first()).toBeVisible();
  }

  const sizes = await Promise.all(LEVELS.map((level) => renderedFontSize(page, `p_${level}`)));
  expect(new Set(sizes).size).toBe(3);
  expect(sizes[0]).toBeGreaterThan(sizes[1]);
  expect(sizes[1]).toBeGreaterThan(sizes[2]);
});

test("キャレットは行ボックスではなく文字の高さで描かれる", async ({ page }) => {
  await openEditor(page);

  // キャレットの高さは CSS ではなく「先頭フォントの ascent + descent」で決まる (実測)。
  // JS からキャレットそのものは測れないので、その値 = 先頭フェイスの `line-height: normal`
  // を測って本文の行ボックスと比べる。先頭に指標の外れたフェイスを置くと、ここが破れる。
  const metrics = await page.evaluate(() => {
    const editor = document.querySelector(".text-flow-editor") as HTMLElement;
    const style = getComputedStyle(editor);
    const primaryFamily = style.fontFamily.split(",")[0].trim();
    const probe = document.createElement("div");
    probe.style.cssText =
      `position:absolute;visibility:hidden;font-family:${primaryFamily};font-size:${style.fontSize};line-height:normal;`;
    probe.textContent = "あA";
    document.body.appendChild(probe);
    const caretBox = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      primaryFamily,
      caretBox: +caretBox.toFixed(2),
      lineBox: Number.parseFloat(style.lineHeight),
      fontSize: Number.parseFloat(style.fontSize),
    };
  });

  expect(metrics.caretBox).toBeLessThanOrEqual(metrics.lineBox);
  expect(metrics.caretBox).toBeLessThanOrEqual(metrics.fontSize * 1.6);
});
