import { expect, test, type Locator, type Page } from "@playwright/test";

import type { OverlayShape, SigmaBlock, SigmaDocument } from "@/features/document";
import type { ProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 提案の見せ方は「紙面内インライン」の 1 方式。紙面のカードは対象の段幅のまま、寸法の上限も
 * 内部スクロールも持たずに置かれ、承認操作は先頭の細いバー (`AiProposalDecisionBar`) 1 種類だけ。
 * 図形だけの提案は本文フローを持たないので、同じバーを図形のそばに付ける。
 *
 * 提案は実行を流さずに最初から置く (`initialProposals`)。配置と操作だけを見る。
 */

test.describe.configure({ timeout: 90_000 });

const FILE_ID = "file_e2e_document";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const LONG_ROWS = 60;

const paragraph = (id: string, text: string): SigmaBlock => ({ id, type: "paragraph", children: [{ type: "text", text }] });

function rectangle(id: string, anchorBlockId: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 60,
    y: 0,
    rotation: 0,
    anchor: { type: "block", blockId: anchorBlockId, dx: 60, dy: 24 },
    props: {
      w: 120,
      h: 60,
      geo: "rectangle",
      fill: "solid",
      color: "#111111",
      fillColor: "#ffffff",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  } as unknown as OverlayShape;
}

function createDocument(): SigmaDocument {
  const content: SigmaBlock[] = [
    paragraph("para_target", "提案を受ける段落です。"),
    ...Array.from({ length: 4 }, (_, index) => paragraph(`para_pad_${index}`, `続きの本文 ${index + 1}`)),
    paragraph("para_shape_anchor", "図形がぶら下がる段落です。"),
  ];
  return {
    version: "2.0",
    docId: "ai_proposal_inline_bar_e2e",
    metadata: { title: "提案バーE2E" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      overlay: {
        overlaySnapshot: { version: 1, shapes: [rectangle("bar_shape", "para_shape_anchor")], assets: {} },
      },
    },
  } as unknown as SigmaDocument;
}

function proposal(
  proposalId: string,
  draft: DesktopMcpEditProposalSummary["draft"],
  changedIds: string[],
): DesktopMcpEditProposalSummary {
  return {
    proposalId,
    fileId: FILE_ID,
    baseRevision: 1,
    baseDocId: "ai_proposal_inline_bar_e2e",
    title: "提案バーE2E",
    summary: draft.summary,
    plan: draft.plan,
    warnings: [],
    changedIds,
    provider: "chatgpt",
    runId: `run_${proposalId}`,
    roomId: `room_${proposalId}`,
    draft,
    status: "pending",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

/** 対象段落の後ろに `rows` 行を挿入する提案 (連ねた挿入なので 1 枚のカードにまとまる)。 */
function longInsertion(rows: number): DesktopMcpEditProposalSummary {
  return proposal("proposal_long", {
    summary: "長い挿入",
    plan: ["段落を挿入する"],
    warnings: [],
    operations: Array.from({ length: rows }, (_, index) => ({
      operation: "insertAfter" as const,
      summary: "段落を挿入",
      targetId: index === 0 ? "para_target" : `long_row_${index - 1}`,
      insertedBlock: paragraph(`long_row_${index}`, `提案で足す行${index}`) as never,
    })),
  }, ["para_target"]);
}

function shapeMove(): DesktopMcpEditProposalSummary {
  return proposal("proposal_shape", {
    summary: "図形を動かす",
    plan: ["図形を右へ移動する"],
    warnings: [],
    operations: [],
    mutationOperations: [{ operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "bar_shape", patch: { x: 220 } }],
  }, ["bar_shape"]);
}

function bodyAndShape(): DesktopMcpEditProposalSummary {
  return proposal("proposal_mixed", {
    summary: "本文と図形",
    plan: ["段落を書き換え、図形を動かす"],
    warnings: [],
    operations: [{
      operation: "replace",
      summary: "段落を置き換え",
      targetId: "para_target",
      replacementBlock: paragraph("para_target", "本文と図形を同時に直した段落") as never,
    }],
    mutationOperations: [{ operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "bar_shape", patch: { x: 220 } }],
  }, ["para_target", "bar_shape"]);
}

function pageLayoutOnly(): DesktopMcpEditProposalSummary {
  return proposal("proposal_layout", {
    summary: "上の余白を広げます",
    plan: ["余白を変える"],
    warnings: [],
    operations: [],
    mutationOperations: [{ operation: "updatePageLayout", summary: "上の余白を広げる", patch: { marginsMm: { top: 20 } } } as never],
  }, []);
}

function shapeAndLayout(): DesktopMcpEditProposalSummary {
  return proposal("proposal_shape_layout", {
    summary: "図形を動かして余白を広げます",
    plan: ["図形を動かし、余白を変える"],
    warnings: [],
    operations: [],
    mutationOperations: [
      { operation: "updateOverlayShape", summary: "図形を右へ移動", shapeId: "bar_shape", patch: { x: 220 } },
      { operation: "updatePageLayout", summary: "上の余白を広げる", patch: { marginsMm: { top: 20 } } } as never,
    ],
  }, ["bar_shape"]);
}

function missingAnchor(): DesktopMcpEditProposalSummary {
  return proposal("proposal_missing", {
    summary: "見つからない段落の書き換え",
    plan: ["段落を書き換える"],
    warnings: [],
    operations: [{
      operation: "replace",
      summary: "段落を置き換え",
      targetId: "not_in_document",
      replacementBlock: paragraph("not_in_document", "どこにも置けない本文") as never,
    }],
  }, ["not_in_document"]);
}

function secondShapeMove(): DesktopMcpEditProposalSummary {
  return { ...proposal("proposal_shape_2", {
    summary: "図形をもう一度動かす",
    plan: ["図形を下へ移動する"],
    warnings: [],
    operations: [],
    mutationOperations: [{ operation: "updateOverlayShape", summary: "図形を下へ移動", shapeId: "bar_shape", patch: { y: 60 } }],
  }, ["bar_shape"]), sessionLabel: "図形の整理" } as DesktopMcpEditProposalSummary;
}

async function open(
  page: Page,
  proposals: DesktopMcpEditProposalSummary[],
  document: SigmaDocument = createDocument(),
): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, document, { ai: { enabled: true, initialProposals: proposals } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** 紙面のカードの正本 (続きの複製ではない)。 */
function pageCard(page: Page, targetId: string): Locator {
  return page.locator(`.page-flow [data-flow-extension-node-id^="extension:ai-proposal:${targetId}:"]`);
}

test("a body proposal card leads with the decision bar and shows its whole content without size caps", async ({ page }) => {
  await open(page, [longInsertion(LONG_ROWS)]);
  const node = pageCard(page, "para_target");
  await expect(node).toHaveCount(1);
  const card = node.locator("[data-ai-proposal-card]");
  await expect(card).toHaveAttribute("data-ai-proposal-card", "page");

  // 承認バーはカードの最初の行。
  const firstChildIsBar = await card.evaluate((element) => element.firstElementChild?.hasAttribute("data-ai-proposal-bar") ?? false);
  expect(firstChildIsBar).toBe(true);
  await expect(card.locator("[data-ai-proposal-bar]")).toHaveCount(1);

  // 寸法の上限も内部スクロールも無い。カードの中身は全部描かれ、切り取られない。
  const caps = await card.evaluate((element) => {
    const offenders: string[] = [];
    for (const candidate of [element, ...element.querySelectorAll<HTMLElement>("*")]) {
      const style = getComputedStyle(candidate);
      if (style.maxHeight !== "none") offenders.push(`${candidate.className}: max-height ${style.maxHeight}`);
      if (/(auto|scroll)/.test(style.overflowY)) offenders.push(`${candidate.className}: overflow-y ${style.overflowY}`);
    }
    return { offenders, clipped: element.scrollHeight > element.clientHeight + 1 };
  });
  expect(caps.offenders).toEqual([]);
  expect(caps.clipped).toBe(false);

  // 幅は対象の段幅のまま (固定幅を持たない)。内容は適用後の本文と同じ幅で組む。
  const nodeBox = await node.boundingBox();
  const cardBox = await card.boundingBox();
  const targetBox = await page.locator('.page-flow [data-sigma-doc-id="para_target"]').first().boundingBox();
  const proposedBox = await card.locator("[data-ai-proposal-content] .print-paragraph").first().boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(proposedBox).not.toBeNull();
  expect(Math.abs(cardBox!.width - nodeBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(proposedBox!.width - targetBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(proposedBox!.x - targetBox!.x)).toBeLessThanOrEqual(1);

  // 長い提案はページの境目で切れ、続きは次のページに描かれる。続きの複製には操作が描かれない。
  const replica = page.locator("[data-flow-extension-replica]").first();
  await expect(replica).toBeAttached();
  await expect(replica).toContainText(`提案で足す行${LONG_ROWS - 1}`);
  const replicaBars = replica.locator("[data-ai-proposal-bar]");
  for (const bar of await replicaBars.all()) {
    await expect(bar).toBeHidden();
  }
  await expect(card.locator("[data-ai-proposal-bar]")).toBeVisible();
  await expect(card.getByRole("button", { name: "適用", exact: true })).toBeVisible();
});

test("hiding the content keeps only the bar, and the content can be shown again", async ({ page }) => {
  await open(page, [longInsertion(3)]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  const content = card.locator("[data-ai-proposal-content]");
  await expect(content).toBeVisible();
  const openHeight = (await card.boundingBox())!.height;

  await card.getByRole("button", { name: "内容を隠す", exact: true }).click();
  await expect(content).toBeHidden();
  await expect(card.locator("[data-ai-proposal-bar]")).toBeVisible();
  await expect(card.getByRole("button", { name: "適用", exact: true })).toBeVisible();
  await expect.poll(async () => (await card.boundingBox())!.height).toBeLessThan(openHeight);

  await card.getByRole("button", { name: "内容を表示", exact: true }).click();
  await expect(content).toBeVisible();
  await expect(content).toContainText("提案で足す行2");
});

test("an apply failure is shown on the bar and the proposal can be applied again", async ({ page }) => {
  await open(page, [longInsertion(1)]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await page.evaluate(() => {
    (window as unknown as { __sigmaFailNextMcpApproval?: string }).__sigmaFailNextMcpApproval = "E2Eで承認を失敗させました";
  });
  await card.getByRole("button", { name: "適用", exact: true }).click();
  // 失敗の理由はバーのすぐ下の行 (バーは折り返さない 1 行のまま)。
  await expect(card.locator("[data-ai-proposal-bar] + [data-ai-proposal-bar-details]")).toContainText("E2Eで承認を失敗させました");

  await card.getByRole("button", { name: "適用", exact: true }).click();
  await expect(pageCard(page, "para_target")).toHaveCount(0);
  await expect(page.locator('.page-flow [data-sigma-doc-id="long_row_0"]').first()).toContainText("提案で足す行0");
});

test("the discard reason popover opened from a bar is not clipped", async ({ page }) => {
  await open(page, [longInsertion(LONG_ROWS)]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "破棄", exact: true }).click();
  const popover = page.getByRole("group", { name: "破棄する理由" });
  await expect(popover).toBeVisible();
  const visibility = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const points = [
      [rect.left + 4, rect.top + 4],
      [rect.right - 4, rect.top + 4],
      [rect.left + 4, rect.bottom - 4],
      [rect.right - 4, rect.bottom - 4],
    ];
    return {
      insideViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
      hits: points.map(([x, y]) => element.contains(document.elementFromPoint(x, y))),
    };
  });
  expect(visibility.insideViewport).toBe(true);
  expect(visibility.hits).toEqual([true, true, true, true]);
  await expect(popover.getByRole("textbox")).toBeFocused();
});

test("a proposal that changes both body and shapes has one decision bar in the page flow", async ({ page }) => {
  await open(page, [bodyAndShape()]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await expect(card).toBeVisible();
  const canvas = page.locator(".page-canvas");
  await expect(canvas.locator("[data-ai-proposal-bar]")).toHaveCount(1);
  await expect(canvas.getByRole("button", { name: "適用", exact: true })).toHaveCount(1);
  await expect(page.locator('[data-ai-proposal-card="overlay"]')).toHaveCount(0);
  // 図形の変更前と変更後は紙面に常に出ている。
  await expect(page.locator('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]').first()).toBeVisible();
  await expect(page.locator('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]').first()).toBeVisible();
});

test("a shape-only proposal attaches the same bar beside the shape and never alternates before/after", async ({ page }) => {
  await open(page, [shapeMove()]);
  const widget = page.locator('[data-ai-proposal-card="overlay"]');
  await expect(widget).toHaveCount(1);
  await expect(widget.locator("[data-ai-proposal-bar]")).toBeVisible();
  await expect(widget).toContainText("AI図形の変更案");
  await expect(page.locator(".page-flow [data-ai-proposal-card]")).toHaveCount(0);

  // 矢印の吹き出しは無い。
  const arrow = await widget.evaluate((element) => getComputedStyle(element, "::after").content);
  expect(arrow === "none" || arrow === "normal").toBe(true);

  const before = page.locator('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]').first();
  const after = page.locator('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]').first();
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  await expect(before).toHaveCSS("animation-name", "none");
  await expect(after).toHaveCSS("animation-name", "none");
  const read = () => page.evaluate(() => {
    const opacity = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).opacity : "missing";
    };
    return {
      before: opacity('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]'),
      after: opacity('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]'),
    };
  });
  const first = await read();
  await page.waitForTimeout(1_400);
  expect(await read()).toEqual(first);
  expect(first.before).toBe("1");
  expect(Number(first.after)).toBeGreaterThan(0);

  // 重なって見づらいときは、変更前をバーから隠せる。
  await widget.getByRole("button", { name: "変更前を隠す", exact: true }).click();
  await expect(before).toHaveCSS("opacity", "0");
  await widget.getByRole("button", { name: "変更前を表示", exact: true }).click();
  await expect(before).toHaveCSS("opacity", "1");

  await widget.getByRole("button", { name: "適用", exact: true }).click();
  await expect(widget).toHaveCount(0);
});

/** その要素の中心を押したら、本当にその要素に届くか (覆われていない・切り取られていない)。 */
async function expectHittable(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const reached = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
  expect(reached).toBe(true);
}

for (const [label, proposals] of [
  ["a shape change plus a page-layout change", () => [shapeAndLayout()]],
  ["a page-layout change only", () => [pageLayoutOnly()]],
  ["a body change whose block is not on the page", () => [missingAnchor()]],
] as const) {
  test(`a proposal with no card in the page flow still gets one usable bar: ${label}`, async ({ page }) => {
    await open(page, proposals());
    await expect(page.locator(".page-flow [data-ai-proposal-card]")).toHaveCount(0);
    const bar = page.locator('[data-ai-proposal-card="overlay"]');
    await expect(bar).toHaveCount(1);
    const apply = bar.getByRole("button", { name: "適用", exact: true });
    await expect(apply).toBeEnabled();
    await expectHittable(apply);
    await expectHittable(bar.getByRole("button", { name: "破棄", exact: true }));
  });
}

test("a shape-and-layout proposal without a card puts its bar beside the shape", async ({ page }) => {
  await open(page, [shapeAndLayout()]);
  const bar = page.locator('[data-ai-proposal-card="overlay"]');
  await expect(bar).toContainText("図形を動かして余白を広げます");
  const shape = page.locator('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]').first();
  const [barBox, shapeBox] = [await bar.boundingBox(), await shape.boundingBox()];
  expect(barBox && shapeBox).toBeTruthy();
  // 図形のすぐ上か下にあり、横は図形にかかる。
  const verticalGap = Math.min(Math.abs(barBox!.y + barBox!.height - shapeBox!.y), Math.abs(barBox!.y - (shapeBox!.y + shapeBox!.height)));
  expect(verticalGap).toBeLessThanOrEqual(80);
  expect(barBox!.x).toBeLessThan(shapeBox!.x + shapeBox!.width);
  expect(barBox!.x + barBox!.width).toBeGreaterThan(shapeBox!.x);
});

test("bars of two shape-only proposals for the same shape never cover each other", async ({ page }) => {
  await open(page, [shapeMove(), secondShapeMove()]);
  const bars = page.locator('[data-ai-proposal-card="overlay"]');
  await expect(bars).toHaveCount(2);
  const [first, second] = [await bars.nth(0).boundingBox(), await bars.nth(1).boundingBox()];
  const overlap = Math.min(first!.y + first!.height, second!.y + second!.height) - Math.max(first!.y, second!.y);
  const horizontalOverlap = Math.min(first!.x + first!.width, second!.x + second!.width) - Math.max(first!.x, second!.x);
  expect(horizontalOverlap > 0 && overlap > 0).toBe(false);
  for (const index of [0, 1]) {
    await expectHittable(bars.nth(index).getByRole("button", { name: "適用", exact: true }));
    await expectHittable(bars.nth(index).getByRole("button", { name: "破棄", exact: true }));
  }
});

test("a hidden before shape can be neither picked nor dragged", async ({ page }) => {
  await open(page, [shapeMove()]);
  const bar = page.locator('[data-ai-proposal-card="overlay"]');
  const before = page.locator('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]').first();
  const box = (await before.boundingBox())!;
  await bar.getByRole("button", { name: "変更前を隠す", exact: true }).click();
  await expect(before).toHaveCSS("pointer-events", "none");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // 本文から図形を掴む操作 (Ctrl/Cmd+クリック → クリック) でも、見えない変更前は選ばれない。
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(center.x, center.y);
  await page.keyboard.up("ControlOrMeta");
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="bar_shape"]')).toHaveCount(0);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes?.find((shape: { id?: string }) => shape.id === "bar_shape")?.x ?? 60;
  })).toBe(60);
});

