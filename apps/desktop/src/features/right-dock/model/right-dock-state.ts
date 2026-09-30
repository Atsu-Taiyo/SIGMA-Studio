/**
 * キャンバス右の常設サイドバーの状態と遷移。React・Electron・AI に依存しない。
 *
 * サイドバーは「開いているページ」の並び (タブ列) で、「+」で開く Hub (新しいタブ) から
 * ファイル・ブラウザ・サイドチャットを選ぶ。Hub は選ぶまでの置き場で、選ぶとその場所を
 * 選んだページに置き換える。各ページの中身は持たない。
 *
 * ページの id: ファイルとサイドチャットは 1 つだけなので種類名そのもの、Hub も 1 つだけで
 * "hub"、ブラウザのページはメインプロセスのタブ id をそのまま使う (ブラウザ側が正本)。
 */

export const RIGHT_DOCK_TOOLS = ["files", "browser", "chat"] as const;
export type RightDockTool = (typeof RIGHT_DOCK_TOOLS)[number];
export type RightDockPageKind = "hub" | RightDockTool;

export interface RightDockPage {
  id: string;
  kind: RightDockPageKind;
}

export interface RightDockState {
  open: boolean;
  pages: readonly RightDockPage[];
  /** 見ているページ。ページが 1 つも無いときだけ null。 */
  activeId: string | null;
}

export const RIGHT_DOCK_MIN_WIDTH = 320;
export const RIGHT_DOCK_DEFAULT_WIDTH = 400;
export const RIGHT_DOCK_MAX_WIDTH = 720;
/** 本文を押しつぶさないよう、幅は画面のこの割合までにする。 */
export const RIGHT_DOCK_MAX_VIEWPORT_RATIO = 0.6;

export const RIGHT_DOCK_HUB_ID = "hub";

export const INITIAL_RIGHT_DOCK_STATE: RightDockState = { open: false, pages: [], activeId: null };

const HUB_PAGE: RightDockPage = { id: RIGHT_DOCK_HUB_ID, kind: "hub" };

export function activeRightDockPage(state: RightDockState): RightDockPage | null {
  return state.pages.find((page) => page.id === state.activeId) ?? null;
}

/** 変化が無いときは同じオブジェクトを返し、Reactの再描画を起こさない。 */
function commit(state: RightDockState, next: RightDockState): RightDockState {
  const samePages = state.pages === next.pages
    || (state.pages.length === next.pages.length
      && state.pages.every((page, index) => page.id === next.pages[index].id && page.kind === next.pages[index].kind));
  return samePages && state.open === next.open && state.activeId === next.activeId ? state : next;
}

/** ページが 1 つも無くなったら、サイドバーごと閉じる。 */
function settle(open: boolean, pages: readonly RightDockPage[], activeId: string | null): RightDockState {
  if (pages.length === 0) return INITIAL_RIGHT_DOCK_STATE;
  return { open, pages, activeId: pages.some((page) => page.id === activeId) ? activeId : pages[pages.length - 1].id };
}

/** 開く。ページが無ければ Hub を出し、あれば最後に見ていたページへ戻る。 */
export function openRightDock(state: RightDockState): RightDockState {
  if (state.pages.length === 0) return commit(state, { open: true, pages: [HUB_PAGE], activeId: HUB_PAGE.id });
  return commit(state, settle(true, state.pages, state.activeId));
}

export function closeRightDock(state: RightDockState): RightDockState {
  return state.open ? { ...state, open: false } : state;
}

export function toggleRightDock(state: RightDockState): RightDockState {
  return state.open ? closeRightDock(state) : openRightDock(state);
}

/** 「+」。Hub は 1 つだけで、すでにあればそこへ移る (空のタブを増やさない)。 */
export function openRightDockHub(state: RightDockState): RightDockState {
  if (state.pages.some((page) => page.id === RIGHT_DOCK_HUB_ID)) return commit(state, settle(true, state.pages, RIGHT_DOCK_HUB_ID));
  return commit(state, settle(true, [...state.pages, HUB_PAGE], HUB_PAGE.id));
}

/**
 * ページを開いて見せる。同じページがあればそこへ移り、無ければ追加する。
 * 見ているのが Hub なら、Hub の場所をそのページに置き換える (選んだら Hub は役目を終える)。
 */
export function openRightDockPage(state: RightDockState, page: RightDockPage): RightDockState {
  const viewingHub = state.activeId === RIGHT_DOCK_HUB_ID;
  const without = (pages: readonly RightDockPage[]) => pages.filter((candidate) => candidate.id !== RIGHT_DOCK_HUB_ID);
  if (state.pages.some((candidate) => candidate.id === page.id)) {
    const pages = viewingHub && page.id !== RIGHT_DOCK_HUB_ID ? without(state.pages) : state.pages;
    return commit(state, settle(true, pages, page.id));
  }
  const pages = viewingHub
    ? state.pages.map((candidate) => (candidate.id === RIGHT_DOCK_HUB_ID ? page : candidate))
    : [...state.pages, page];
  return commit(state, settle(true, pages, page.id));
}

