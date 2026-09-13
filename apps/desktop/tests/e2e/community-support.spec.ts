import { expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("Star invitation supports keyboard dismissal, persists it, and reports issues to GitHub", async ({ page }) => {
  const key = "sigma-studio:github-star-dismissed:v1";
  await installDesktopRuntimeMock(page, sampleDocument, { preserveStorageKeys: [key] });
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.clock.fastForward(70_000);
  const dialog = page.getByRole("dialog", { name: "GitHubのStarで応援しませんか？" });
  await expect(dialog).toBeVisible();
  const link = dialog.getByRole("link");
  await expect(link).toHaveAttribute("href", "https://github.com/Atsu-Taiyo/SIGMA-Studio");
  await link.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.screenshot({ path: "test-results/github-star-dialog.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe("1");
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.clock.fastForward(70_000);
  await expect(dialog).toBeHidden();
  const opened: string[] = [];
  await page.exposeFunction("recordCommunityUrl", (url: string) => opened.push(url));
  await page.evaluate(() => {
    window.open = (url) => {
      void (window as unknown as { recordCommunityUrl: (url: string) => Promise<void> }).recordCommunityUrl(String(url));
      return null;
    };
  });
  await page.getByRole("button", { name: "問題を報告", exact: true }).click();
  await expect.poll(() => opened).toEqual(["https://github.com/Atsu-Taiyo/SIGMA-Studio/issues/new?template=bug_report.yml"]);
});
