import { expect, type Page } from "@playwright/test";

/**
 * 2系統のエディタクローム（Googleドキュメント風 / Word風リボン）を e2e から操作・観測するための
 * 共有ヘルパ。spec ではないので Playwright には拾われない（desktop-runtime-mock.ts と同じ立ち位置）。
 *
 * ここに置く理由は「両レイアウトを **同じ関数** で観測する」こと。収集の仕方が片方だけ広い／狭いと、
 * パリティ判定は必ず緩い方へ倒れて緑になる。
 */

export const LAYOUT_STORAGE_KEY = "sigma-studio:ui-layout-preference";

export const QUICK_TOOLBAR = '.editor-menubar [data-editor-toolbar="quick"]';

/** タブ行に並ぶ全タブ（「ファイル」は Backstage を開くだけでタブパネルを持たない）。 */
export const RIBBON_TABS = ["ファイル", "ホーム", "挿入", "レイアウト", "表示"] as const;
/** リボン本体（タブパネル）を持つタブ。 */
export const PANEL_TABS = ["ホーム", "挿入", "レイアウト", "表示"] as const;
export const CONTEXTUAL_TAB = "図形の書式";

/** Backstage 左ナビの並び（ribbon-backstage.ts の BACKSTAGE_SECTIONS と同じ順）。 */
export const BACKSTAGE_SECTIONS = [
  "ホーム",
  "新規",
  "開く",
  "情報",
  "エクスポート",
  "オプション",
  "ヘルプ",
] as const;

/** docs のタイトル行にあるアプリメニュー。 */
export const APP_MENUS = ["ファイル", "挿入", "AI", "設定"] as const;

/**
 * 各タブに必ず居るコントロール。`.ribbon-body` はタブを切り替えても同じ要素なので、
 * これが出るまで待たずに収集すると **前のタブの中身** を読んでしまう。
 */
export const TAB_MARKER: Readonly<Record<string, string>> = {
  "ホーム": "太字",
  "挿入": "表",
  "レイアウト": "ページ設定",
  "表示": "アウトラインを表示",
  [CONTEXTUAL_TAB]: "枠線",
};

export function ribbonTabs(page: Page) {
  return page.getByRole("tablist", { name: "リボンタブ" });
}

/** Backstage（ファイルタブのパネル）。Word風では同名のコマンドが複数箇所に出うるので必ずスコープする。 */
export function backstage(page: Page) {
  return page.getByRole("tabpanel", { name: "ファイル" });
}

/** 設定メニューのトグルで Word風へ切り替える（docs 側の唯一の導線）。 */
export async function switchToWordLayout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Word風のリボン表示", exact: true }).click();
  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toBeVisible();
  await expect(ribbonTabs(page)).toBeVisible();
}

/** ファイルタブを押して Backstage を開く。 */
export async function openBackstage(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "ファイル", exact: true }).click();
  await expect(backstage(page)).toBeVisible();
}

/** Backstage の左ナビでセクションを開き、実際に切り替わるまで待つ。 */
export async function openBackstageSection(page: Page, sectionName: string): Promise<void> {
  const navItem = backstage(page).getByRole("button", { name: sectionName, exact: true });
  await navItem.click();
  await expect(navItem).toHaveAttribute("aria-current", "page");
}

/** Backstage の「オプション」から Googleドキュメント風へ戻す（Word風側の唯一の導線）。 */
export async function switchToDocsLayout(page: Page): Promise<void> {
  await openBackstage(page);
  await openBackstageSection(page, "オプション");
  await backstage(page).getByRole("button", { name: "Word風のリボン表示", exact: true }).click();
  await expect(page.locator(QUICK_TOOLBAR)).toHaveCount(1);
}