test("the decision bar stays one line and is never split by a page boundary", async ({ page }) => {
  // 用紙を低くし、提案カードの始まる位置をずらしながら、ページ境目がカードの頭に来る配置を作る。
  const referencing = { ...longInsertion(12), sourceReferences: [
    { type: "document", fileId: "file_reference", title: "参照した教材のとても長い名前の例" },
    { type: "web", url: "https://example.com/very/long/reference/path" },
  ] } as DesktopMcpEditProposalSummary;
  for (const filler of [6, 7, 8, 9, 10]) {
    const document = createDocument();
    document.content = [
      ...Array.from({ length: filler }, (_, index) => paragraph(`filler_${index}`, `前置きの本文 ${index}`)),
      ...document.content,
    ];
    document.pageLayout = {
      ...document.pageLayout,
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 150, heightMm: 120 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
    } as SigmaDocument["pageLayout"];
    await open(page, [referencing], document);
    const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
    await expect(card).toHaveCount(1);
    const bar = card.locator("[data-ai-proposal-bar]");
    const barBox = (await bar.boundingBox())!;
    // 折り返さない 1 行 (操作ボタン 1 つ分の高さ)。
    expect(barBox.height, `filler=${filler}`).toBeLessThanOrEqual(40);
    // バーの操作は切り取られずに押せる (切れ目がバーの中に来ない)。
    for (const name of ["破棄", "適用", "内容を隠す", "適用後だけを表示"]) {
      await expectHittable(card.getByRole("button", { name, exact: true }));
    }
    // 参照元はバーの外 (すぐ下の行)。続きの複製に回っても見た目は出る。
    await expect(page.locator(".page-flow").getByText("参照した教材のとても長い名前の例").first()).toBeVisible();
  }
});

