import { expect, test, type Page } from "@playwright/test";

import { normalizePageLayout } from "@/lib/page-layout";
import type { RichBlock, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

// Issue #283: TrailingNode 拡張により、ドキュメント末尾が paragraph でない場合に
// ID なしの空 paragraph が自動追加され、SigmaDocTextIdentity プラグインで新規 ID を割り当てられて
// 保存される問題。教材タブを開いて放置しただけでは空段落が増殖しないことを確認。

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
});

function paragraph(id: string, text: string): Extract<SigmaBlock | RichBlock, { type: "paragraph" }> {
  return {
    type: "paragraph",
    id,
    children: text ? [{ type: "text", text }] : [],
  };
}

function heading(id: string, text: string): Extract<SigmaBlock, { type: "heading" }> {
  return {
    type: "heading",
    id,
    level: 1,
    children: [{ type: "text", text }],
  };
}

function problem(id: string): Extract<SigmaBlock, { type: "problem" }> {
  return {
    type: "problem",
    id,
    tags: [],
    lead: [],
    prompt: [paragraph(`${id}_prompt`, "問題文サンプル")],
    hints: [],
    solution: [paragraph(`${id}_solution`, "解答サンプル")],
    answer: { type: "math", expected: "" },
  };
}

function createDocument(content: SigmaBlock[], useB5: boolean = false): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_empty_paragraph_runaway",
    metadata: { title: "empty paragraph runaway test" },
    ...(useB5
      ? { pageLayout: normalizePageLayout({ preset: "B5", orientation: "portrait" }) }
      : {}),
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  } as SigmaDocument;
}

async function getBlockCount(page: Page): Promise<number> {
  const count = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return -1; // unsaved
    }
    return (JSON.parse(raw) as { content: unknown[] }).content.length;
  });
  return count;
}

test("B5 + [heading, problem]: ブロック数が増えないこと", async ({ page }) => {
  const doc = createDocument([heading("h_1", "第1問"), problem("prob_1")], true);
  await installDesktopRuntimeMock(page, doc);
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  // 10秒放置して、その間にブロック数がどう変化するか観測
  const initialCount = doc.content.length;
  const countSnapshots: number[] = [];

  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const count = await getBlockCount(page);
    if (count !== -1) {
      countSnapshots.push(count);
    }
  }

  console.log(`Block count snapshots (initial=${initialCount}):`, countSnapshots);

  // TrailingNode 無効化が正しく機能していれば、ブロック数は増えない
  // (または未保存状態なら初期状態のまま)
  const maxCount = Math.max(...countSnapshots, initialCount);
  expect(maxCount).toBe(initialCount);
});

test("[heading] 単独: ブロック数が増えないこと", async ({ page }) => {
  const doc = createDocument([heading("h_1", "第1問")]);
  await installDesktopRuntimeMock(page, doc);
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  // 10秒放置
  const initialCount = doc.content.length;
  const countSnapshots: number[] = [];

  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const count = await getBlockCount(page);
    if (count !== -1) {
      countSnapshots.push(count);
    }
  }

  console.log(`Block count snapshots (initial=${initialCount}):`, countSnapshots);

  const maxCount = Math.max(...countSnapshots, initialCount);
  expect(maxCount).toBe(initialCount);
});