/** タブを開き、そのタブの中身が実際に描かれるまで待つ。 */
export async function openRibbonTab(page: Page, tabName: string): Promise<void> {
  await page.getByRole("tab", { name: tabName, exact: true }).click();
  await expect(page.getByRole("tab", { name: tabName, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator(".ribbon-body").getByRole("button", { name: TAB_MARKER[tabName], exact: true }),
  ).toBeVisible();
}

/** コマンド名 → 有効な置き場所が1つでもあるか。 */
export type CommandIndex = Map<string, boolean>;

export function addCommand(index: CommandIndex, name: string, enabled: boolean): void {
  if (name.length === 0) {
    return;
  }
  index.set(name, (index.get(name) ?? false) || enabled);
}

/**
 * スコープ内のコントロールを「アクセシブル名 + 有効か」で拾う。
 * docs 側とリボン側で同じセレクタ・同じ判定を使う（片方だけ狭いと、緩い方向へ倒れる）。
 */
export async function collectControls(
  page: Page,
  scope: string,
): Promise<Array<{ label: string; enabled: boolean }>> {
  // $eval は複数マッチでも黙って先頭を使うので、スコープが1つであることを先に固定する。
  await expect(page.locator(scope)).toHaveCount(1);
  return page.$eval(scope, (root) => {
    // スコープ自身がコントロールのこともある（`.report-issue-button` は button そのもの）。
    // querySelectorAll は子孫しか見ないので、root を明示的に足さないとその1個が
    // 丸ごと集合から抜ける — 片方向の検査では気づけず、逆方向で「word にしか無い」と
    // 誤って報告される。
    const controls = [root, ...root.querySelectorAll("button, select, input")]
      .filter((element): element is Element => element instanceof Element
        && ["BUTTON", "SELECT", "INPUT"].includes(element.tagName));
    return controls
      // 見えていないコントロールは «到達できる» と数えない。レスポンシブでグループごと
      // 隠れた場合に「実際には押せないのに緑」になるのを防ぐ（この spec は 1400x900 の
      // 1 サイズでしか回らないので、いまは効いていない安全弁）。
      .filter((element) => element.checkVisibility())
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? "",
        enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
      }))
      .filter((entry) => entry.label.length > 0);
  });
}

/**
 * メニュー項目を「表示テキスト + 有効か」で拾う。docs のアプリメニューの項目は
 * aria-label を持たずテキストだけなので、collectControls では拾えない。
 * ショートカット表記(<kbd>)だけを外して全文を読む（先頭 span だけだと、チェック印の
 * 有無でラベルが空文字になる項目がある）。
 */
async function collectMenuItems(
  page: Page,
  scope: string,
): Promise<Array<{ label: string; enabled: boolean }>> {
  const items = await page.locator(scope)
    .locator('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')
    .evaluateAll((elements) => elements.map((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      for (const shortcut of clone.querySelectorAll("kbd")) {
        shortcut.remove();
      }
      return {
        label: (clone.textContent ?? "").trim(),
        enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
      };
    }));
  // 名前の読めない項目は addCommand が黙って捨てるので、ここで落とす。
  // アイコンのみになった項目・テキストを <kbd> で包んだ項目が «集合から消えただけ» で
  // 緑になるのを防ぐ（片方のレイアウトの置き場所が失われても気づけなくなる）。
  for (const item of items) {
    expect(item.label, `${scope} に名前の読めないメニュー項目がある`).not.toBe("");
  }
  return items;
}

/**
 * アクセシブル名から「現在の状態」だけを落とし、コマンド名は全文を残す。
 * 例: 「線種（現在: 実線）」→ 線種 /「フォント: 標準ゴシック」→ フォント。
 * 「インポート（JSON / TeX）」のように名前の一部である括弧は **落とさない** —
 * 前方一致にすると別物（例: インポート（JSONのみ））でも満たされてしまう。
 * docs 側は無選択、Word風は図形選択中に読むので、状態語だけは必ず落とす。
 * 制約:
 * - コロン以降を落とすので、名前自体にコロンを含むコマンドを足すときはここを見直すこと
 *   （現状コロンを含むのは「フォント:」「行間:」「文字揃え:」の状態表記だけ）。
 * - **状態で名前そのものが入れ替わるコントロールは正規化できない**（`囲み文字を適用`⇄
 *   `囲み文字を解除`、`置換を開く`⇄`置換を閉じる`）。いまは docs 側も word 側も
 *   これらを既定状態のまま読むので一致するが、どちらかの巡回でその状態を変えると
 *   «同じコントロールが別コマンドに見える» 偽の赤になる。巡回に操作を足すときは注意。
 */
