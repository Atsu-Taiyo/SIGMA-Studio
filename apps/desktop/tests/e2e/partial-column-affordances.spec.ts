import { expect, test, type Page } from "@playwright/test";

import type { LayoutSectionNode, ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOptionInPage } from "./ui-select";

/**
 * 部分段組のグリップ・下端つまみ・列境界が、それぞれの段に属して見え、互いを塞がないこと。
 *
 * - 段の空いた所では、隣の段の行のつまみを出さない (左右どちらの向きでも)。
 * - 2 段目以降のつまみは段間の右半分 (段の本文側) に出て、列境界の中央を覆わない。
 * - 段間は列境界のもの。クリックでは幅を書き換えず、ダブルクリックで均等に戻す。
 * - 段の空白へ落とすと、その段の末尾に入る。
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function columns(id: string, left: string[], right: string[]): LayoutSectionNode {
  return {
    type: "layoutSection",
    id,
    layout: { columnCount: 2, columnGapMm: 8, columnStartIds: [left[0], right[0]], columnWidths: [5000, 5000] },
    children: [...left, ...right].map((childId) => paragraph(childId, `${childId} の段落`)),
  };
}

function seed(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_e2e_partial_column_affordances",
    metadata: { title: "部分段組の操作" },
    content: [
      paragraph("head", "段組の前"),
      // 左が長い段組と、右が長い段組。
      columns("tall_left", ["l1", "l2", "l3", "l4"], ["r1"]),
      columns("tall_right", ["m1"], ["n1", "n2", "n3"]),
      paragraph("tail", "段組の後"),
      { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [columns("boxed", ["bl1", "bl2"], ["br1"])] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await installDesktopRuntimeMock(page, seed());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await expect(page.locator('.page-flow [data-sigma-doc-id="br1"]').first()).toBeVisible();
}

async function rect(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return box!;
}

const block = (id: string) => `.page-flow [data-sigma-doc-id="${id}"]`;
const divider = (sectionId: string) => `${block(sectionId)} .layout-section-column-resize-handle`;

async function visibleHandles(page: Page) {
  return page.evaluate(() => ({
    grips: [...document.querySelectorAll<HTMLElement>(".page-block-handle")].map((element) => element.dataset.blockId),
    spaces: [...document.querySelectorAll<HTMLElement>(".page-block-space-handle")].map((element) => element.dataset.blockId),
  }));
}

/** 出るまで少しずつ寄せる (開いた直後の再計測に 1 回目のホバーが飲まれることがある)。 */
async function hoverUntil(page: Page, x: number, y: number, ready: () => Promise<boolean>) {
  let wiggle = 0;
  await expect.poll(async () => {
    await page.mouse.move(x + (wiggle % 3), y + (wiggle % 2));
    wiggle += 1;
    return ready();
  }, { timeout: 10_000, intervals: [100, 200, 300] }).toBe(true);
}

async function savedSection(page: Page, id: string): Promise<LayoutSectionNode | null> {
  return page.evaluate((sectionId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const find = (blocks: unknown[]): unknown => {
      for (const entry of blocks as Array<{ id: string; blocks?: unknown[] }>) {
        if (entry.id === sectionId) return entry;
        const nested = entry.blocks ? find(entry.blocks) : null;
        if (nested) return nested;
      }
      return null;
    };
    return find((JSON.parse(raw) as { content: unknown[] }).content) as LayoutSectionNode | null;
  }, id);
}

