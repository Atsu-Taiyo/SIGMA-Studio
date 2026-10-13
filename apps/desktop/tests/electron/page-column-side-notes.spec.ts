import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";

/**
 * 段組の 2 段目以降に置いた問題・解答・段組のチップ (サイド注) は、その段のすぐ左 (段の間) に縦書きで出る。
 * 段組の組み方を作り直したときに段の位置の受け渡しが外れ、どの段のチップも紙面の左余白 (1 段目の
 * チップの上) に出ていた。実アプリの紙面で位置を測って固定する。
 */

const APP_ROOT = path.resolve(__dirname, "../..");

function paragraph(id: string, text: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text }] };
}

function sourceDocument(): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: "right_box", bodyId: "right_box_body" });
  box.blocks = [{
    type: "layoutSection",
    id: "box_columns",
    layout: { columnCount: 2, columnGapMm: 6 },
    children: [paragraph("box_left", "箱の左の段"), paragraph("box_right", "箱の右の段")],
  }];
  return ensurePageLayout({
    ...sampleDocument,
    version: "2.0",
    docId: "electron_page_column_side_notes",
    metadata: { title: "段組のチップ" },
    content: [
      // 1 段目の右端まで本文が詰まっている高さに、2 段目のチップが来るようにする。
      paragraph("intro", "左の段の本文が段の右端まで詰まっています。".repeat(8)),
      {
        type: "problem", id: "q1", tags: [], lead: [], hints: [],
        prompt: [paragraph("q1_prompt", "左の段の問題文です。".repeat(3))],
        solution: [paragraph("q1_solution", "左の段の解答です。".repeat(3))],
      },
      {
        // 1 行だけの問題と解答: チップが縦に使える高さがいちばん短い。
        type: "problem", id: "q2", tags: [], lead: [], hints: [],
        pagination: { break: true },
        prompt: [paragraph("q2_prompt", "右の段の問題文。")],
        solution: [paragraph("q2_solution", "右の段の解答。")],
      },
      box,
    ],
    pageLayout: normalizePageLayout({ flow: { type: "columns", columnCount: 2, columnGapMm: 8 } }),
  });
}

type ChipGeometry = {
  text: string;
  title: string;
  writingMode: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  clipped: boolean;
  digitsUpright: boolean | null;
};

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} was not rendered`);
      return element.getBoundingClientRect();
    };
    const chip = (selector: string): ChipGeometry => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} was not rendered`);
      const box = element.getBoundingClientRect();
      const digits = element.querySelector<HTMLElement>(".side-note-digits");
      return {
        text: element.textContent ?? "",
        title: element.title,
        writingMode: getComputedStyle(element).writingMode,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        clipped: element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1,
        digitsUpright: digits ? getComputedStyle(digits).textCombineUpright === "all" : null,
      };
    };
    const unitChip = (problemId: string, area: string) =>
      chip(`.page-flow [data-problem-id="${problemId}"][data-problem-area="${area}"] > .problem-area-side-note > span`);
    const leftColumn = rect('.page-flow [data-sigma-doc-id="intro"]');
    const rightColumn = rect('.page-flow [data-sigma-doc-id="q2_prompt"]');
    const later = [
      unitChip("q2", "prompt"),
      unitChip("q2", "solution"),
      chip('[data-box-layout-section-side-note="box_columns"] > .layout-section-side-note > span'),
    ];
    return {
      sheetLeft: rect(".page-backdrop .a4-page-sheet").left,
      leftColumnRight: leftColumn.right,
      rightColumnLeft: rightColumn.left,
      first: [unitChip("q1", "prompt"), unitChip("q1", "solution")],
      later,
      // 左の段の行末をクリックしたとき、チップに取られない。
      leftColumnEndHitsChip: later.some((geometry) => {
        const hit = document.elementFromPoint(leftColumn.right - 3, (geometry.top + geometry.bottom) / 2);
        return Boolean(hit?.closest(".problem-area-side-note, .layout-section-side-note"));
      }),
    };
  });
}

test("chips beside a later page column sit vertically in the column gap, not in the page margin", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-page-column-side-notes-"));
  const sourceFile = path.join(profile, "段組のチップ.sigma");
  writeFileSync(sourceFile, JSON.stringify(sourceDocument()));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.locator('.page-flow [data-problem-id="q2"][data-problem-area="prompt"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    // 段への配置は計測のあとで決まるので、2 段目のチップが縦書きになるまで待つ。
    await expect.poll(async () => (await measure(page)).later.map((chip) => chip.writingMode))
      .toEqual(["vertical-rl", "vertical-rl", "vertical-rl"]);

    const geometry = await measure(page);
    // 1 段目は今までどおり、紙面の左端にまたがる横書きのチップ。
    for (const chip of geometry.first) {
      expect(chip.writingMode, chip.text).toBe("horizontal-tb");
      expect(chip.left, chip.text).toBeLessThan(geometry.sheetLeft);
      expect(chip.right, chip.text).toBeGreaterThan(geometry.sheetLeft);
      expect(chip.title, chip.text).toBe("");
    }
    // 2 段目は段の間に収まり、どちらの段の本文にも重ならない。1 行の問題・段組でも見出しは切れない。
    // 段の間では短い形で出し、元の呼び名は hover (title) に残す。
    expect(geometry.later.map((chip) => chip.text)).toEqual(["問2", "解答", "2段"]);
    expect(geometry.later.map((chip) => chip.title)).toEqual(["問2 問題文", "解答", "2段組"]);
    for (const chip of geometry.later) {
      expect(chip.left, chip.text).toBeGreaterThanOrEqual(geometry.leftColumnRight - 0.5);
      expect(chip.right, chip.text).toBeLessThanOrEqual(geometry.rightColumnLeft + 0.5);
      expect(chip.clipped, chip.text).toBe(false);
    }
    expect(geometry.later[0].digitsUpright).toBe(true);
    expect(geometry.later[2].digitsUpright).toBe(true);
    // 縦に並ぶチップどうしも重ならない。
    for (let index = 1; index < geometry.later.length; index += 1) {
      expect(geometry.later[index].top).toBeGreaterThanOrEqual(geometry.later[index - 1].bottom);
    }
    expect(geometry.leftColumnEndHitsChip).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
