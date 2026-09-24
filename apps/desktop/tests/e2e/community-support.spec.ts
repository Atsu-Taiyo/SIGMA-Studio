import { expect, test } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("Star invitation supports keyboard dismissal, returns on the next launch, and reports issues to GitHub", async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument);
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
  // No permanent opt-out: closing is the only other action.
  await expect(dialog.getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button")).toHaveAccessibleName("閉じる");
  await page.screenshot({ path: "test-results/github-star-dialog.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.clock.fastForward(70_000);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
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