/** ファイル・サイドチャットのページを開く。ブラウザはタブ id が要るので openRightDockPage で開く。 */
export function openRightDockTool(state: RightDockState, tool: Exclude<RightDockTool, "browser">): RightDockState {
  return openRightDockPage(state, { id: tool, kind: tool });
}

export function activateRightDockPage(state: RightDockState, id: string): RightDockState {
  if (!state.pages.some((page) => page.id === id)) return state;
  return commit(state, settle(true, state.pages, id));
}

/** 閉じたページが見ていたものなら、右隣 (無ければ左隣) のページへ移る。最後の 1 つなら、サイドバーごと閉じる。 */
export function closeRightDockPage(state: RightDockState, id: string): RightDockState {
  return removePages(state, (page) => page.id === id);
}

/** AIの面が「サイドチャットを閉じる」と言ったとき、他のページを見ているサイドバーまで閉じない。 */
export function closeRightDockToolIfShowing(state: RightDockState, tool: RightDockTool): RightDockState {
  return isRightDockShowing(state, tool) ? closeRightDockPage(state, state.activeId ?? tool) : state;
}

export function isRightDockShowing(state: RightDockState, tool: RightDockTool): boolean {
  return state.open && activeRightDockPage(state)?.kind === tool;
}

function removePages(state: RightDockState, shouldRemove: (page: RightDockPage) => boolean): RightDockState {
  const pages = state.pages.filter((page) => !shouldRemove(page));
  if (pages.length === state.pages.length) return state;
  if (pages.length === 0) return INITIAL_RIGHT_DOCK_STATE;
  const active = state.pages.findIndex((page) => page.id === state.activeId);
  if (active >= 0 && pages.some((page) => page.id === state.activeId)) return { ...state, pages };
  // 見ていたページが消えた: 元の並びで一番近い、残っているページへ (右を先に見る)。
  const remaining = new Set(pages.map((page) => page.id));
  const after = state.pages.slice(Math.max(active, 0)).find((page) => remaining.has(page.id));
  const before = state.pages.slice(0, Math.max(active, 0)).reverse().find((page) => remaining.has(page.id));
  return { ...state, pages, activeId: (after ?? before ?? pages[0]).id };
}

export interface RightDockBrowserSnapshot {
  tabIds: readonly string[];
  activeTabId: string | null;
}

/**
 * メインプロセスのブラウザのタブ一覧に、ブラウザのページを合わせる (ブラウザ側が正本)。
 * 消えたタブのページは外し、増えたタブは末尾へ足す。増えたタブへ移るのは、
 * - `adopt`: 自分で「ブラウザ」を選んだ直後 (Hub の場所をそのタブに置き換える)
 * - ブラウザのページを見ている間に、リンクなどから新しいタブが前面に開かれたとき
 * だけで、ファイルやチャットを見ている人の画面を奪わない。
 */
export function syncRightDockBrowserPages(
  state: RightDockState,
  snapshot: RightDockBrowserSnapshot,
  options: { adopt?: boolean } = {},
): RightDockState {
  const live = new Set(snapshot.tabIds);
  let next = removePages(state, (page) => page.kind === "browser" && !live.has(page.id));
  const known = new Set(next.pages.map((page) => page.id));
  const added = snapshot.tabIds.filter((id) => !known.has(id));
  if (added.length === 0) return next;

  // 前面に開かれたタブがあればそれ、無ければ最後に増えたもの。
  const foreground = snapshot.activeTabId !== null && added.includes(snapshot.activeTabId);
  const target = foreground ? snapshot.activeTabId! : added[added.length - 1];
  const watchingBrowser = activeRightDockPage(next)?.kind === "browser";
  const toPage = (id: string): RightDockPage => ({ id, kind: "browser" });
  if (options.adopt) {
    const others = added.filter((id) => id !== target).map(toPage);
    return openRightDockPage({ ...next, pages: [...next.pages, ...others] }, toPage(target));
  }
  next = { ...next, pages: [...next.pages, ...added.map(toPage)] };
  // 何も見ていなかった (ページが無かった) ときは、前面のタブから始める。
  if (next.activeId === null) return { ...next, activeId: target };
  return foreground && watchingBrowser ? { ...next, activeId: target } : next;
}

/** 矢印キーでタブを順に移る (端で循環する)。 */
export function neighborRightDockPageId(state: RightDockState, id: string, direction: 1 | -1): string | null {
  const index = state.pages.findIndex((page) => page.id === id);
  if (index < 0 || state.pages.length === 0) return null;
  return state.pages[(index + direction + state.pages.length) % state.pages.length].id;
}

export function clampRightDockWidth(width: number, viewportWidth: number): number {
  const finite = Number.isFinite(width) ? width : RIGHT_DOCK_DEFAULT_WIDTH;
  const ceiling = Math.max(
    RIGHT_DOCK_MIN_WIDTH,
    Math.min(RIGHT_DOCK_MAX_WIDTH, Math.floor((Number.isFinite(viewportWidth) ? viewportWidth : Infinity) * RIGHT_DOCK_MAX_VIEWPORT_RATIO)),
  );
  return Math.round(Math.min(ceiling, Math.max(RIGHT_DOCK_MIN_WIDTH, finite)));
}
