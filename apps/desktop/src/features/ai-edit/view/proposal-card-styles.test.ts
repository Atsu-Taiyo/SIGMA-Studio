import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 提案は「紙面内インライン」1 方式。紙面のカードは対象の段幅のまま、実際の組版で全体を見せる
 * (幅・高さの固定上限も内部スクロールも持たない)。図形の変更前/変更後は常に描き、時間や hover で
 * 切り替えない。これをスタイルシートの側から固定する (実描画は `tests/e2e/ai-proposal-inline-bar.spec.ts`)。
 */

const srcDirectory = path.resolve(import.meta.dirname, "../../..");

function readCss(relativePath: string): string {
  return readFileSync(path.join(srcDirectory, relativePath), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 一番内側の規則 (`@media` の中も) を、セレクタと宣言の組で返す。 */
function rules(css: string): Array<{ selector: string; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

const FEATURE_CSS = readCss("app/styles/graph-and-text-editing.css");
const OVERLAY_CSS = readCss("app/styles/task-and-command-overlays.css");
const CHAT_CSS = readCss("app/styles/ai-chat.css");
const CONTENT_CSS = readCss("features/ai-edit/view/AiProposalContentView.module.css");
const BAR_CSS = readCss("components/ui/ai/AiProposalDecisionBar.module.css");
const ALL_CSS = [FEATURE_CSS, OVERLAY_CSS, CHAT_CSS, CONTENT_CSS, BAR_CSS].join("\n");

const SIZE_CAP = /(?:^|;)\s*(?:max-height|max-width|width|height)\s*:/;
const INNER_SCROLL = /(?:^|;)\s*overflow(?:-y)?\s*:\s*(?:auto|scroll|hidden)/;

describe("proposal card styles", () => {
  it("gives the page card no size cap and no inner scroll (it keeps the column width and grows with its content)", () => {
    const cardRules = rules(FEATURE_CSS).filter(({ selector }) => selector.includes("ai-proposal-card"));
    expect(cardRules.length).toBeGreaterThan(0);
    const offending = cardRules
      .filter(({ selector }) => !selector.includes('"overlay"') && !selector.includes("--overlay"))
      .filter(({ body }) => SIZE_CAP.test(body) || INNER_SCROLL.test(body))
      .map(({ selector }) => selector);
    expect(offending).toEqual([]);
  });

  it("keeps the page card's margin at single-class specificity so the continuation copy can drop it", () => {
    // 続きの複製は汎用の `.page-flow-extension-fragment > .page-flow-extension-fragment-content > *`
    // (クラス 2 つ) が上下の margin を 0 にする前提で帯をずらす。カードの margin の規則がそれと同じ
    // 詳細度だと、後から読まれるこちらが勝ち、複製だけが margin の分ずれて行が二重・欠けになる。
    const marginRules = rules(FEATURE_CSS)
      .filter(({ selector }) => selector.includes("ai-proposal-card") && !selector.includes("overlay"))
      .filter(({ body }) => /(?:^|;)\s*margin(?:-block|-top|-bottom)?\s*:/.test(body));
    expect(marginRules.map(({ selector }) => selector)).toEqual([".ai-proposal-card--page"]);
  });

  it("leaves nothing of the old capped dialog or its scroll frame behind", () => {
    for (const retired of ["ai-inline-preview-dialog", "ai-inline-preview-scroll", "ai-inline-preview-header", "ai-inline-preview-diff-heading", "ai-inline-preview-placeholder"]) {
      expect(ALL_CSS, retired).not.toContain(retired);
    }
  });

  it("never clips or scrolls the content view in either surface (a panel figure may only scale down whole)", () => {
    const offending = rules(CONTENT_CSS)
      .filter(({ selector, body }) => (
        (/(?:^|;)\s*max-height\s*:/.test(body) && !/\bsvg$/.test(selector))
        || /overflow(?:-y)?\s*:\s*(?:auto|scroll)/.test(body)
      ))
      .map(({ selector }) => selector);
    expect(offending).toEqual([]);
    // 縮めるときは縦横比を保つ (幅も auto にして、高さの上限に合わせて幅が縮む)。
    const panelFigure = rules(CONTENT_CSS).find(({ selector }) => selector.includes('[data-surface="panel"]') && /\bsvg$/.test(selector));
    expect(panelFigure?.body).toMatch(/width\s*:\s*auto/);
  });

  it("draws the shape bar without a speech-bubble arrow and without the paged-render leftover", () => {
    expect(ALL_CSS).not.toContain("ai-overlay-approval-widget");
    expect(rules(FEATURE_CSS).filter(({ selector }) => selector.includes("ai-proposal-card") && selector.includes("::after")))
      .toEqual([]);
  });

  it("never alternates the before/after shapes over time or on hover", () => {
    expect(FEATURE_CSS).not.toMatch(/@keyframes\s+ai-overlay-diff-/);
    expect(FEATURE_CSS).not.toContain("animation-play-state");
    const diffRules = rules(FEATURE_CSS).filter(({ selector }) => /ai-diff-(?:before|after)-shape/.test(selector));
    expect(diffRules.filter(({ body }) => /animation/.test(body)).map(({ selector }) => selector)).toEqual([]);
    expect(diffRules.filter(({ selector }) => selector.includes(":hover")).map(({ selector }) => selector)).toEqual([]);
  });

  it("hides a before shape only when the user asks for it from the bar, and the hidden shape takes no clicks", () => {
    const hidden = rules(FEATURE_CSS).find(({ selector }) => selector.includes("ai-diff-before-hidden"));
    expect(hidden?.body).toMatch(/opacity\s*:\s*0/);
    // 見えない図形が押されて選ばれ・動かされないように。
    expect(hidden?.body).toMatch(/pointer-events\s*:\s*none/);
    expect(hidden?.body).toMatch(/user-select\s*:\s*none/);
  });

  it("keeps the decision bar on one line (never wraps its controls onto a second line)", () => {
    const barRules = rules(BAR_CSS);
    const bar = barRules.find(({ selector }) => selector === ".bar");
    expect(bar?.body).toMatch(/flex-wrap\s*:\s*nowrap/);
    expect(barRules.find(({ selector }) => selector === ".controls")?.body).toMatch(/flex\s*:\s*0 0 auto/);
    const heading = barRules.find(({ selector }) => selector === ".heading")?.body ?? "";
    expect(heading).toMatch(/min-width\s*:\s*0/);
    expect(heading).toMatch(/white-space\s*:\s*nowrap/);
    expect(barRules.find(({ selector }) => selector === ".title")?.body).toMatch(/text-overflow\s*:\s*ellipsis/);
    // 行が増えるもの (参照元・失敗の理由) を入れる場所はバーの外。
    expect(barRules.some(({ selector }) => selector === ".details")).toBe(true);
  });
});