function withSecondShape(): SigmaDocument {
  const document = createDocument();
  const snapshot = document.pageLayout!.overlay!.overlaySnapshot!;
  return {
    ...document,
    pageLayout: {
      ...document.pageLayout,
      overlay: {
        ...document.pageLayout!.overlay,
        overlaySnapshot: { ...snapshot, shapes: [...snapshot.shapes, { ...rectangle("other_shape", "para_target"), x: 420 }] },
      },
    },
  } as SigmaDocument;
}

const selectedShape = (page: Page, id: string) => page.locator(`.overlay-canvas-editor .overlay-shape.selected[data-overlay-shape-id="${id}"]`);

test("hiding the before state drops the hidden shape from the current selection", async ({ page }) => {
  await open(page, [shapeMove()]);
  const before = page.locator('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]').first();
  await grabShapeFromBody(page, before);
  await expect(selectedShape(page, "bar_shape")).toHaveCount(1);

  await page.locator('[data-ai-proposal-card="overlay"]').getByRole("button", { name: "変更前を隠す", exact: true }).click();
  await expect(selectedShape(page, "bar_shape")).toHaveCount(0);
  await expect(page.locator(".overlay-canvas-editor .overlay-shape.selected")).toHaveCount(0);
});

test("select-all on the canvas leaves a hidden before shape out", async ({ page }) => {
  await open(page, [shapeMove()], withSecondShape());
  await page.locator('[data-ai-proposal-card="overlay"]').getByRole("button", { name: "変更前を隠す", exact: true }).click();
  const other = page.locator('.page-overlay-preview .overlay-shape[data-overlay-shape-id="other_shape"]').first();
  await grabShapeFromBody(page, other);
  await expect(selectedShape(page, "other_shape")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+A");
  await expect(selectedShape(page, "other_shape")).toHaveCount(1);
  await expect(selectedShape(page, "bar_shape")).toHaveCount(0);
});

/**
 * 提案が上書きする段落の、AI が書いた時点の内容 (提案ストアが保存する `mergeBasis` と同じ形)。
 * スキーマ (と数式の描画器) をテストの Node 側へ読み込まないよう、ストアの計算は使わず書く。
 */
function basisOf(block: SigmaBlock): ProposalMergeBasis {
  return { version: 1, entities: { [block.id]: { kind: "block", value: block as never } } };
}

test("a proposal whose target the human edited previews the merged content and says so on its bar", async ({ page }) => {
  // 提案の後に人が対象の別の位置を直した教材。承認と同じ三者マージの replay で、紙面のカードは
  // 人の編集 (red) と AI の変更 (dog) の両方を含む内容を見せ、バーに一言を添える。合成の正しさ
  // そのもの (保存・再読込) は tests/electron/ai-proposal-merge.spec.ts が実アプリで確かめる。
  const withTarget = (text: string): SigmaDocument => {
    const document = createDocument();
    return { ...document, content: [paragraph("para_target", text), ...document.content.slice(1)] };
  };
  const draft: DesktopMcpEditProposalSummary["draft"] = {
    summary: "語を直す",
    plan: ["語を直す"],
    warnings: [],
    operations: [{
      operation: "replace",
      summary: "段落を置き換え",
      targetId: "para_target",
      replacementBlock: paragraph("para_target", "The dog sat on the mat.") as never,
    }],
  };
  const merged = { ...proposal("proposal_merged", draft, ["para_target"]), mergeBasis: basisOf(paragraph("para_target", "The cat sat on the mat.")) };
  await open(page, [merged], withTarget("The cat sat on the red mat."));

  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await expect(card.locator("[data-ai-proposal-content]")).toContainText("The dog sat on the red mat.");
  await expect(card.locator("[data-ai-proposal-bar-details] [data-ai-proposal-merge-notice]")).toHaveText("あなたの編集と合わせた内容です");
  // 合成で解決できる変更なので、競合の通知 (破棄・上書き・作り直し) は出さない。
  await expect(page.locator(".ai-stale-proposals")).toHaveCount(0);
});

test("a proposal nobody edited around carries no merge notice", async ({ page }) => {
  const draft: DesktopMcpEditProposalSummary["draft"] = {
    summary: "段落を直す",
    plan: ["段落を直す"],
    warnings: [],
    operations: [{
      operation: "replace",
      summary: "段落を置き換え",
      targetId: "para_target",
      replacementBlock: paragraph("para_target", "提案で直した段落です。") as never,
    }],
  };
  await open(page, [{ ...proposal("proposal_plain", draft, ["para_target"]), mergeBasis: basisOf(paragraph("para_target", "提案を受ける段落です。")) }]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await expect(card.locator("[data-ai-proposal-content]")).toContainText("提案で直した段落です。");
  await expect(card.locator("[data-ai-proposal-merge-notice]")).toHaveCount(0);
});

/**
 * 「適用後だけを表示」: 差分の装飾を外し、本文の変更前を畳んで、承認後の紙面の姿だけを組む。既定は差分の表示。
 * 状態はカードの外 (紙面の拡張) にあるので、改ページで切れたカードの続きも同じ表示になる。
 */
function replaceWithRows(rows: number, targetId = "para_target"): DesktopMcpEditProposalSummary {
  const original = createDocument().content.find((block) => block.id === targetId)!;
  return { ...proposal("proposal_result", {
    summary: "段落を書き換えて行を足す",
    plan: ["段落を書き換える", "行を足す"],
    warnings: [],
    operations: [
      {
        operation: "replace" as const,
        summary: "段落を置き換え",
        targetId,
        replacementBlock: paragraph(targetId, "提案で書き換えた段落です。") as never,
      },
      ...Array.from({ length: rows }, (_, index) => ({
        operation: "insertAfter" as const,
        summary: "段落を挿入",
        targetId: index === 0 ? targetId : `result_row_${index - 1}`,
        insertedBlock: paragraph(`result_row_${index}`, `適用後に並ぶ行${index}`) as never,
      })),
    ],
  }, [targetId]), mergeBasis: basisOf(original) };
}

const RESULT_ONLY_COUNTER = "AiProposalResultOnly.notLaidOut";

async function counter(page: Page, name: string): Promise<number> {
  return page.evaluate((counterName) => (
    (window as unknown as { __SIGMA_STUDIO_PERFORMANCE__?: { counters: Record<string, number> } })
      .__SIGMA_STUDIO_PERFORMANCE__?.counters?.[counterName] ?? 0
  ), name);
}

async function savedContent(page: Page): Promise<unknown> {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null")?.content ?? null);
}

test("showing only the result folds the before text and drops every change mark, on the continuation too, and switching back restores the diff", async ({ page }) => {
  await open(page, [replaceWithRows(LONG_ROWS)]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  const before = page.locator('.page-flow [data-sigma-doc-id="para_target"]').first();
  const content = card.locator("[data-ai-proposal-content]");
  const replica = page.locator("[data-flow-extension-replica]").first();

  // 既定は差分の表示: 本文の変更前は薄い赤、カードは変わった単語の印と追加側の下地。
  await expect(before).toHaveClass(/text-flow-change-before/);
  await expect(before).toBeVisible();
  await expect(content).toHaveAttribute("data-presentation", "diff");
  await expect(content.locator('[style*="--ai-proposal-word-added-mark"]').first()).toBeAttached();
  await expect(content.locator('[data-change="added"]')).toHaveCount(1);
  await expect(replica).toBeAttached();
  await expect(replica.locator('[data-change="added"]').first()).toBeAttached();
  const diffCardTop = (await card.boundingBox())!.y;
  const beforeTop = (await before.boundingBox())!.y;

  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();

  // 変更前の本文は畳まれ (描画矩形を持たない)、カードがその位置に上がる。
  await expect(before).toHaveClass(/text-flow-change-collapsed/);
  await expect(before).toBeHidden();
  await expect.poll(async () => (await card.boundingBox())!.y).toBeLessThan(diffCardTop);
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(beforeTop - 24);
  // カードは印も下地も無い適用後の内容だけ。
  await expect(content).toHaveAttribute("data-presentation", "after");
  await expect(content).toContainText("提案で書き換えた段落です。");
  await expect(content.locator('[style*="--ai-proposal-word-"]')).toHaveCount(0);
  await expect(content.locator("[data-change]")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "変更箇所を表示", exact: true })).toHaveAttribute("aria-pressed", "true");
  // 改ページで切れた続き (複製) も同じ表示。
  await expect(replica).toBeAttached();
  await expect(replica.locator('[data-ai-proposal-content][data-presentation="after"]').first()).toBeAttached();
  await expect(replica.locator("[data-change]")).toHaveCount(0);
  await expect(replica).toContainText(`適用後に並ぶ行${LONG_ROWS - 1}`);
  // バーは 1 行のまま、操作は押せる。
  expect((await card.locator("[data-ai-proposal-bar]").boundingBox())!.height).toBeLessThanOrEqual(40);
  for (const name of ["破棄", "適用", "内容を隠す", "変更箇所を表示"]) {
    await expectHittable(card.getByRole("button", { name, exact: true }));
  }
  // ふつうの置き換え・挿入は適用後の姿に組めるので、注記の代わりの経路は通らない。
  expect(await counter(page, RESULT_ONLY_COUNTER)).toBe(0);
  await expect(card.locator("[data-ai-proposal-result-notice]")).toHaveCount(0);

  await card.getByRole("button", { name: "変更箇所を表示", exact: true }).click();

  await expect(before).toBeVisible();
  await expect(before).toHaveClass(/text-flow-change-before/);
  await expect(content).toHaveAttribute("data-presentation", "diff");
  await expect(content.locator('[style*="--ai-proposal-word-added-mark"]').first()).toBeAttached();
  await expect.poll(async () => Math.abs((await card.boundingBox())!.y - diffCardTop)).toBeLessThanOrEqual(1);
});

test("the applied result is the same whether or not only the result is shown", async ({ page }) => {
  await open(page, [replaceWithRows(3)]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "適用", exact: true }).click();
  await expect(pageCard(page, "para_target")).toHaveCount(0);
  const appliedFromDiff = await savedContent(page);

  await open(page, [replaceWithRows(3)]);
  const resultCard = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  await resultCard.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  await expect(page.locator('.page-flow [data-sigma-doc-id="para_target"]').first()).toBeHidden();
  await resultCard.getByRole("button", { name: "適用", exact: true }).click();
  await expect(pageCard(page, "para_target")).toHaveCount(0);

  expect(await savedContent(page)).toEqual(appliedFromDiff);
  // 適用後の本文は畳まれずに描かれる (畳む印は提案と一緒に消える)。
  const applied = page.locator('.page-flow [data-sigma-doc-id="para_target"]').first();
  await expect(applied).toBeVisible();
  await expect(applied).toContainText("提案で書き換えた段落です。");
  await expect(page.locator(".page-flow .text-flow-change-collapsed")).toHaveCount(0);
});