export function commandName(label: string): string {
  return label
    .replace(/[（(]現在[:：][^）)]*[）)]/gu, "")
    .replace(/[:：]\s*\S.*$/u, "")
    .replace(/\s*\d+(\.\d+)?px$/u, "")
    .trim();
}

/**
 * 図形の選択を外す。図形から離れた紙面上をクリックする（本文にキャレットが立ち、
 * 図形の選択は解除される = overlay-shape-hit-precision.spec.ts と同じ挙動）。
 * クリック点は図形の実測位置から作る（固定オフセットだと、クローム高さやズームが
 * 変わった日に画面外や別要素を押して、無関係な失敗に化ける）。
 */
export async function clearShapeSelection(page: Page): Promise<void> {
  const canvas = await page.locator(".overlay-canvas-editor").first().boundingBox();
  const shape = await page.locator(".overlay-shape.selected").first().boundingBox();
  const viewport = page.viewportSize();
  expect(canvas).not.toBeNull();
  expect(shape).not.toBeNull();
  expect(viewport).not.toBeNull();
  const x = Math.min(shape!.x + shape!.width + 80, canvas!.x + canvas!.width - 16, viewport!.width - 16);
  const y = Math.min(shape!.y + shape!.height / 2, canvas!.y + canvas!.height - 16, viewport!.height - 16);
  // 選んだ点が図形の外・キャンバスの中であることを確かめてから押す。
  expect(x).toBeGreaterThan(shape!.x + shape!.width);
  expect(x).toBeGreaterThan(canvas!.x);
  expect(y).toBeGreaterThan(canvas!.y);
  await page.mouse.click(x, y);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
}