test("an empty part of a shorter column never shows the other column's handles", async ({ page }) => {
  await open(page);
  const l3 = await rect(page, block("l3"));
  const r1 = await rect(page, block("r1"));
  // 右段が短い: まず右段の行でつまみが出ることを確かめてから、同じ段の空白 (左段 l3 の高さ) へ下りる。
  await hoverUntil(page, r1.x + 60, r1.y + r1.height / 2, async () => (await visibleHandles(page)).grips.includes("r1"));
  for (const x of [r1.x + 60, r1.x + 4]) {
    await page.mouse.move(x, l3.y + l3.height / 2, { steps: 4 });
    await expect.poll(async () => visibleHandles(page)).toEqual({ grips: [], spaces: [] });
  }

  // 左段が短い段組: 左段の空白と、ページ左余白のガター。
  const n2 = await rect(page, block("n2"));
  const m1 = await rect(page, block("m1"));
  for (const x of [m1.x + 60, m1.x - 12]) {
    await page.mouse.move(x, n2.y + n2.height / 2, { steps: 4 });
    await expect.poll(async () => visibleHandles(page)).toEqual({ grips: [], spaces: [] });
  }
  // 段の中の行へ戻れば、その段の行に出る。
  await page.mouse.move(n2.x + 60, n2.y + n2.height / 2, { steps: 4 });
  await expect.poll(async () => visibleHandles(page)).toEqual({ grips: ["n2"], spaces: ["n2"] });
});

test("the right column's handles sit on its side of the gap and leave the divider line free", async ({ page }) => {
  await open(page);
  const left = await rect(page, `${block("tall_right")} [data-layout-column-index="0"]`);
  const right = await rect(page, `${block("tall_right")} [data-layout-column-index="1"]`);
  const n1 = await rect(page, block("n1"));
  const gapCenter = (left.x + left.width + right.x) / 2;
  const grip = page.locator('.page-block-handle[data-block-id="n1"]');
  await hoverUntil(page, n1.x + 40, n1.y + 8, () => grip.isVisible());
  await expect(grip).toHaveAttribute("data-gutter-lane", "column");
  const gripBox = (await grip.boundingBox())!;
  // 左の段の行末からは離れ、段間の中央 (列境界) にはかからない。
  expect(gripBox.x).toBeGreaterThan(gapCenter);
  expect(gripBox.x + gripBox.width).toBeLessThanOrEqual(right.x + 1);

  // 本文から段間の中央へ同じ行のまま動いても、グリップは消えず、そこは列境界 (つまみが出る)。
  await page.mouse.move(gapCenter, n1.y + 8, { steps: 6 });
  await expect(grip).toBeVisible();
  const knob = page.locator(`${divider("tall_right")} .layout-section-column-resize-knob`);
  await expect.poll(() => knob.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  // そのまま押して引けば列幅が変わる (ブロックのドラッグにはならない)。
  await page.mouse.down();
  // 端まで寄せると「列を結合」。ポインタが本文の上を通っても、プレビューの再計測でグリップは出ない。
  await page.mouse.move(right.x + right.width - 4, n1.y + 8, { steps: 12 });
  await expect(page.locator(divider("tall_right"))).toHaveAttribute("data-readout", "列を結合");
  await page.waitForTimeout(300);
  await expect(page.locator(".page-block-handle")).toHaveCount(0);
  await page.mouse.move(gapCenter + 60, n1.y + 8, { steps: 8 });
  await expect(page.locator(divider("tall_right"))).toHaveAttribute("data-readout", /%/);
  await expect(page.locator(".page-block-handle")).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(async () => (await savedSection(page, "tall_right"))?.layout.columnWidths?.[0] ?? 0).toBeGreaterThan(5000);
  expect((await savedSection(page, "tall_right"))?.layout.columnStartIds).toEqual(["m1", "n1"]);
});

test("the space handle of a right-column row survives a diagonal approach through the gap", async ({ page }) => {
  await open(page);
  const n2 = await rect(page, block("n2"));
  const space = page.locator('.page-block-space-handle[data-block-id="n2"]');
  await hoverUntil(page, n2.x + 80, n2.y + 6, () => space.isVisible());
  const target = (await space.boundingBox())!;
  const [sx, sy] = [n2.x + 80, n2.y + 6];
  const [tx, ty] = [target.x + target.width / 2, target.y + target.height / 2];
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(sx + ((tx - sx) * step) / 12, sy + ((ty - sy) * step) / 12);
    await expect(space).toBeVisible();
  }
  await page.mouse.down();
  await page.mouse.move(tx, ty + 24, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const section = await savedSection(page, "tall_right");
    const row = section?.children.find((child) => child.id === "n2") as { spaceAfterPx?: number } | undefined;
    return row?.spaceAfterPx ?? 0;
  }).toBeGreaterThan(0);
});