test("a folded before block takes no edit while only the result is shown", async ({ page }) => {
  await open(page, [replaceWithRows(1, "para_pad_1")]);
  const card = pageCard(page, "para_pad_1").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  const folded = page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first();
  await expect(folded).toBeHidden();
  const previous = page.locator('.page-flow [data-sigma-doc-id="para_pad_0"]').first();
  await previous.click();
  // 直前の段落の末尾で Delete: 畳んだ変更前を結合しようとする編集は通らない。
  await previous.evaluate((element) => {
    const text = element.querySelector("p, h1, h2, h3") ?? element;
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
    const selection = window.getSelection()!;
    selection.collapse(last ?? text, last ? last.length : 0);
  });
  await page.keyboard.press("Delete");
  await expect(page.locator(".text-flow-edit-guard-notice").first())
    .toHaveText("適用後だけを表示している間は、変更前の本文を編集できません。「変更箇所を表示」に戻すと編集できます。");
  await page.keyboard.type("X");

  const saved = () => page.evaluate(() => {
    const document = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    const textOf = (id: string) => document?.content?.find((block: { id: string }) => block.id === id)
      ?.children?.map((node: { text?: string }) => node.text ?? "").join("");
    return { pad0: textOf("para_pad_0"), pad1: textOf("para_pad_1") };
  });
  // 前の段落には打てる (畳んだブロックだけが守られる)。
  await expect.poll(async () => (await saved()).pad0).toBe("続きの本文 1X");
  expect((await saved()).pad1).toBe("続きの本文 2");
  await expect(card).toBeVisible();
  await expect(folded).toBeHidden();
});

