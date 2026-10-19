import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { ensurePageLayout, type SigmaBlock, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL ?? process.env.SIGMA_STUDIO_E2E_BASE_URL;
const DDOT = String.raw`\ddot{s}a`;

/**
 * 囲み文字の続き (#209)。
 *
 * - 角丸・網かけで囲んだ「文字 + 数式」は、細線と同じく 1 本の枠になる。以前は端の余白を外側の印に
 *   付けていたので文字と数式の間が空き、枠が 2 つの角丸に割れていた。
 * - 選択バーから開いた囲み文字のメニューは、種類を替えても開いたまま (選択も外れない)。
 * - 囲んだ数式を選んで編集に入っても、数式は通常表示と同じ位置に描かれる (左上へずれない)。
 */
test("boxed runs join, the selection bar's box menu stays open, and an opened boxed formula stays put", async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-boxed-joins-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (DEV_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = DEV_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    const formula = (id: string, extra: Record<string, unknown> = {}) => ({ type: "mathInline", id, tex: DDOT, display: "inline", ...extra });
    const content = [
      { type: "paragraph", id: "p_oval", children: [
        { type: "text", text: "すなわち", marks: ["boxed"], boxedVariant: "oval" },
        formula("m_oval", { marks: ["boxed"], boxedVariant: "oval" }),
      ] },
      { type: "paragraph", id: "p_shade", children: [
        { type: "text", text: "すなわち", marks: ["boxed"], boxedVariant: "shade" },
        formula("m_shade", { marks: ["boxed"], boxedVariant: "shade" }),
      ] },
      { type: "paragraph", id: "p_plain", children: [{ type: "text", text: "すなわち" }, formula("m_plain")] },
    ] as SigmaBlock[];
    const document = ensurePageLayout({
      version: "2.0", docId: "boxed-text-run-joins", metadata: { title: "囲み文字のつながり" }, content,
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    } as SigmaDocument);
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_oval"]').first()).toBeVisible();
    await page.evaluate(async () => { await window.document.fonts.ready; });

    // 角丸・網かけの「文字 + 数式」は 1 本の枠。文字と数式の segment は隙間なく並び、端だけ広く空ける。
    for (const id of ["p_oval", "p_shade"]) {
      await expect.poll(() => runGeometry(page, ".page-flow", id)).toMatchObject({ frames: 1, gap: 0 });
      const { endPadding, jointPadding } = await runGeometry(page, ".page-flow", id);
      expect(endPadding).toBeGreaterThan(jointPadding);
    }
    await zoomShot(page, "p_oval", testInfo.outputPath("oval-run.png"));

    // 選択バーの囲み文字メニューは、種類を替えても開いたまま。選択も外れず、上部ツールバーも使える。
    await page.locator('.page-flow [data-sigma-doc-id="p_plain"]').first().click({ clickCount: 3 });
    const bar = page.locator(".selection-action-popover").filter({ has: page.locator(".boxed-text-menu-trigger") });
    await bar.locator(".boxed-text-menu-trigger").click();
    const menu = page.locator(".boxed-text-menu").first();
    await expect(menu).toBeVisible();
    const fontSize = page.locator(".editor-menubar .toolbar-font-size-input");
    for (const name of ["太線", "角丸"]) {
      await menu.getByRole("button", { name, exact: true }).click();
      await expect(menu.getByRole("button", { name, exact: true })).toHaveClass(/applied/);
      await expect(menu).toBeVisible();
      await expect(fontSize).toBeEnabled();
    }
    await menu.getByRole("button", { name: "角の丸みを10%減らす" }).click();
    await expect(menu.locator('[data-boxed-text-stepper="roundness"] output')).toHaveText("90%");
    await expect(menu).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("selection-bar-menu.png") });
    await expect.poll(async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      const block = saved?.content.find((entry) => entry.id === "p_plain");
      return block?.type === "paragraph" ? block.children.map((child) => [child.type, child.boxedVariant, child.boxedRoundness]) : null;
    }).toEqual([["text", "oval", 90], ["mathInline", "oval", 90]]);
    // 閉じるのは ▾ をもう一度押したとき (またはメニューの外を押したとき)。
    await bar.locator(".boxed-text-menu-trigger").click();
    await expect(menu).toBeHidden();
    await expect.poll(() => runGeometry(page, ".page-flow", "p_plain")).toMatchObject({ frames: 1, gap: 0 });

    // 囲んだ数式を選んで編集に入っても、字形は通常表示と同じ位置 (囲みのない数式と同じ)。
    // 編集中も通常表示は寸法を持ったまま隠れているので、同じ瞬間に両方を測って比べる。
    for (const id of ["m_oval", "m_shade", "m_plain"]) {
      const node = page.locator(`.page-flow [data-id="${id}"]`).first();
      await node.click();
      await expect(node).toHaveClass(/editing/);
      await expect.poll(() => glyphRects(page, id).then(({ field }) => field.length)).toBe(2);
      const { preview, field } = await glyphRects(page, id);
      expect(preview).toHaveLength(2);
      field.forEach((rect, index) => {
        expect(Math.abs(rect.x - preview[index].x), `${id} glyph ${index} x`).toBeLessThan(0.5);
        expect(Math.abs(rect.y - preview[index].y), `${id} glyph ${index} y`).toBeLessThan(0.5);
      });
      await page.keyboard.press("Escape");
      await expect(node).not.toHaveClass(/editing/);
    }

    // 印刷 (PageCanvas の出力) でも同じ 1 本の枠。
    const printUrl = new URL(page.url());
    printUrl.pathname = printUrl.protocol === "file:" ? printUrl.pathname.replace(/index\.html$/, "print.html") : "/print";
    printUrl.search = new URLSearchParams({ fileId, profile: "teacher" }).toString();
    await page.goto(printUrl.href);
    await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    for (const id of ["p_oval", "p_shade", "p_plain"]) {
      await expect.poll(() => runGeometry(page, ".paged-surface-page", id)).toMatchObject({ frames: 1, gap: 0 });
    }
    writeFileSync(testInfo.outputPath("print.png"), await page.locator(".paged-surface-page").first().screenshot());
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** How many frames a run is drawn with, the gap between its segments, and its end/joint padding (px). */
function runGeometry(page: Page, surface: string, blockId: string) {
  return page.evaluate(([root, id]) => {
    const block = window.document.querySelector(`${root} [data-sigma-doc-id="${id}"]`);
    const segments = Array.from(block?.querySelectorAll<HTMLElement>('[data-boxed-run-height-target="true"]') ?? []);
    const [first, second] = segments.map((segment) => segment.getBoundingClientRect());
    const style = segments[0] ? getComputedStyle(segments[0]) : null;
    return {
      frames: block?.querySelectorAll(".boxed-run-frame").length ?? 0,
      gap: first && second ? Math.round(Math.abs(second.left - first.right)) : -1,
      endPadding: Number.parseFloat(style?.paddingLeft ?? "NaN"),
      jointPadding: Number.parseFloat(style?.paddingRight ?? "NaN"),
    };
  }, [surface, blockId] as const);
}

/** Where the letters of `\ddot{s}a` are drawn by the (hidden) static preview and by the MathLive field. */
function glyphRects(page: Page, mathId: string) {
  return page.evaluate((id) => {
    const node = window.document.querySelector(`.page-flow [data-id="${id}"]`);
    const letters = (root: ParentNode | null | undefined) => Array.from(root?.querySelectorAll(".ML__latex *") ?? [])
      .filter((element) => element.children.length === 0 && /^[sa]$/.test(element.textContent ?? ""))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
      });
    return { preview: letters(node?.querySelector(".math-preview")), field: letters(node?.querySelector("math-field")?.shadowRoot) };
  }, mathId);
}

async function zoomShot(page: Page, blockId: string, file: string) {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
  const bounds = (await block.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: bounds.x, y: bounds.y - 4, width: Math.min(240, bounds.width), height: bounds.height + 8, scale: 4 },
  });
  writeFileSync(file, Buffer.from(data, "base64"));
  await cdp.detach();
}
