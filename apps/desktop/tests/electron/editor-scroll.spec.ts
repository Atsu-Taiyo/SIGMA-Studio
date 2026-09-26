import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

for (const edge of ["right", "bottom"] as const) test(`paper panes remain scrollable after nested ${edge} splits, resize, and reload`, async () => {
  test.setTimeout(90000);
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-scroll-"));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate(window => window.setContentSize(1400, 1100));
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    const source: SigmaDocument = {
      version: "2.0", docId: "scroll_probe", metadata: { title: "スクロール確認" },
      content: Array.from({length: 100}, (_, index) => ({type: "paragraph", id: `p${index}`, children: [{type: "text", text: `段落 ${index} スクロール検証本文です。` }]})),
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    source.content.splice(3, 0, { type: "codeBlock", id: "code", language: "javascript", children: [{type: "text", text: "const answer = 42;\n".repeat(8)}] });
    source.content.splice(7, 0, { type: "quote", id: "quote", blocks: [{type: "paragraph", id: "quoted", children: [{type: "text", text: "引用本文"}]}] });
    const { secondId, thirdId } = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({mode:"docs",onboardingCompleted:true}));
      const created = await window.desktopAPI!.storage.createFileFromDocument({document});
      const second = await window.desktopAPI!.storage.createFileFromDocument({document: {...document, docId: "scroll_second", metadata: {title: "スクロール確認2"}}});
      const third = await window.desktopAPI!.storage.createFileFromDocument({document: {...document, docId: "scroll_third", metadata: {title: "スクロール確認3"}}});
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      await window.desktopAPI!.storage.saveWorkspace({openFileIds:[created.file.fileId, second.file.fileId, third.file.fileId],activeFileId:created.file.fileId});
      return {secondId: second.file.fileId, thirdId: third.file.fileId};
    }, source);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const scroller=page.locator(".editor-canvas");
    const box=(await scroller.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    expect(await scroller.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(500);
    for(const id of ["p0","code","quoted"]) {
      await page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first().click();
      await page.keyboard.type(" test");
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      const before=await scroller.evaluate(e=>e.scrollTop);
      await page.mouse.wheel(0,600);
      await expect.poll(()=>scroller.evaluate(e=>e.scrollTop)).toBeGreaterThan(before+200);
      await page.waitForTimeout(600);
      const down=await scroller.evaluate(e=>e.scrollTop);
      await page.mouse.wheel(0,-500);
      await expect.poll(()=>scroller.evaluate(e=>e.scrollTop)).toBeLessThan(down-150);
    }
    // A split wrapper previously supplied a height, masking the single-pane bug.
    const tab = page.locator(`[data-tab-id="document:${secondId}"]`).getByRole("tab");
    const group = page.locator(".workspace-tab-group");
    const bounds = (await group.boundingBox())!;
    const point = edge === "right"
      ? {clientX: bounds.x + bounds.width - 12, clientY: bounds.y + bounds.height / 2}
      : {clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height - 12};
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await tab.dispatchEvent("dragstart", { dataTransfer });
    await group.dispatchEvent("dragover", { dataTransfer, ...point });
    await expect(group.locator(`.workspace-tab-drop-preview[data-edge="${edge}"]`)).toBeVisible();
    await group.dispatchEvent("drop", { dataTransfer, ...point });
    await tab.dispatchEvent("dragend", {dataTransfer});
    await expect(page.locator(".workspace-tab-group")).toHaveCount(2);
    for (const pane of await scroller.all()) {
      const paneBox = (await pane.boundingBox())!;
      expect(paneBox.y + paneBox.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
      await pane.evaluate(element => { element.scrollTop = 0; });
      await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
    }
    const thirdTab = page.locator(`[data-tab-id="document:${thirdId}"]`).getByRole("tab");
    const upper = page.locator(".workspace-tab-group").first();
    const upperBox = (await upper.boundingBox())!;
    const nestedPoint = edge === "right"
      ? {clientX: upperBox.x + upperBox.width - 12, clientY: upperBox.y + upperBox.height / 2}
      : {clientX: upperBox.x + upperBox.width / 2, clientY: upperBox.y + upperBox.height - 12};
    const nestedTransfer = await page.evaluateHandle(() => new DataTransfer());
    await thirdTab.dispatchEvent("dragstart", {dataTransfer: nestedTransfer});
    await upper.dispatchEvent("dragover", {dataTransfer: nestedTransfer, ...nestedPoint});
    await expect(upper.locator(`.workspace-tab-drop-preview[data-edge="${edge}"]`)).toBeVisible();
    await upper.dispatchEvent("drop", {dataTransfer: nestedTransfer, ...nestedPoint});
    await expect(page.locator(".workspace-tab-group")).toHaveCount(3);
    await mainWindow.evaluate(window => window.setContentSize(900, 600));
    await page.waitForFunction(() => innerHeight === 600);
    for (const pane of await scroller.all()) {
      await expect.poll(() => pane.evaluate(element => {
        const own = element.getBoundingClientRect();
        let ancestor = element.parentElement;
        while (ancestor) {
          if (getComputedStyle(ancestor).overflowY === "hidden" || ancestor.matches(".workspace-tab-split")) {
            const parent = ancestor.getBoundingClientRect();
            if (own.bottom > parent.bottom + 1 || own.top < parent.top - 1
              || own.right > parent.right + 1 || own.left < parent.left - 1) return false;
          }
          ancestor = ancestor.parentElement;
        }
        return own.bottom <= innerHeight;
      })).toBe(true);
      const paneBox = (await pane.boundingBox())!;
      await pane.evaluate(element => {element.scrollTop = 0;});
      await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(150);
    }
    await page.locator(`[data-tab-id="document:${thirdId}"] .document-tab-close`).click();
    await page.locator(`[data-tab-id="document:${secondId}"] .document-tab-close`).click();
    await expect(page.locator(".workspace-tab-group")).toHaveCount(1);
    await mainWindow.evaluate(window => window.setContentSize(900, 600));
    await page.waitForFunction(() => innerHeight === 600);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const resized = (await scroller.boundingBox())!;
    expect(resized.y + resized.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height / 2);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  } finally { await app.close(); await rm(profile,{recursive:true,force:true}); }
});