test("showing only the result hides the before shape and draws the proposed shape without its outline", async ({ page }) => {
  await open(page, [bodyAndShape()]);
  const card = pageCard(page, "para_target").locator("[data-ai-proposal-card]");
  const beforeShape = page.locator('.overlay-shape.ai-diff-before-shape[data-overlay-shape-id="bar_shape"]').first();
  await expect(beforeShape).toHaveCSS("opacity", "1");
  await expect(card.getByRole("button", { name: "変更前を隠す", exact: true })).toBeVisible();

  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();

  await expect(beforeShape).toHaveCSS("opacity", "0");
  await expect(beforeShape).toHaveCSS("pointer-events", "none");
  const resultShape = page.locator('.overlay-shape.ai-result-only-shape[data-overlay-shape-id="bar_shape"]').first();
  await expect(resultShape).toBeVisible();
  await expect(resultShape).toHaveCSS("outline-style", "none");
  await expect(page.locator('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]')).toHaveCount(0);
  // 変更前は隠れているので「変更前を隠す」は出さない。
  await expect(card.getByRole("button", { name: "変更前を隠す", exact: true })).toHaveCount(0);

  await card.getByRole("button", { name: "変更箇所を表示", exact: true }).click();
  await expect(beforeShape).toHaveCSS("opacity", "1");
  await expect(page.locator('.overlay-shape.ai-diff-after-shape[data-overlay-shape-id="bar_shape"]').first()).toBeVisible();
});

