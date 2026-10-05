import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("link hover actions coexist with editing, QR insertion and the real browser IPC", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-link-actions-"));
  const source = path.join(profile, "links.sigma");
  await writeFile(source, JSON.stringify({
    version: "2.0", docId: "link-actions", metadata: { title: "Links" },
    content: [{ type: "paragraph", id: "link-body", children: [{ type: "text", text: "Read https://example.com/ for details." }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE"));
  env.SIGMA_STUDIO_USER_DATA_DIR = path.join(profile, "data");
  const app = await electron.launch({ args: [root, source], cwd: root, env });
  try {
    const page = await app.firstWindow();
    const link = page.locator(".url-detected").first();
    await expect(link).toContainText("https://example.com/", { timeout: 60_000 });
    // Capture only the final OS handoff; renderer, preload and main IPC are real.
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { openedLinks: string[] };
      state.openedLinks = [];
      shell.openExternal = async (url: string) => { state.openedLinks.push(url); };
    });
    const opened = () => app.evaluate(() => (globalThis as typeof globalThis & { openedLinks: string[] }).openedLinks);
    await link.click();
    expect(await opened()).toEqual([]);
    await link.hover();
    const card = page.locator(".url-link-card");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-action]")).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath("link-hover.png") });
    await card.locator('[data-action="browser"]').click();
    await expect.poll(opened).toEqual(["https://example.com/"]);
    await link.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await expect.poll(opened).toHaveLength(2);
    await link.hover();
    await card.locator('[data-action="sigma"]').click();
    await expect.poll(async () => page.evaluate(async () => (await window.desktopAPI!.browser!.getState()).snapshot.tabs.map(tab => tab.url))).toContain("https://example.com/");
    // Close the browser tab so the original paper stays fully visible for QR placement.
    await page.evaluate(async () => {
      for (const tab of (await window.desktopAPI!.browser!.getState()).snapshot.tabs) await window.desktopAPI!.browser!.closeTab(tab.id);
    });
    const before = await page.locator("image, img").count();
    await link.hover();
    await card.locator('[data-action="qr"]').click();
    await expect.poll(() => page.locator("image, img").count()).toBeGreaterThan(before);
    await page.reload();
    await expect(link).toContainText("https://example.com/");
    await expect.poll(() => page.locator("image, img").count()).toBeGreaterThan(before);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
