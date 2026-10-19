import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { ensurePageLayout, type SigmaBlock, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_DEV_SERVER_URL ?? process.env.SIGMA_STUDIO_E2E_BASE_URL;

/**
 * 囲み文字と下線を同じ文字に付ける。
 *
 * 囲みの区間は inline-flex で、外側の下線 (text-decoration) が中の文字へ伝わらず、囲んだ文字にだけ
 * 下線が出なかった。選択バーで「囲む→下線」「下線→囲む」のどちらの順でも、囲みの中に下線が出て、
 * 枠の下辺はその下線より下にあること (枠と重なって見えなくならない)。保存して開き直した後と、
 * 印刷 (PageCanvas の出力) でも同じ。
 */
test("boxed text keeps its underline visible inside the frame, in either order and after reload", async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!DEV_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-boxed-underline-"));
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
    const content = [
      { type: "paragraph", id: "p_box_first", children: [{ type: "text", text: "先に囲む" }] },
      { type: "paragraph", id: "p_underline_first", children: [{ type: "text", text: "先に下線" }] },
      { type: "paragraph", id: "p_box_only", children: [{ type: "text", text: "囲みだけ", marks: ["boxed"] }] },
    ] as SigmaBlock[];
    const document = ensurePageLayout({
      version: "2.0", docId: "boxed-text-underline", metadata: { title: "囲み文字と下線" }, content,
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
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_box_first"]').first()).toBeVisible();
    await page.evaluate(async () => { await window.document.fonts.ready; });

    const bar = page.locator(".selection-action-popover").filter({ has: page.locator(".boxed-text-menu-trigger") });
    const applyInOrder = async (blockId: string, labels: string[]) => {
      await page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first().click({ clickCount: 3 });
      for (const label of labels) {
        await bar.getByRole("button", { name: label, exact: true }).click();
      }
      // 両方が付いた状態は選択バーにも出る (押すと外す側の名前になる)。
      await expect(bar.getByRole("button", { name: "選択範囲の囲みを外す", exact: true })).toBeVisible();
      await expect(bar.getByRole("button", { name: "選択範囲の下線を解除", exact: true })).toBeVisible();
    };
    await applyInOrder("p_box_first", ["選択範囲を枠で囲む", "選択範囲に下線"]);
    await applyInOrder("p_underline_first", ["選択範囲に下線", "選択範囲を枠で囲む"]);

    await expect.poll(async () => {
      const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      return ["p_box_first", "p_underline_first"].map((id) => {
        const block = saved?.content.find((entry) => entry.id === id);
        return block?.type === "paragraph" ? block.children.map((child) => [...(child.marks ?? [])].sort()) : null;
      });
    }).toEqual([[["boxed", "underline"]], [["boxed", "underline"]]]);

    await expectUnderlinedFrames(page, ".page-flow");

    // 保存した文書を開き直しても同じ。
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="p_box_first"]').first()).toBeVisible();
    await page.evaluate(async () => { await window.document.fonts.ready; });
    await expectUnderlinedFrames(page, ".page-flow");
    await zoomShot(page, ".page-flow", testInfo.outputPath("editor.png"));

    const printUrl = new URL(page.url());
    printUrl.pathname = printUrl.protocol === "file:" ? printUrl.pathname.replace(/index\.html$/, "print.html") : "/print";
    printUrl.search = new URLSearchParams({ fileId, profile: "teacher" }).toString();
    await page.goto(printUrl.href);
    await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    await expectUnderlinedFrames(page, ".paged-surface-page");
    await zoomShot(page, ".paged-surface-page", testInfo.outputPath("print.png"));
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function expectUnderlinedFrames(page: Page, surface: string) {
  await expect.poll(() => frameGeometry(page, surface, "p_box_only")).toMatchObject({ frames: 1, underline: "none" });
  const plain = await frameGeometry(page, surface, "p_box_only");
  for (const id of ["p_box_first", "p_underline_first"]) {
    await expect.poll(() => frameGeometry(page, surface, id)).toMatchObject({ frames: 1, underline: "underline" });
    const underlined = await frameGeometry(page, surface, id);
    // 下線の分 (0.2em + 1px) だけ枠の下が伸び、上の余白は囲みだけの文字と同じ。
    expect(underlined.frameHeight - plain.frameHeight, id).toBeGreaterThanOrEqual(underlined.fontSize * 0.2);
    expect(underlined.paddingBottom - underlined.paddingTop, id).toBeGreaterThanOrEqual(underlined.fontSize * 0.2);
  }
}

/** The run's frame and its segment's underline and vertical padding (px). */
function frameGeometry(page: Page, surface: string, blockId: string) {
  return page.evaluate(([root, id]) => {
    const block = window.document.querySelector(`${root} [data-sigma-doc-id="${id}"]`);
    const segment = block?.querySelector<HTMLElement>('[data-boxed-run-height-target="true"]');
    const style = segment ? getComputedStyle(segment) : null;
    const frames = Array.from(block?.querySelectorAll(".boxed-run-frame") ?? []);
    // 印刷は枠を区間自身が描く (編集面は .boxed-run-frame の重ね描き)。
    const frame = (frames[0] ?? segment)?.getBoundingClientRect();
    return {
      frames: frames.length || (segment ? 1 : 0),
      underline: style?.textDecorationLine ?? "",
      frameHeight: frame?.height ?? 0,
      fontSize: Number.parseFloat(style?.fontSize ?? "NaN"),
      paddingTop: Number.parseFloat(style?.paddingTop ?? "NaN"),
      paddingBottom: Number.parseFloat(style?.paddingBottom ?? "NaN"),
    };
  }, [surface, blockId] as const);
}

async function zoomShot(page: Page, surface: string, file: string) {
  const first = page.locator(`${surface} [data-sigma-doc-id="p_box_first"]`).first();
  const last = page.locator(`${surface} [data-sigma-doc-id="p_box_only"]`).first();
  const top = (await first.boundingBox())!;
  const bottom = (await last.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: top.x, y: top.y - 4, width: 200, height: bottom.y + bottom.height - top.y + 8, scale: 3 },
  });
  writeFileSync(file, Buffer.from(data, "base64"));
  await cdp.detach();
}