const RESULT_ONLY_LOCK = "適用後だけを表示している間は、変更前の本文を編集できません。「変更箇所を表示」に戻すと編集できます。";

/** 保存された段落の文字。 */
async function savedText(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((blockId) => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    return saved?.content?.find((block: { id: string }) => block.id === blockId)
      ?.children?.map((node: { text?: string }) => node.text ?? "").join("");
  }, id);
}

/** 段落の文字の端にキャレットを置く (macOS の合成キーに頼らない)。 */
async function placeCaret(page: Page, id: string, edge: "start" | "end"): Promise<void> {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
  await block.click();
  await block.evaluate((element, at) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    const target = at === "start" ? texts[0] : texts.at(-1);
    window.getSelection()!.collapse(target ?? element, at === "start" || !target ? 0 : target.length);
  }, edge);
}

test("Backspace at the start of the paragraph after the card does not join it into the folded before block", async ({ page }) => {
  // カードは para_pad_1 の後ろに入るので、para_pad_2 は別の編集面の先頭: Backspace は面をまたぐ結合になる。
  await open(page, [replaceWithRows(1, "para_pad_1")]);
  const card = pageCard(page, "para_pad_1").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  const folded = page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first();
  await expect(folded).toBeHidden();

  await placeCaret(page, "para_pad_2", "start");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".text-flow-edit-guard-notice").first()).toHaveText(RESULT_ONLY_LOCK);
  // キャレットは見えないブロックへ移らず、その場に打てる。
  await page.keyboard.type("Y");

  await expect.poll(() => savedText(page, "para_pad_2")).toBe("Y続きの本文 3");
  expect(await savedText(page, "para_pad_1")).toBe("続きの本文 2");
  await expect(folded).toBeHidden();
  await expect(card).toBeVisible();
});