/** 四角形を1つ描く（コンテキストタブ・図形スタイルのコントロールを出すため）。 */
export async function insertSquare(page: Page): Promise<void> {
  await page.getByRole("button", { name: "図形", exact: true }).click();
  // タブ切替直後はリボン本体が作り直される。メニューが開いたことを確かめてから選ぶ
  // （確かめずに進むと、開く前のクリックが空振りして挿入モードに入らないことがある）。
  const shapeMenu = page.getByRole("menu");
  await expect(shapeMenu).toBeVisible();
  await shapeMenu.getByRole("menuitem", { name: "四角形", exact: true }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + 100;
  const y = box!.y + 120;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
}

/**
 * Googleドキュメント風クロームから到達できるコマンドを全部集める。
 *
 * 常設面（1段ツールバー / 右上アクション / 問題を報告 / タイトル行）に加えて、
 * **開かないと見えない面**（4つのアプリメニュー・エクスポートのサブメニュー・
 * 新規教材のホバーメニュー）も開いて読む。開かずに済ませると、そこにしか無い
 * コマンドが「docs に無い」と誤読され、Word風にだけ在る扱いになってしまう。
 */
export async function collectDocsCommands(page: Page): Promise<CommandIndex> {
  const commands: CommandIndex = new Map();

  const collectPersistentSurfaces = async () => {
    for (const scope of [
      QUICK_TOOLBAR,
      ".menubar-right-actions",
      ".report-issue-button",
      ".document-title-row",
      // Word風では QAT の中に入っている面。docs では `.menubar-row` 直下の兄弟なので
      // どのスコープにも入っておらず、ここを外すと «word だけが読める面» になる。
      ".save-state-wrap",
    ]) {
      for (const control of await collectControls(page, scope)) {
        addCommand(commands, commandName(control.label), control.enabled);
      }
    }
  };

  await collectPersistentSurfaces();

  for (const menuName of APP_MENUS) {
    await page.locator(".app-menu-list").getByRole("button", { name: menuName, exact: true }).click();
    const menu = page.getByRole("menu", { name: menuName });
    await expect(menu).toBeVisible();
    for (const item of await collectMenuItems(page, `[role="menu"][aria-label="${menuName}"]`)) {
      addCommand(commands, commandName(item.label), item.enabled);
    }
    if (menuName === "ファイル") {
      // エクスポートの子（JSON / PDF）は同じポップオーバーの中に **インラインで存在** し、
      // CSS の display:none で隠れているだけなので、上のファイルメニューの走査で既に
      // 読めている（evaluateAll は可視性で絞らない）。それでもここで開くのは、将来
      // このサブメニューが portal 型のポップオーバーに変わったときに **黙って集合から
      // 落ちない** ようにするため。
      await menu.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
      const submenu = page.getByRole("menu", { name: "エクスポート" });
      await expect(submenu.getByRole("menuitem", { name: "JSONをエクスポート", exact: true })).toBeVisible();
      for (const item of await collectMenuItems(page, '[role="menu"][aria-label="エクスポート"]')) {
        addCommand(commands, commandName(item.label), item.enabled);
      }
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  // 「新規教材」はホバーで開くメニュー。中身（空の教材 / テンプレートから追加）は
  // Word風では Backstage の「新規」にそのまま在る。
  await page.locator(".document-tab-action-hover").hover();
  const newDocMenu = page.getByRole("menu", { name: "新規教材" });
  await expect(newDocMenu).toBeVisible();
  for (const item of await collectMenuItems(page, '[role="menu"][aria-label="新規教材"]')) {
    addCommand(commands, commandName(item.label), item.enabled);
  }
  // ホバーで開くメニューなので Escape では閉じない。ポインタを離して閉じるのを待つ。
  await page.mouse.move(0, 0);
  await expect(newDocMenu).toHaveCount(0);

  // 図形スタイル・書式のコントロールは無選択では disabled。選択中の状態でも集めないと、
  // 「docs で有効」の集合からごっそり抜け落ち、リボン側の disabled を検出できなくなる。
  await insertSquare(page);
  await collectPersistentSurfaces();
  await clearShapeSelection(page);

  return commands;
}

/**
 * Word風リボンクロームから到達できるコマンドを全部集める。
 *
 * リボン本体だけでは足りない — QAT・タイトル行右端・タブ行右端・Backstage の全セクション・
 * ステータスバーは本体の外にある。どれか1つでも入れ忘れると、そこにしか無いコマンドが
 * 「Word風に無い」と誤読される。
 */
export async function collectWordCommands(page: Page): Promise<CommandIndex> {
  const commands: CommandIndex = new Map();

  const collectScopes = async (scopes: readonly string[]) => {
    for (const scope of scopes) {
      for (const control of await collectControls(page, scope)) {
        addCommand(commands, commandName(control.label), control.enabled);
      }
    }
  };
  const collectChrome = async () => collectScopes([
    ".ribbon-qat",
    ".ribbon-titlebar-actions",
    ".ribbon-tab-actions",
    ".ribbon-statusbar",
    ".document-title-row",
  ]);
  const collectBody = async () => collectScopes([".ribbon-body"]);

  await collectChrome();
  for (const tabName of PANEL_TABS) {
    await openRibbonTab(page, tabName);
    await collectBody();
  }

  // ファイルタブはリボン本体ではなく Backstage を開く。設定・ワークスペース・
  // 新規/開く・エクスポート・ヘルプはそこにしか無いので、全セクションを巡る。
  await openBackstage(page);
  for (const sectionName of BACKSTAGE_SECTIONS) {
    await openBackstageSection(page, sectionName);
    // 左ナビ (`.ribbon-backstage-nav`) は **コマンドではなくセクション切替** なので
    // 内容側 (`.ribbon-backstage-pane`) だけを読む。ナビまで集合へ入れると、
    // 「ホーム」「新規」「開く」「情報」「オプション」「ヘルプ」「戻る」を許容リストへ
    // 入れる羽目になり、**同じ名前を持つ本物の Word風専用コマンドが永久に免除される**。
    // ナビの項目名そのものは ui-layout-ribbon.spec.ts が別途固定している。
    await collectScopes([".ribbon-backstage-pane"]);
  }
  await page.keyboard.press("Escape");
  await expect(backstage(page)).toHaveCount(0);

  // 図形を選ぶと現れる/消えるコマンドがあるので、選択中の状態でももう一巡する
  // （検索置換は docs 側と同じ条件で消えるため、無選択で集めた分と合わせて評価する）。
  await openRibbonTab(page, "挿入");
  await insertSquare(page);
  await collectChrome();
  for (const tabName of [...PANEL_TABS, CONTEXTUAL_TAB]) {
    await openRibbonTab(page, tabName);
    await collectBody();
  }
  await clearShapeSelection(page);

  return commands;
}
