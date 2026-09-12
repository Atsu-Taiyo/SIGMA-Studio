import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * CSP は `<meta http-equiv>` で静的 export に焼き込まれるので、**ビルド成果物 (`out/`) を
 * 配って回さないと存在しない**。既定の e2e は `next dev` を叩くため meta が出ておらず、
 * ここが緑でも何も測れていないことになる。そのため実行系は
 * `npm run test:e2e:export -- tests/e2e/csp-violations.spec.ts`。
 *
 * 併せて「CSP が実際に載っていること」自体を assert して、dev サーバに向けて走らせたときに
 * 自明に緑にならないようにしてある。
 */

const CSP_E2E_DOCUMENT: SigmaDocument = {
  ...sampleDocument,
  docId: "doc_e2e_csp",
  metadata: { ...sampleDocument.metadata, title: "CSP 検証" },
};

/** ブラウザが CSP 違反として報告したものだけを拾う (通常の console.error と混ぜない)。 */
function collectViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy/i.test(text)) {
      violations.push(text);
    }
  });
  page.on("pageerror", (error) => {
    if (/content security policy/i.test(error.message)) {
      violations.push(error.message);
    }
  });
  return violations;
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL
    ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString()
    : path;
}

// CSP は静的 export にしか焼き込まれない。既定の `npm run test:e2e` は `next dev` を叩くので、
// この spec はそこでは意味を持たない (そして必ず落ちる)。専用の実行系でだけ走らせる。
test.skip(
  !process.env.SIGMA_STUDIO_E2E_BASE_URL,
  "静的 export を配って実行する必要があります (npm run test:e2e:export)",
);

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, CSP_E2E_DOCUMENT);
});

test("the built renderer actually carries the policy", async ({ page }) => {
  // これが無いと、meta の出ない dev サーバに向けて走らせたときに violation 0 件で緑になる。
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");

  expect(policy, "静的 export を配って実行しているか (npm run test:e2e:export)").toBeTruthy();
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("img-src 'self' data: blob:");
  // `style-src` は防御ではなく、`default-src` のフォールバックでインライン style が
  // 全面ブロックされるのを避けるために必須 (content-security-policy.ts のコメント参照)。
  expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  expect(policy).toContain("script-src-attr 'none'");
  expect(policy).not.toContain("unsafe-eval");
});

test("renders the document, math, shapes, and tables with no CSP violation", async ({ page }) => {
  const violations = collectViolations(page);

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  // 紙面が実際に組まれていること。CSP でスクリプトやスタイルが落ちればここに到達しない。
  await expect(page.locator(".a4-page-sheet").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".math-preview").first()).toBeVisible({ timeout: 30_000 });

  expect(violations, violations.join("\n")).toEqual([]);
});

test("renders the print surface with no CSP violation", async ({ page }) => {
  const violations = collectViolations(page);

  await page.goto(appUrl("/print?fileId=file_e2e_document&profile=teacher"), { waitUntil: "domcontentloaded" });

  // 紙面が実際に組まれたことを積極的に確かめる。空表示でも violation 0 件になってしまうので、
  // これが無いと「何も描いていないから違反も無い」を緑と読んでしまう。
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1, { timeout: 30_000 });

  expect(violations, violations.join("\n")).toEqual([]);
});

test("blocks an external image the document tried to load", async ({ page }) => {
  // `img-src 'self' data: blob:` の実利。教材を開いただけで攻撃者のサーバへ通知が飛ぶ
  // (開封通知・IP 漏洩) 経路を塞ぐ。
  const violations = collectViolations(page);
  let externalRequested = false;
  await page.route("https://example.invalid/**", (route) => {
    externalRequested = true;
    return route.abort();
  });

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await page.evaluate(() => {
    const image = document.createElement("img");
    image.src = "https://example.invalid/beacon.png";
    document.body.appendChild(image);
  });
  await page.waitForTimeout(500);

  expect(externalRequested, "外部 URL 画像がネットワークまで到達してはいけない").toBe(false);
  expect(violations.some((entry) => /img-src/i.test(entry)), violations.join("\n")).toBe(true);
});