test("Enter at the end of the paragraph before a folded block adds a paragraph and leaves the folded block alone", async ({ page }) => {
  await open(page, [replaceWithRows(1, "para_pad_1")]);
  const card = pageCard(page, "para_pad_1").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  await expect(page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first()).toBeHidden();

  await placeCaret(page, "para_pad_0", "end");
  await page.keyboard.press("Enter");
  await page.keyboard.type("新しい段落");

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "null");
    const ids: string[] = saved?.content?.map((block: { id: string }) => block.id) ?? [];
    const index = ids.indexOf("para_pad_0");
    const next = saved?.content?.[index + 1];
    return next?.children?.map((node: { text?: string }) => node.text ?? "").join("");
  })).toBe("新しい段落");
  expect(await savedText(page, "para_pad_1")).toBe("続きの本文 2");
  await expect(page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first()).toBeHidden();
});

test("undo cannot change a folded block it cannot show, and works again once the changes are shown", async ({ page }) => {
  await open(page, [replaceWithRows(1, "para_pad_1")]);
  const card = pageCard(page, "para_pad_1").locator("[data-ai-proposal-card]");
  // 差分の表示のまま対象の段落を直す (保留中の対象はロックしない)。
  await placeCaret(page, "para_pad_1", "end");
  await page.keyboard.type("Z");
  await expect.poll(() => savedText(page, "para_pad_1")).toBe("続きの本文 2Z");

  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  await expect(page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first()).toBeHidden();
  const undo = page.getByRole("button", { name: "元に戻す", exact: true });
  await undo.click();
  await expect(page.locator(".save-state").first()).toContainText(RESULT_ONLY_LOCK);
  expect(await savedText(page, "para_pad_1")).toBe("続きの本文 2Z");

  await card.getByRole("button", { name: "変更箇所を表示", exact: true }).click();
  await undo.click();
  await expect.poll(() => savedText(page, "para_pad_1")).toBe("続きの本文 2");
});

