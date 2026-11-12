import type { Page } from "@playwright/test";

/** Dismiss the app's session invitations through its real UI when it blocks a test action. */
export async function handleSessionPrompts(page: Page): Promise<void> {
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: /^(GitHubのStarで応援しませんか？|Support Sigma Studio with a GitHub star|使い方を見てみませんか？|Need help getting started\?)$/ }),
    async (dialog) => { await dialog.getByRole("button", { name: /^(閉じる|Close)$/ }).click(); },
  );
}