for (const sectionId of ["tall_left", "boxed"] as const) {
  test(`${sectionId}: a click keeps the widths, a double-click evens them, and a drag shows the share`, async ({ page }) => {
    await open(page);
    const handle = page.locator(divider(sectionId));
    await handle.scrollIntoViewIfNeeded();
    const box = await rect(page, divider(sectionId));
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(20, box.height / 2);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 70, y, { steps: 8 });
    await expect(handle).toHaveAttribute("data-readout", /^\d+% : \d+%$/);
    await page.mouse.up();
    await expect.poll(async () => (await savedSection(page, sectionId))?.layout.columnWidths?.[0] ?? 10_000).toBeLessThan(5000);
    const resized = (await savedSection(page, sectionId))!.layout.columnWidths;

    // 1 回のクリックは何も書き換えない (丸めで 1 ずれた版を作らない)。
    const moved = await rect(page, divider(sectionId));
    await page.waitForTimeout(500);
    await page.mouse.click(moved.x + moved.width / 2, y);
    await page.waitForTimeout(500);
    expect((await savedSection(page, sectionId))!.layout.columnWidths).toEqual(resized);

    await page.mouse.dblclick(moved.x + moved.width / 2, y);
    await expect.poll(async () => (await savedSection(page, sectionId))?.layout.columnWidths).toEqual([5000, 5000]);
  });
}

test("dropping into the empty part of a column appends to that column", async ({ page }) => {
  await open(page);
  const l2 = await rect(page, block("l2"));
  const l4 = await rect(page, block("l4"));
  const r1 = await rect(page, block("r1"));
  const grip = page.locator('.page-block-handle[data-block-id="l2"]');
  await hoverUntil(page, l2.x + 30, l2.y + l2.height / 2, () => grip.isVisible());
  const from = (await grip.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = { x: r1.x + 60, y: l4.y + 4 };
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 12,
      from.y + ((to.y - from.y) * step) / 12,
    );
    await page.waitForTimeout(16);
  }
  // 落とし先の線は右段の最後の行の下に、右段の幅で出る (段組全体の前後ではない)。
  const line = await rect(page, ".page-block-drop-line");
  expect(line.x).toBeGreaterThan(r1.x - 2);
  expect(Math.abs(line.y + line.height / 2 - (r1.y + r1.height))).toBeLessThan(4);
  expect(line.width).toBeLessThan(r1.width + 4);
  await page.mouse.up();
  await expect.poll(async () => {
    const section = await savedSection(page, "tall_left");
    return section ? { order: section.children.map((child) => child.id), starts: section.layout.columnStartIds } : null;
  }).toEqual({ order: ["l1", "l3", "l4", "r1", "l2"], starts: ["l1", "r1"] });
});

/*
 * 不変条件の走査。上の個別の場面だけでは、段の高さ・段数・枠・ズームの組み合わせで同じ種類の
 * ずれが戻っても気づけない。段組の上をポインタで面として走査し、どの位置でも次が成り立つことを見る。
 *
 * A. 表示中のグリップ・下端つまみは、ポインタが居る段 (段間は右の段、左余白は 1 段目) の行のもの。
 *    描く位置はその行の左の外で、左隣の段の本文にかからない。
 * B. 左右どちらの本文から寄っても、段間の中央 (列境界の線) の真上は常に列境界のボタン。
 */