test("search does not find text in a folded block, and replacing cannot rewrite it unseen", async ({ page }) => {
  await open(page, [replaceWithRows(1, "para_pad_1")]);
  const card = pageCard(page, "para_pad_1").locator("[data-ai-proposal-card]");
  await card.getByRole("button", { name: "適用後だけを表示", exact: true }).click();
  await expect(page.locator('.page-flow [data-sigma-doc-id="para_pad_1"]').first()).toBeHidden();

  await page.getByRole("button", { name: "検索置換", exact: true }).click();
  const widget = page.locator(".find-widget");
  const query = widget.getByRole("textbox", { name: "検索", exact: true });
  await query.fill("続きの本文 2");
  await expect(widget.locator(".find-count")).toHaveText("0 件");
  await query.press("Enter");
  await expect(page.locator(".save-state").first()).toContainText("検索結果がありません");

  // 見える段落と畳んだ段落の両方に当たる置換は、畳んだ段落を見えないまま書き換えるので断る。
  await query.fill("続きの本文");
  await expect(widget.locator(".find-count")).toHaveText("3 件");
  await widget.getByRole("button", { name: "置換を開く", exact: true }).click();
  await widget.getByRole("textbox", { name: "置換", exact: true }).fill("本文");
  await widget.getByRole("button", { name: "すべて置換", exact: true }).click();
  await expect(page.locator(".save-state").first()).toContainText(RESULT_ONLY_LOCK);
  expect(await savedText(page, "para_pad_1")).toBe("続きの本文 2");
  expect(await savedText(page, "para_pad_0")).toBe("続きの本文 1");

  // 差分の表示に戻すと、畳んでいた段落も探せる (外を押すと検索の枠は閉じるので開き直す)。
  await card.getByRole("button", { name: "変更箇所を表示", exact: true }).click();
  if (!(await widget.isVisible())) {
    await page.getByRole("button", { name: "検索置換", exact: true }).click();
  }
  await expect(widget.locator(".find-count")).toHaveText("4 件");
});
