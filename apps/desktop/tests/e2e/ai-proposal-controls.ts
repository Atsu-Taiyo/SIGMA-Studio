import type { Locator, Page } from "@playwright/test";

/**
 * 紙面のカードの先頭 (承認バーとすぐ下の行)。図形より上の紙面の操作の層 (`.page-controls-layer`) に
 * 描かれ、カードには同じ寸法の見えない場所取りだけが残る。カードが複数あるときは紙面の順に並ぶ。
 */
export const PAGE_PROPOSAL_CONTROLS = ".page-controls-layer > .ai-proposal-card-head";

export function pageProposalControls(page: Page): Locator {
  return page.locator(PAGE_PROPOSAL_CONTROLS);
}

/** そのカード (`[data-ai-proposal-card="page"]` かそれを含む要素) の先頭。カードが複数あるときに使う。 */
export async function cardProposalControls(page: Page, card: Locator): Promise<Locator> {
  const id = await card.locator("[data-page-control-placeholder]").first().getAttribute("data-page-control-id");
  return page.locator(`.page-controls-layer > [data-page-control-id="${id}"]`);
}
