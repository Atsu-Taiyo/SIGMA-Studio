import { expect, test, type Locator, type Page } from "@playwright/test";

import type { OverlayShape, SigmaBlock, SigmaDocument } from "@/features/document";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
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

async function open(page: Page, proposals: DesktopMcpEditProposalSummary[]): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createDocument(), { ai: { enabled: true, initialProposals: proposals } });
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
  await expect(card.locator("[data-ai-proposal-bar]")).toContainText("E2Eで承認を失敗させました");

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