function sweepColumns(id: string, texts: string[][]): LayoutSectionNode {
  const ids = texts.map((column, columnIndex) => column.map((_, rowIndex) => `${id}_${columnIndex}_${rowIndex}`));
  return {
    type: "layoutSection",
    id,
    layout: {
      columnCount: texts.length,
      columnGapMm: 8,
      columnStartIds: ids.map((column) => column[0]),
      columnWidths: texts.map(() => Math.round(10_000 / texts.length)),
    },
    children: ids.flatMap((column, columnIndex) => column.map((childId, rowIndex) => (
      paragraph(childId, texts[columnIndex][rowIndex])
    ))),
  };
}

const longLine = "長めの行が折り返して二行になる段落です。".repeat(2);

function sweepSeed(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_e2e_partial_column_sweep",
    metadata: { title: "部分段組の走査" },
    content: [
      paragraph("sweep_head", "段組の前"),
      sweepColumns("sweep_left_tall", [["左1", longLine, "左3", "左4"], ["右1"]]),
      paragraph("sweep_between", "段組のあいだ"),
      sweepColumns("sweep_right_tall", [["左1"], ["右1", "右2", longLine]]),
      paragraph("sweep_between_2", "段組のあいだ"),
      sweepColumns("sweep_three", [["一", "二"], [longLine, "四", "五"], ["六"]]),
      paragraph("sweep_between_3", "段組のあいだ"),
      { type: "boxBlock", id: "sweep_box", styleId: "fancybox", blocks: [sweepColumns("sweep_boxed", [["枠左1", "枠左2", "枠左3"], ["枠右1"]])] },
      paragraph("sweep_tail", "段組の後"),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

async function openSweep(page: Page, zoom?: string) {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await installDesktopRuntimeMock(page, sweepSeed());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await expect(page.locator(block("sweep_boxed_1_0")).first()).toBeVisible();
  if (zoom) {
    await selectUiOptionInPage(page, "ズーム", zoom);
    await page.waitForTimeout(800);
  }
}

/** A の検査。違反を文にして返す (空なら成立)。 */
async function laneViolations(page: Page, sectionId: string, x: number, y: number): Promise<string[]> {
  return page.evaluate(({ sectionId: id, x: pointerX, y: pointerY }) => {
    const section = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    const grid = section
      ? Array.from(section.querySelectorAll<HTMLElement>(".layout-section-independent-columns"))
        .find((candidate) => candidate.closest("[data-sigma-doc-id]") === section)
      : null;
    if (!section || !grid) return [`${id}: 段組が描かれていない`];
    const columns = Array.from(grid.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.classList.contains("layout-section-independent-column")
    ));
    const rects = columns.map((column) => column.getBoundingClientRect());
    const laneOf = (px: number) => rects.reduce((lane, _rect, index) => (index > 0 && px >= rects[index - 1].right ? index : lane), 0);
    const pointerLane = laneOf(pointerX);
    const problems: string[] = [];
    for (const control of Array.from(document.querySelectorAll<HTMLElement>(".page-block-handle, .page-block-space-handle"))) {
      const blockId = control.dataset.blockId ?? "";
      const row = section.querySelector<HTMLElement>(`[data-sigma-doc-id="${CSS.escape(blockId)}"]`);
      if (!row) continue;
      let column = row.closest<HTMLElement>(".layout-section-independent-column");
      while (column && !columns.includes(column)) column = column.parentElement?.closest<HTMLElement>(".layout-section-independent-column") ?? null;
      if (!column) continue;
      const index = columns.indexOf(column);
      const kind = control.classList.contains("page-block-handle") ? "グリップ" : "下端つまみ";
      const where = `(${Math.round(pointerX)}, ${Math.round(pointerY)})`;
      if (index !== pointerLane) {
        problems.push(`${where}: ${pointerLane + 1}段目にポインタがあるのに ${index + 1}段目の ${blockId} の${kind}が出ている`);
      }
      const box = control.getBoundingClientRect();
      if (box.right > row.getBoundingClientRect().left + 2) {
        problems.push(`${where}: ${blockId} の${kind}が行の左の外ではなく本文に重なっている`);
      }
      if (index > 0 && box.left < rects[index - 1].right - 1) {
        problems.push(`${where}: ${blockId} の${kind}が左隣の段の本文にかかっている`);
      }
    }
    return problems;
  }, { sectionId, x, y });
}

async function sweepLaneOwnership(page: Page, sectionId: string) {
  const section = page.locator(block(sectionId)).first();
  await section.scrollIntoViewIfNeeded();
  const box = (await section.boundingBox())!;
  const problems: string[] = [];
  // 行ごとに左余白から右端まで、実ユーザーのように横へなめる (段間での保持も含めて通る)。
  for (let y = box.y + 2; y < box.y + box.height - 1; y += 9) {
    await page.mouse.move(box.x - 40, y);
    for (let x = box.x - 24; x < box.x + box.width; x += 11) {
      await page.mouse.move(x, y);
      problems.push(...await laneViolations(page, sectionId, x, y));
    }
  }
  expect(problems).toEqual([]);
}

async function sweepDividerCenters(page: Page, sectionId: string) {
  const section = page.locator(block(sectionId)).first();
  await section.scrollIntoViewIfNeeded();
  const sectionBox = (await section.boundingBox())!;
  const columnBoxes = await page.evaluate((id) => {
    const owner = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`)!;
    const grid = Array.from(owner.querySelectorAll<HTMLElement>(".layout-section-independent-columns"))
      .find((candidate) => candidate.closest("[data-sigma-doc-id]") === owner)!;
    return Array.from(grid.children)
      .filter((child) => child.classList.contains("layout-section-independent-column"))
      .map((child) => { const rect = child.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
  }, sectionId);
  const problems: string[] = [];
  for (let index = 1; index < columnBoxes.length; index += 1) {
    const center = (columnBoxes[index - 1].right + columnBoxes[index].left) / 2;
    for (let y = sectionBox.y + 3; y < sectionBox.y + sectionBox.height - 2; y += 6) {
      for (const from of [columnBoxes[index].left + 30, columnBoxes[index - 1].right - 30]) {
        await page.mouse.move(from, y);
        await page.mouse.move(center, y, { steps: 3 });
        for (const x of [center - 2, center, center + 2]) {
          const owner = await page.evaluate(({ x: px, y: py, id }) => {
            const element = document.elementFromPoint(px, py);
            const handle = element?.closest(".layout-section-column-resize-handle");
            return handle && handle.closest(`[data-sigma-doc-id="${id}"]`)
              ? "divider"
              : element instanceof HTMLElement ? element.className || element.tagName : String(element);
          }, { x, y, id: sectionId });
          if (owner !== "divider") {
            problems.push(`${index}本目の列境界 (${Math.round(x)}, ${Math.round(y)}) を ${from > center ? "右" : "左"}から: ${owner}`);
          }
        }
      }
    }
  }
  expect(problems).toEqual([]);
}

test.describe("partial column invariants over the whole surface", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const sectionId of ["sweep_left_tall", "sweep_right_tall", "sweep_three", "sweep_boxed"]) {
    test(`${sectionId}: every shown handle belongs to the column under the pointer`, async ({ page }) => {
      await openSweep(page);
      await sweepLaneOwnership(page, sectionId);
    });

    test(`${sectionId}: the divider line is never covered by a handle`, async ({ page }) => {
      await openSweep(page);
      await sweepDividerCenters(page, sectionId);
    });
  }

  test("the same invariants hold at 150% zoom", async ({ page }) => {
    await openSweep(page, "150");
    await sweepLaneOwnership(page, "sweep_three");
    await sweepDividerCenters(page, "sweep_three");
  });
});
