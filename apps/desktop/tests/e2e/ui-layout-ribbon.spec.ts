import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOption } from "./ui-select";
import {
  BACKSTAGE_SECTIONS,
  CONTEXTUAL_TAB,
  LAYOUT_STORAGE_KEY,
  QUICK_TOOLBAR,
  RIBBON_TABS,
  backstage,
  clearShapeSelection,
  insertSquare,
  openBackstage,
  openBackstageSection,
  openRibbonTab,
  ribbonTabs,
  switchToDocsLayout,
  switchToWordLayout,
} from "./ui-layout-chrome";

/**
 * Word風リボンクロームの **挙動** の回帰テスト。
 *
 * レイアウトの切り替えは必ずUI操作で行う（localStorageを直接書かない）。切り替えそのものが
 * 被験対象で、seedして起動すると「トグルは壊れているがリボンは出る」状態を緑にしてしまう。
 *
 * 役割分担:
 * - 両レイアウトの **コマンド集合** が一致するか  → ui-layout-parity.spec.ts
 * - docs 側の DOM 署名                            → editor-chrome-signature.spec.ts
 * - ここ: タブ操作・Backstage・タイトル行・2段リボン・折りたたみ・ステータスバー・高さ
 *
 * 共有の操作/収集ヘルパは ui-layout-chrome.ts にある（パリティ spec と **同じ関数** を使う）。
 */

/**
 * クローム高さトークンの期待値。
 * docs = メニューバー行 + ツールバー行 `calc(74px + 42px)`（globals.css）、
 * word = メニューバー行 + タブ行 + リボン本体 `calc(74px + 32px + 98px)`（ribbon-chrome.css）、
 * word 折りたたみ時 = メニューバー行 + タブ行 `calc(74px + 32px)`。
 */
const CHROME_HEIGHT_PX: Readonly<Record<"docs" | "word" | "wordCollapsed", number>> = {
  docs: 116,
  word: 204,
  wordCollapsed: 106,
};

/** Word風のステータスバーの高さ（ribbon-chrome.css の --editor-statusbar-height）。 */
const STATUS_BAR_HEIGHT_PX = 26;

/**
 * 各セクションにラベル付きで並ぶコマンド（= docs 側と1文字も違わない名前）。
 * ここが「Word風では設定・ワークスペース・新規/開くの動線が消えた」の修復点なので、
 * 名前を丸ごと固定して、アイコンのみへ戻る退行を落とす。
 */
const BACKSTAGE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "ホーム": ["ワークスペース", "教材一覧"],
  "新規": ["空の教材", "テンプレートから追加"],
  "開く": ["教材一覧", "ワークスペース", "インポート（JSON / TeX）", "他の形式をインポート", "テキストから読み込み"],
  "情報": ["バージョン履歴", "現在の教材を複製", "現在の教材を削除"],
  "エクスポート": ["JSONをエクスポート", "PDFを書き出し", "テキストでコピー"],
  "オプション": [
    "アプリ設定",
    "ショートカット設定",
    "数式コマンド確認",
    "TeX環境設定",
    "ページ設定",
    "Word風のリボン表示",
    "UIの選択画面を再表示",
  ],
  "ヘルプ": ["問題を報告"],
};


/** 段落を1つ選び、その中の文字範囲を選択する。 */
async function selectParagraphText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // running region (ヘッダー/フッター) も同じ .text-flow-editor を使うので本文だけに絞る。
    const block = Array.from(document.querySelectorAll<HTMLElement>(".text-flow-editor p[data-sigma-doc-id]"))
      .filter((element) => !element.closest(".page-running-region"))
      .find((element) => (element.textContent ?? "").trim().length >= 4);
    const editor = block?.closest<HTMLElement>(".text-flow-editor");
    const selection = window.getSelection();
    if (!block || !editor || !selection) {
      throw new Error("selectable paragraph not found");
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode() as Text | null;
    if (!textNode || (textNode.textContent ?? "").length < 4) {
      throw new Error("paragraph has no text run to select");
    }
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    selection.removeAllRanges();
    selection.addRange(range);
    return block.dataset.sigmaDocId ?? "";
  });
}

/** 保存済みSigmaDocの当該ブロックに bold マークが入ったか。 */
async function savedBlockHasBold(page: Page, blockId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return false;
    }
    const stack: unknown[] = [JSON.parse(raw)];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!node || typeof node !== "object") {
        continue;
      }
      const record = node as Record<string, unknown>;
      if (record.id === id) {
        return JSON.stringify(record).includes('"bold"');
      }
      stack.push(...Object.values(record));
    }
    return false;
  }, blockId);
}

test.beforeEach(async ({ page }) => {
  // 既定（Googleドキュメント風）で起動する。切り替えは各テストがUIから行う。
  // preserveStorageKeys はモックの都合: 毎ロードで localStorage を wipe して uiLayout を
  // 再 seed するため、これが無いとリロードを挟むテストがアプリ側の永続化バグと
  // 区別できなくなる（新しいコンテキストでは preserve 対象が空なので初回は seed が勝つ）。
  await installDesktopRuntimeMock(page, sampleDocument, {
    uiLayout: { mode: "docs" },
    preserveStorageKeys: [LAYOUT_STORAGE_KEY],
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
});

const WORD_ONLY_CHROME = [".ribbon-qat", ".ribbon-titlebar-actions", ".ribbon-tab-actions", ".ribbon-tabs-row"] as const;

test("the settings toggle swaps the single toolbar row for the ribbon and back", async ({ page }) => {
  await expect(page.locator(QUICK_TOOLBAR)).toHaveCount(1);
  await expect(ribbonTabs(page)).toHaveCount(0);
  // Word風固有のクロームは docs では1つも作らない (element ツリーごと作らない)。
  for (const scope of WORD_ONLY_CHROME) {
    await expect(page.locator(scope)).toHaveCount(0);
  }

  await switchToWordLayout(page);

  // 1段ツールバーは消え、タブバーとリボン本体に置き換わる。
  await expect(page.locator(QUICK_TOOLBAR)).toHaveCount(0);
  await expect(page.locator(".ribbon-body")).toHaveCount(1);
  await expect(ribbonTabs(page).getByRole("tab")).toHaveText([...RIBBON_TABS]);
  // 教材タブ（別のtablist）を巻き込んでいないこと。
  await expect(page.getByRole("tablist", { name: "教材タブ" })).toHaveCount(1);

  for (const scope of WORD_ONLY_CHROME) {
    await expect(page.locator(scope)).toHaveCount(1);
  }

  await switchToDocsLayout(page);

  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toHaveCount(0);
  await expect(ribbonTabs(page)).toHaveCount(0);
  for (const scope of WORD_ONLY_CHROME) {
    await expect(page.locator(scope)).toHaveCount(0);
  }
  await expect(page.locator(QUICK_TOOLBAR)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "設定", exact: true })).toBeVisible();
});

test("arrow keys move the ribbon tab selection", async ({ page }) => {
  await switchToWordLayout(page);

  const home = page.getByRole("tab", { name: "ホーム", exact: true });
  await expect(home).toHaveAttribute("aria-selected", "true");
  await home.focus();

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "挿入", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(home).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "レイアウト", exact: true })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "挿入", exact: true })).toHaveAttribute("aria-selected", "true");
  // 表示中のリボン本体も追従する（aria-selectedだけ動くのでは意味がない）。
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "本文", exact: true })).toBeVisible();
});

test("bold from the home tab reaches the saved SigmaDoc", async ({ page }) => {
  await switchToWordLayout(page);

  const blockId = await selectParagraphText(page);
  expect(blockId).not.toBe("");

  const bold = page.locator(".ribbon-body").getByRole("button", { name: "太字", exact: true });
  // 選択が本文に載っていればボタンは有効になる（disabled でも aria-pressed は false なので、
  // それだけでは「選べている」ことの証明にならない）。
  await expect(bold).toBeEnabled();
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  // 押す前は bold が無いことを固定する。これが無いと、教材側に元から bold があった日に
  // 「押したから付いた」と「元から在った」を見分けられなくなる。
  expect(await savedBlockHasBold(page, blockId)).toBe(false);
  await bold.click();

  await expect(page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"] strong`).first()).toBeVisible();
  await expect.poll(() => savedBlockHasBold(page, blockId)).toBe(true);
});

test("the insert tab can add a table", async ({ page }) => {
  await switchToWordLayout(page);

  await openRibbonTab(page, "挿入");
  await page.locator(".ribbon-body").getByRole("button", { name: "表", exact: true }).click();

  const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(tablePicker).toBeVisible();
  await tablePicker.getByRole("button", { name: "3列 2行の表を挿入" }).click();

  const tableShape = page.locator(".overlay-shape-tableShape");
  await expect(tableShape).toHaveCount(1);
  await expect(tableShape.locator("td")).toHaveCount(6);
});

test("the shape format tab appears with a selection and disappears with it", async ({ page }) => {
  await switchToWordLayout(page);

  const contextual = page.getByRole("tab", { name: CONTEXTUAL_TAB, exact: true });
  await expect(contextual).toHaveCount(0);

  await openRibbonTab(page, "挿入");
  await insertSquare(page);

  // 現れた瞬間にそこへ切り替わる（Word 365と同じ）。
  await expect(contextual).toBeVisible();
  await expect(contextual).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "枠線", exact: true })).toBeVisible();

  // 選択解除でタブごと消え、直前に自分で選んだタブ（挿入）へ戻る。
  await clearShapeSelection(page);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
  await expect(contextual).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "挿入", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("the chrome height token really holds the chrome in both layouts", async ({ page }) => {
  // design-rules.md の「高さは --editor-chrome-height で管理し、calc(100vh - …) に生pxを書かない」を
  // 実測で固定する。`.editor-menubar` は `.app-shell` の固定トラックの中身なので、**描画された
  // 高さはトークンと必ず一致してしまう**（それを比べても何も証明しない）。中身が本当に
  // そのトークンへ収まっているか（= scrollHeight がはみ出していないか）と、本文キャンバスが
  // その真下から始まっているかを見る。
  const measureStatusBar = async () => page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const workspace = document.querySelector("main.workspace");
    if (!shell || !workspace) {
      throw new Error("shell geometry not found");
    }
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:var(--editor-statusbar-height)";
    shell.append(probe);
    const token = probe.getBoundingClientRect().height;
    probe.remove();
    const statusBar = document.querySelector(".ribbon-statusbar");
    return {
      token,
      count: document.querySelectorAll(".ribbon-statusbar").length,
      // トラックは固定長なので、中身がはみ出しても .workspace の上へ «上向きに» 溢れる。
      // 外側の scrollHeight では見えないので、帯そのものの中身を測る。
      statusBarContentHeight: statusBar ? statusBar.scrollHeight : null,
      statusBarHeight: statusBar ? statusBar.getBoundingClientRect().height : null,
      statusBarTop: statusBar ? statusBar.getBoundingClientRect().top : null,
      statusBarBottom: statusBar ? statusBar.getBoundingClientRect().bottom : null,
      workspaceBottom: workspace.getBoundingClientRect().bottom,
      // ページ全体がはみ出していない（トークンを足したのに消費点を直し忘れると縦に伸びる）。
      documentScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });

  const measure = async () => page.evaluate(() => {
    // Word風の上書きは `.app-shell[data-ui-layout="word"]` に載っているので、
    // 測るプローブも .app-shell の中に置く（body直下だと :root の既定値しか読めない）。
    const shell = document.querySelector(".app-shell");
    const chrome = document.querySelector(".editor-menubar");
    const workspace = document.querySelector("main.workspace");
    if (!shell || !chrome || !workspace) {
      throw new Error("chrome geometry not found");
    }
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:var(--editor-chrome-height)";
    shell.append(probe);
    const token = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      token,
      chromeHeight: chrome.getBoundingClientRect().height,
      chromeContentHeight: chrome.scrollHeight,
      chromeBottom: chrome.getBoundingClientRect().bottom,
      workspaceTop: workspace.getBoundingClientRect().top,
    };
  });

  /**
   * グループの中身が自分のトラックに収まっているか。
   *
   * `.editor-menubar` の scrollHeight ではこれを見られない — `.ribbon-body` が
   * `overflow-y: hidden` なので、**中の**はみ出しは外へ伝わらず scrollHeight は
   * トークンのままになる。段数を増やしてトークンを直し忘れても緑になってしまうので、
   * 段の下端と見出しの上端を直接比べる。
   */
  const assertGroupsFitTheirTrack = async () => {
    const groups = await page.$$eval(".ribbon-body .ribbon-group", (elements) => {
      const body = elements[0]?.closest(".ribbon-body");
      const bodyTop = body ? body.getBoundingClientRect().top : 0;
      return elements.map((group) => {
        const rows = Array.from(group.querySelectorAll(".ribbon-group-row"));
        const label = group.querySelector(".ribbon-group-label");
        const lastRow = rows.at(-1);
        return {
          key: (group as HTMLElement).dataset.group ?? "",
          // 1段目の上端が本体の上端から何px下がっているか。トラックが足りないと
          // ここが 0-1px に潰れ、ボタンがタブ行の縁に接する。
          firstRowGap: rows[0] ? Math.round(rows[0].getBoundingClientRect().top - bodyTop) : null,
          // 最終段の下端と見出しの間。足りないと見出しへ食い込む。
          lastRowToLabel: lastRow && label
            ? Math.round(label.getBoundingClientRect().top - lastRow.getBoundingClientRect().bottom)
            : null,
        };
      });
    });
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      if (group.firstRowGap !== null) {
        expect(group.firstRowGap, `${group.key} の1段目が本体の上端に接している`).toBeGreaterThanOrEqual(3);
      }
      if (group.lastRowToLabel !== null) {
        expect(group.lastRowToLabel, `${group.key} の最終段が見出しに食い込んでいる`).toBeGreaterThanOrEqual(3);
      }
    }
  };

  const assertChromeFitsToken = (geometry: Awaited<ReturnType<typeof measure>>, expected: number) => {
    expect(geometry.token).toBe(expected);
    // トークンの示す高さに中身が収まっている（行構成を足したのにトークンを直し忘れると崩れる）。
    expect(geometry.chromeContentHeight).toBeLessThanOrEqual(geometry.token + 1);
    expect(geometry.chromeHeight).toBe(geometry.token);
    // 本文キャンバスがクロームの真下から始まる（隙間も食い込みも無い）。
    expect(Math.abs(geometry.workspaceTop - geometry.chromeBottom)).toBeLessThanOrEqual(1);
  };

  assertChromeFitsToken(await measure(), CHROME_HEIGHT_PX.docs);
  // docs にステータスバーは無く、トークンは 0 なので既存の高さ計算は一切動かない。
  const docsStatusBar = await measureStatusBar();
  expect(docsStatusBar.count).toBe(0);
  expect(docsStatusBar.token).toBe(0);
  expect(docsStatusBar.documentScrollHeight).toBeLessThanOrEqual(docsStatusBar.innerHeight + 1);

  await switchToWordLayout(page);
  await openRibbonTab(page, "ホーム");

  assertChromeFitsToken(await measure(), CHROME_HEIGHT_PX.word);
  await assertGroupsFitTheirTrack();
  // 2段のタブでも収まっていること（段数の多いタブほど厳しい）。
  for (const tabName of ["挿入", "レイアウト", "表示"]) {
    await openRibbonTab(page, tabName);
    await assertGroupsFitTheirTrack();
  }
  await openRibbonTab(page, "ホーム");

  // word ではステータスバーが画面下端に出て、本文キャンバスがその真上で終わる。
  const wordStatusBar = await measureStatusBar();
  expect(wordStatusBar.count).toBe(1);
  expect(wordStatusBar.token).toBe(STATUS_BAR_HEIGHT_PX);
  expect(wordStatusBar.statusBarHeight).toBe(STATUS_BAR_HEIGHT_PX);
  // 帯の中身が帯に収まっている（コントロールを足して縮め忘れると上へ溢れる）。
  expect(wordStatusBar.statusBarContentHeight).toBeLessThanOrEqual(STATUS_BAR_HEIGHT_PX + 1);
  expect(Math.abs(wordStatusBar.workspaceBottom - wordStatusBar.statusBarTop!)).toBeLessThanOrEqual(1);
  expect(Math.abs(wordStatusBar.statusBarBottom! - wordStatusBar.innerHeight)).toBeLessThanOrEqual(1);
  expect(wordStatusBar.documentScrollHeight).toBeLessThanOrEqual(wordStatusBar.innerHeight + 1);

  // 折りたたむとクロームはタブ行までになる。トークンと実寸が同時に縮み、
  // 本文キャンバスがその真下から始まること。
  await page.getByRole("button", { name: "リボンを折りたたむ", exact: true }).click();
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  assertChromeFitsToken(await measure(), CHROME_HEIGHT_PX.wordCollapsed);
  // 折りたたんでもステータスバーは残り、本文はその真上で終わる。
  const collapsedStatusBar = await measureStatusBar();
  expect(collapsedStatusBar.count).toBe(1);
  expect(Math.abs(collapsedStatusBar.workspaceBottom - collapsedStatusBar.statusBarTop!)).toBeLessThanOrEqual(1);
  expect(collapsedStatusBar.documentScrollHeight).toBeLessThanOrEqual(collapsedStatusBar.innerHeight + 1);

  // 浮かせている間はトークンも本文の位置も動かさない。
  // ここで assertChromeFitsToken は使えない — 浮かせた本体は position: absolute で
  // クロームの外へはみ出す «のが仕様» なので、scrollHeight はトークンを超える。
  const collapsedGeometry = await measure();
  await page.getByRole("tab", { name: "ホーム", exact: true }).click();
  await expect(page.locator(".ribbon-body.is-overlay")).toBeVisible();
  const overlayGeometry = await measure();
  expect(overlayGeometry.token).toBe(CHROME_HEIGHT_PX.wordCollapsed);
  expect(overlayGeometry.chromeHeight).toBe(CHROME_HEIGHT_PX.wordCollapsed);
  expect(overlayGeometry.workspaceTop).toBe(collapsedGeometry.workspaceTop);
});

test("the file tab opens a labelled Backstage over the editor", async ({ page }) => {
  await switchToWordLayout(page);

  await expect(page.locator(".ribbon-body")).toHaveCount(1);
  await openBackstage(page);

  // Backstage は編集画面を覆い、リボン本体は消える（Word と同じ）。
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "ファイル", exact: true })).toHaveAttribute("aria-selected", "true");
  // 本文キャンバスを丸ごと覆う。
  const panelBox = await backstage(page).boundingBox();
  const workspaceBox = await page.locator("main.workspace").boundingBox();
  expect(panelBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(panelBox!.x).toBeLessThanOrEqual(workspaceBox!.x);
  expect(panelBox!.y).toBeLessThanOrEqual(workspaceBox!.y);
  expect(panelBox!.x + panelBox!.width).toBeGreaterThanOrEqual(workspaceBox!.x + workspaceBox!.width);
  expect(panelBox!.y + panelBox!.height).toBeGreaterThanOrEqual(workspaceBox!.y + workspaceBox!.height);
  // ただしタブ行は覆わない（覆うとファイルタブを押し直して閉じられない）。
  const fileTabBox = await page.getByRole("tab", { name: "ファイル", exact: true }).boundingBox();
  expect(fileTabBox).not.toBeNull();
  expect(fileTabBox!.y + fileTabBox!.height).toBeLessThanOrEqual(panelBox!.y + 1);

  // 左ナビの項目名が「文字で」読める（アイコンのみのボタンへ戻る退行を落とす）。
  await expect(backstage(page).locator(".ribbon-backstage-nav-item")).toHaveText([...BACKSTAGE_SECTIONS]);
  await expect(backstage(page).getByRole("button", { name: "戻る", exact: true })).toBeVisible();

  // 820px 以下ではクロームの行が auto になる（globals.css / ribbon-chrome.css の
  // 同じブレークポイント）。Backstage の上端を px で決め打つとここでタブ行へ
  // 食い込み、ファイルタブが押せなくなる（実測で踏んだ）。
  await page.setViewportSize({ width: 800, height: 900 });
  const narrowFileTab = await page.getByRole("tab", { name: "ファイル", exact: true }).boundingBox();
  const narrowPanel = await backstage(page).boundingBox();
  expect(narrowFileTab).not.toBeNull();
  expect(narrowPanel).not.toBeNull();
  expect(narrowFileTab!.y + narrowFileTab!.height).toBeLessThanOrEqual(narrowPanel!.y + 1);
  // タブを押し直して閉じられること（pointer が Backstage に食われない）。
  await page.getByRole("tab", { name: "ファイル", exact: true }).click();
  await expect(backstage(page)).toHaveCount(0);
});

test("every Backstage section lists its commands with a text label", async ({ page }) => {
  test.slow();
  await switchToWordLayout(page);
  await openBackstage(page);

  for (const sectionName of BACKSTAGE_SECTIONS) {
    await openBackstageSection(page, sectionName);
    const pane = backstage(page).locator(".ribbon-backstage-pane");
    for (const command of BACKSTAGE_COMMANDS[sectionName]) {
      const button = pane.getByRole("button", { name: command, exact: true });
      await expect(button).toBeVisible();
      // ラベルは文字として読めること（aria-label だけのアイコンボタンでは通らない）。
      await expect(button).toContainText(command);
      // 「現在の教材を削除」は教材が1つしかない e2e 環境では docs 側でも無効。
      if (command !== "現在の教材を削除") {
        await expect(button).toBeEnabled();
      }
    }
  }
});

test("Escape, the back arrow and the file tab all close the Backstage back to the last tab", async ({ page }) => {
  await switchToWordLayout(page);
  // 「直前に自分で選んだタブ」を ホーム 以外にしておく（既定に戻っただけ、と区別する）。
  await openRibbonTab(page, "挿入");

  const insertTab = page.getByRole("tab", { name: "挿入", exact: true });

  await openBackstage(page);
  await expect(insertTab).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(backstage(page)).toHaveCount(0);
  await expect(insertTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "本文", exact: true })).toBeVisible();

  await openBackstage(page);
  await backstage(page).getByRole("button", { name: "戻る", exact: true }).click();
  await expect(backstage(page)).toHaveCount(0);
  await expect(insertTab).toHaveAttribute("aria-selected", "true");

  await openBackstage(page);
  await page.getByRole("tab", { name: "ファイル", exact: true }).click();
  await expect(backstage(page)).toHaveCount(0);
  await expect(insertTab).toHaveAttribute("aria-selected", "true");

  // 開き直すと必ずホームセクションから（前回のセクションを引きずらない）。
  await openBackstage(page);
  await openBackstageSection(page, "オプション");
  await page.keyboard.press("Escape");
  await openBackstage(page);
  await expect(backstage(page).getByRole("button", { name: "ホーム", exact: true })).toHaveAttribute("aria-current", "page");

  // 別のリボンタブを押しても閉じてそのタブが開く（Word と同じ）。閉じないと
  // タブ行だけが反応しない行き止まりになる。
  await page.getByRole("tab", { name: "レイアウト", exact: true }).click();
  await expect(backstage(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "レイアウト", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "ページ設定", exact: true })).toBeVisible();
});

test("a Backstage command closes the Backstage before it runs", async ({ page }) => {
  await switchToWordLayout(page);
  await openBackstage(page);
  await openBackstageSection(page, "オプション");
  await backstage(page).getByRole("button", { name: "ページ設定", exact: true }).click();

  await expect(page.getByRole("dialog", { name: "ページ設定" })).toBeVisible();
  // 開いたままだと、ダイアログを Esc で閉じた先に忘れられた全画面が残る。
  await expect(backstage(page)).toHaveCount(0);
});

test("keys do not reach the document while the Backstage covers it", async ({ page }) => {
  await switchToWordLayout(page);
  await openRibbonTab(page, "挿入");
  await insertSquare(page);
  const shapes = page.locator(".overlay-shape[data-overlay-shape-id]");
  await expect(shapes).toHaveCount(1);

  await openBackstage(page);
  // フォーカスは Backstage の中にある（本文にキャレットが残っていない）。
  const focusedInsideBackstage = await page.evaluate(() =>
    Boolean(document.activeElement?.closest(".ribbon-backstage")));
  expect(focusedInsideBackstage).toBe(true);

  // Delete は overlay の window リスナー（bubble）まで降りない。
  await page.keyboard.press("Delete");
  await expect(shapes).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(shapes).toHaveCount(1);

  // 本文側が window の **capture** に張っているショートカット (⌃/⌘+Alt+T =
  // カーソル位置にテキスト図形) も届かない。capture の stopPropagation は同じ
  // window に付いた別の capture リスナーを止められず、inert も window レベルには
  // 効かないので、ここが素通りしていると覆われた本文に図形が生える。
  await page.keyboard.press("Control+Alt+KeyT");
  await expect(shapes).toHaveCount(1);
  await expect(page.locator(".overlay-canvas-editor.editing")).toHaveCount(0);

  // Tab で裏の本文へ抜けられない（capture ガードは keydown しか止めないので、
  // 抜けられると beforeinput 経由で見えない本文を編集できてしまう）。
  await expect(page.locator("main.workspace")).toHaveAttribute("inert", "");
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    const escaped = await page.evaluate(() =>
      Boolean(document.activeElement?.closest("main.workspace")));
    expect(escaped).toBe(false);
  }

  // Escape だけは通り、Backstage が閉じてフォーカスがファイルタブへ戻る。
  await page.keyboard.press("Escape");
  await expect(backstage(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "ファイル", exact: true })).toBeFocused();
  await expect(shapes).toHaveCount(1);
  await expect(page.locator("main.workspace")).not.toHaveAttribute("inert", "");
});

test("the title bar carries a quick access toolbar instead of a home-tab undo group", async ({ page }) => {
  await switchToWordLayout(page);

  const qat = page.locator(".ribbon-qat");
  await expect(qat).toHaveCount(1);
  await expect(qat.getByRole("button", { name: "元に戻す", exact: true })).toBeVisible();
  await expect(qat.getByRole("button", { name: "やり直す", exact: true })).toBeVisible();
  // 保存状態は Word の「自動保存」の位置 = QAT の中。
  await expect(qat.locator(".save-state")).toBeVisible();
  // 教材タイトルはタイトル行の **中央**。QAT 側と右端アクション側の列を同じ 1fr に
  // していないと「残りの領域の中央」= 見た目は右寄りになる (実測で 120px ずれた)。
  // 左端のアプリアイコン列 (42px) のぶんだけ許容する。
  const rowBox = await page.locator(".menubar-row").boundingBox();
  const titleBox = await page.locator(".document-title-row").boundingBox();
  const qatBox = await qat.boundingBox();
  const actionsBox = await page.locator(".ribbon-titlebar-actions").boundingBox();
  expect(rowBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(qatBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  const rowCenter = rowBox!.x + rowBox!.width / 2;
  const titleCenter = titleBox!.x + titleBox!.width / 2;
  expect(Math.abs(titleCenter - rowCenter)).toBeLessThanOrEqual(42);
  // 実寸だけでは「QAT がたまたま細いから中央に見える」状態と区別できない
  // (保存状態の文言が長い実機ではこれが崩れる)。列構成そのものが左右対称であることを見る。
  const sideColumns = await page.evaluate(() => {
    const row = document.querySelector(".menubar-row");
    if (!row) {
      throw new Error("menubar row not found");
    }
    const columns = getComputedStyle(row).gridTemplateColumns.split(" ").map(Number.parseFloat);
    return { count: columns.length, left: columns[1], right: columns[3] };
  });
  expect(sideColumns.count).toBe(4);
  expect(Math.abs(sideColumns.left - sideColumns.right)).toBeLessThanOrEqual(1);

  // 820px 以下では globals.css が .menubar-row を flex + wrap に、.brand を grid に戻す。
  // word 側で display を握り直していないと grid-column が全部失効し、タイトルは中央で
  // なくなり右端アクションがソース順で折り返す。
  await page.setViewportSize({ width: 800, height: 900 });
  const narrow = await page.evaluate(() => {
    const row = document.querySelector(".menubar-row");
    const title = document.querySelector(".document-title-row");
    const brand = document.querySelector(".brand");
    if (!row || !title || !brand) {
      throw new Error("title row not found");
    }
    const rowRect = row.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      display: getComputedStyle(row).display,
      brandDisplay: getComputedStyle(brand).display,
      offset: Math.abs((titleRect.x + titleRect.width / 2) - (rowRect.x + rowRect.width / 2)),
      overflows: row.scrollWidth > row.clientWidth + 1,
    };
  });
  expect(narrow.display).toBe("grid");
  expect(narrow.brandDisplay).toBe("contents");
  expect(narrow.offset).toBeLessThanOrEqual(42);
  expect(narrow.overflows).toBe(false);
  await page.setViewportSize({ width: 1400, height: 900 });
  // 並びは 左: QAT / 中央: タイトル / 右: 常設アクション。
  expect(qatBox!.x + qatBox!.width).toBeLessThanOrEqual(titleBox!.x + 1);
  expect(actionsBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width - 1);

  // ホームタブの「元に戻す」グループは無くなっている (Word 365 2023+ と同じ)。
  await openRibbonTab(page, "ホーム");
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "元に戻す", exact: true })).toHaveCount(0);
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "やり直す", exact: true })).toHaveCount(0);
});

test("undo and redo from the QAT reach the saved SigmaDoc", async ({ page }) => {
  test.slow();
  await switchToWordLayout(page);

  const blockId = await selectParagraphText(page);
  expect(blockId).not.toBe("");

  const bold = page.locator(".ribbon-body").getByRole("button", { name: "太字", exact: true });
  await expect(bold).toBeEnabled();
  expect(await savedBlockHasBold(page, blockId)).toBe(false);
  await bold.click();
  await expect.poll(() => savedBlockHasBold(page, blockId)).toBe(true);

  const qat = page.locator(".ribbon-qat");
  await qat.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"] strong`)).toHaveCount(0);
  await expect.poll(() => savedBlockHasBold(page, blockId)).toBe(false);

  await qat.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(page.locator(`.text-flow-editor [data-sigma-doc-id="${blockId}"] strong`).first()).toBeVisible();
  await expect.poll(() => savedBlockHasBold(page, blockId)).toBe(true);
});

test("the title bar keeps a labelled workspace button that opens the workspace", async ({ page }) => {
  await switchToWordLayout(page);

  const actions = page.locator(".ribbon-titlebar-actions");
  await expect(actions).toHaveCount(1);
  const workspace = actions.getByRole("button", { name: "ワークスペース", exact: true });
  await expect(workspace).toBeVisible();
  // アイコンだけに戻る退行を落とす (docs では常時ラベル付きだった動線)。
  await expect(workspace).toContainText("ワークスペース");
  await expect(workspace).toBeEnabled();

  await workspace.click();
  await expect(page).toHaveURL(/\/workspace/, { timeout: 20_000 });
});

test("the tab row carries the comment and AI actions on its right edge", async ({ page }) => {
  await switchToWordLayout(page);

  const actions = page.locator(".ribbon-tab-actions");
  await expect(actions).toHaveCount(1);
  const comments = actions.getByRole("button", { name: "コメント表示", exact: true });
  const aiChat = actions.getByRole("button", { name: "AIチャットを開く", exact: true });
  await expect(comments).toBeVisible();
  await expect(aiChat).toBeVisible();

  // Word のコメント / 共有と同じくタブの右。
  const tabsBox = await ribbonTabs(page).boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(tabsBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.x).toBeGreaterThanOrEqual(tabsBox!.x + tabsBox!.width - 1);

  // トグルが実際に効く (docs の設定メニューの「コメント表示」と同じ動作)。
  // 初期値は教材とパネル状態しだいなので、決め打ちせず「反転する」ことを見る。
  const before = await comments.getAttribute("aria-pressed");
  expect(before === "true" || before === "false").toBe(true);
  await comments.click();
  await expect(comments).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  // 表示タブに出ている同じコマンドも同じ状態を指す (element を共有しているので)。
  await openRibbonTab(page, "表示");
  await expect(page.locator(".ribbon-body").getByRole("button", { name: "コメント表示", exact: true }))
    .toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
});

test("a long title uses the room in the title bar instead of stopping at the input's intrinsic width", async ({ page }) => {
  await switchToWordLayout(page);

  // input は内容では伸びず、既定の intrinsic 幅 (size=20 相当 ≈ 180px) で止まる。
  // 中央の auto トラックにそのまま置くと、左右に数百px空いているのに ellipsis で切れる。
  const title = page.getByLabel("教材タイトル");
  await title.click();
  await title.fill("二次関数と二次不等式の完全攻略プリント（発展編・第3章 応用問題つき）");

  const measured = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".document-title-input");
    const row = document.querySelector(".menubar-row");
    if (!input || !row) {
      throw new Error("title input not found");
    }
    const rect = input.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      truncated: input.scrollWidth > input.clientWidth + 1,
      width: rect.width,
      offset: Math.abs((rect.x + rect.width / 2) - (rowRect.x + rowRect.width / 2)),
      rowWidth: rowRect.width,
    };
  });
  expect(measured.truncated).toBe(false);
  // intrinsic 幅 (約180px) に張り付いていないこと。
  expect(measured.width).toBeGreaterThan(300);
  expect(measured.width).toBeLessThanOrEqual(measured.rowWidth);
  // 伸びても中央のまま。
  expect(measured.offset).toBeLessThanOrEqual(42);
});

test("the Backstage takes the title bar and tab row commands away while it covers the document", async ({ page }) => {
  await switchToWordLayout(page);
  for (const scope of [".ribbon-qat", ".ribbon-titlebar-actions", ".ribbon-tab-actions"]) {
    await expect(page.locator(scope)).toHaveCount(1);
  }

  await openBackstage(page);

  // 覆っている間に押せると、見えていない本文へ undo / コメント / AIチャットが効いてしまう。
  for (const scope of [".ribbon-qat", ".ribbon-titlebar-actions", ".ribbon-tab-actions"]) {
    await expect(page.locator(scope)).toHaveCount(0);
  }
  // タブそのものは残る (ファイルタブ再クリック・他タブクリックで閉じる導線)。
  await expect(ribbonTabs(page).getByRole("tab")).toHaveCount(RIBBON_TABS.length);
  // ワークスペースはタイトル行と Backstage の両方に置いてあるが、同時に可視にはしない
  // (未スコープの getByRole が strict mode で落ちないための不変条件)。
  await expect(page.getByRole("button", { name: "ワークスペース", exact: true })).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(backstage(page)).toHaveCount(0);
  for (const scope of [".ribbon-qat", ".ribbon-titlebar-actions", ".ribbon-tab-actions"]) {
    await expect(page.locator(scope)).toHaveCount(1);
  }
});

test("each ribbon group is built from a large button and stacked small-button rows", async ({ page }) => {
  test.slow();
  await switchToWordLayout(page);

  const group = (key: string) => page.locator(`.ribbon-body .ribbon-group[data-group="${key}"]`);

  // ホーム: フォントと段落は 2 段、編集は 1 段、AI は大ボタン。
  await openRibbonTab(page, "ホーム");
  await expect(group("font").locator(".ribbon-group-row")).toHaveCount(2);
  await expect(group("font").locator(".ribbon-group-large")).toHaveCount(0);
  await expect(group("paragraph").locator(".ribbon-group-row")).toHaveCount(2);
  await expect(group("edit").locator(".ribbon-group-row")).toHaveCount(1);
  await expect(group("ai").locator(".ribbon-group-large")).toHaveCount(1);
  // 大ボタンはアイコンの下にラベル = 縦積み。実測で「アイコンの下端 <= ラベルの上端」。
  const large = group("ai").locator(".ribbon-group-large .icon-button");
  const iconBox = await large.locator("svg").first().boundingBox();
  const labelBox = await large.locator("span").first().boundingBox();
  expect(iconBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(iconBox!.y + iconBox!.height).toBeLessThanOrEqual(labelBox!.y + 1);

  // 挿入: 表と記号は大ボタン、図とテキストは 2 段。
  await openRibbonTab(page, "挿入");
  await expect(group("table").locator(".ribbon-group-large")).toHaveCount(1);
  await expect(group("symbol").locator(".ribbon-group-large")).toHaveCount(1);
  await expect(group("figure").locator(".ribbon-group-row")).toHaveCount(2);
  await expect(group("text").locator(".ribbon-group-row")).toHaveCount(2);

  // レイアウト: ページ設定は大ボタン + ランチャー。押しても何も起きないランチャーは作らない。
  await openRibbonTab(page, "レイアウト");
  await expect(group("pageSetup").locator(".ribbon-group-large")).toHaveCount(1);
  const launcher = group("pageSetup").getByRole("button", { name: "ページ設定ダイアログを開く", exact: true });
  await expect(launcher).toHaveCount(1);
  await expect(group("columns").locator(".ribbon-group-launcher")).toHaveCount(0);
  // ランチャーはグループの右下。
  const launcherBox = await launcher.boundingBox();
  const groupBox = await group("pageSetup").boundingBox();
  expect(launcherBox).not.toBeNull();
  expect(groupBox).not.toBeNull();
  expect(launcherBox!.x + launcherBox!.width).toBeGreaterThanOrEqual(groupBox!.x + groupBox!.width - 20);
  expect(launcherBox!.y).toBeGreaterThanOrEqual(groupBox!.y + groupBox!.height / 2);
  await launcher.click();
  const pageSettings = page.getByRole("dialog", { name: "ページ設定" });
  await expect(pageSettings).toBeVisible();
  // 閉じ切るまで待つ。開いたままだとモーダルが次のタブクリックを食う。
  // このダイアログは Escape では閉じず、背景を押して閉じる (toolbar-popovers.spec.ts と同じ)。
  await page.locator(".page-settings-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(pageSettings).toHaveCount(0);

  // グループ見出しは全グループの下端にある。
  await openRibbonTab(page, "表示");
  const labels = page.locator(".ribbon-body .ribbon-group-label");
  await expect(labels).toHaveText(["表示", "ズーム"]);
});

test("the ribbon collapses to the tab row and floats back over the document", async ({ page }) => {
  test.slow();
  await switchToWordLayout(page);
  await expect(page.locator(".ribbon-body")).toHaveCount(1);

  await page.getByRole("button", { name: "リボンを折りたたむ", exact: true }).click();

  // 本体は消え、タブ行だけになる。
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  await expect(ribbonTabs(page)).toBeVisible();
  const expand = page.getByRole("button", { name: "リボンを展開", exact: true });
  await expect(expand).toBeVisible();

  // タブを押すと本体が «浮いて» 出る。クローム高さは変えないので本文は動かない。
  const workspaceTopBefore = (await page.locator("main.workspace").boundingBox())!.y;
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  const overlay = page.locator(".ribbon-body.is-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("button", { name: "本文", exact: true })).toBeVisible();
  expect((await page.locator("main.workspace").boundingBox())!.y).toBe(workspaceTopBefore);

  // 外側クリックで閉じる。
  // 本文 locator の既定クリック点は、選択アクションのポップオーバーと重なることがある。
  // workspace 下端の余白を実座標で押し、浮遊リボンの外側クリックだけを検証する。
  const workspaceBox = (await page.locator("main.workspace").boundingBox())!;
  await page.mouse.click(workspaceBox.x + 8, workspaceBox.y + workspaceBox.height - 8);
  await expect(overlay).toHaveCount(0);

  // 同じタブをもう一度押すとトグルで閉じる。
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await expect(overlay).toBeVisible();
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await expect(overlay).toHaveCount(0);

  // Escape でも閉じる（折りたたみ自体は解除しない）。
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(expand).toBeVisible();

  // 820px 以下ではクロームの行が auto になるので、浮かせる位置を px で決め打つと
  // タブ行へ食い込む（実測で 16px 重なった）。狭い幅でもタブ行を覆わないこと。
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await expect(overlay).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  const narrow = await page.evaluate(() => {
    const tabsRow = document.querySelector(".ribbon-tabs-row")?.getBoundingClientRect();
    const floating = document.querySelector(".ribbon-body.is-overlay")?.getBoundingClientRect();
    const expandButton = document.querySelector(".ribbon-expand-button")?.getBoundingClientRect();
    if (!tabsRow || !floating || !expandButton) {
      throw new Error("collapsed chrome not found");
    }
    return {
      overlap: tabsRow.bottom - floating.top,
      expandCovered: expandButton.bottom > floating.top,
    };
  });
  expect(narrow.overlap).toBeLessThanOrEqual(1);
  expect(narrow.expandCovered).toBe(false);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);

  // 展開ボタンで戻る。
  await expand.click();
  await expect(page.locator(".ribbon-body")).toHaveCount(1);
  await expect(page.locator(".ribbon-body.is-overlay")).toHaveCount(0);
  await expect(expand).toHaveCount(0);
});

test("the floating ribbon does not come back on its own when another window changes the layout", async ({ page }) => {
  await switchToWordLayout(page);
  await page.getByRole("button", { name: "リボンを折りたたむ", exact: true }).click();
  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await expect(page.locator(".ribbon-body.is-overlay")).toBeVisible();

  // 別ウィンドウ/別タブからの切り替え (useUiLayoutPreference は storage を購読している)。
  // UI から切り替えると、その «クリック» 自体が外側クリックとして浮きを閉じてしまうので、
  // 「浮いた一時状態が取り残される」経路はこちらでしか踏めない。
  const setLayoutFromAnotherWindow = async (mode: "docs" | "word") => {
    await page.evaluate(({ key, next }) => {
      window.localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(next) }));
    }, { key: LAYOUT_STORAGE_KEY, next: { mode, onboardingCompleted: true, ribbonCollapsed: true } });
  };

  await setLayoutFromAnotherWindow("docs");
  await expect(page.locator(QUICK_TOOLBAR)).toHaveCount(1);
  await expect(page.locator(".ribbon-body")).toHaveCount(0);

  // 戻ってきたときに「何も押していないのに本体が浮いている」状態にならないこと。
  await setLayoutFromAnotherWindow("word");
  await expect(ribbonTabs(page)).toBeVisible();
  await expect(page.locator(".ribbon-body.is-overlay")).toHaveCount(0);
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  // 折りたたみ自体は覚えている。
  await expect(page.getByRole("button", { name: "リボンを展開", exact: true })).toBeVisible();
});

test("Ctrl+F1 and a double click on a tab toggle the ribbon", async ({ page }) => {
  await switchToWordLayout(page);
  await expect(page.locator(".ribbon-body")).toHaveCount(1);

  await page.keyboard.press("Control+F1");
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  await page.keyboard.press("Control+F1");
  await expect(page.locator(".ribbon-body")).toHaveCount(1);

  await page.getByRole("tab", { name: "ホーム", exact: true }).dblclick();
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  await page.getByRole("tab", { name: "ホーム", exact: true }).dblclick();
  await expect(page.locator(".ribbon-body")).toHaveCount(1);
});

test("the collapsed ribbon survives a reload", async ({ page }) => {
  await switchToWordLayout(page);
  await page.getByRole("button", { name: "リボンを折りたたむ", exact: true }).click();
  await expect(page.locator(".ribbon-body")).toHaveCount(0);

  await page.reload();
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });

  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toBeVisible();
  await expect(page.locator(".ribbon-body")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "リボンを展開", exact: true })).toBeVisible();
  // 浮かせた状態は永続しない（再読み込み直後に本体が出たままにならない）。
  await expect(page.locator(".ribbon-body.is-overlay")).toHaveCount(0);
});

test("the Word status bar reports the page count and drives the zoom", async ({ page }) => {
  test.slow();
  await switchToWordLayout(page);

  const statusBar = page.locator(".ribbon-statusbar");
  await expect(statusBar).toHaveCount(1);

  // ページ数は «描画の真値» と一致すること。data-page-count は検証にだけ使い、
  // 実装では読まない（読むと派生の逆流になる）。
  const renderedPageCount = await page.locator(".page-canvas").first().getAttribute("data-page-count");
  expect(renderedPageCount).not.toBeNull();
  // toContainText は部分一致なので「… / 1」が「… / 12」でも通る。完全一致で見る。
  await expect(statusBar.locator(".ribbon-statusbar-pages")).toHaveText(`ページ 1 / ${renderedPageCount}`);

  // ズームはステータスバーからも効く。同名のコマンドが表示タブにもあるので必ずスコープする。
  // ズーム率は .page-stack に --editor-zoom として載る (boxed-text-run-height.spec.ts と同じ読み方)。
  const canvasZoom = async () => page.evaluate(() => {
    const stack = document.querySelector(".page-stack");
    if (!stack) {
      throw new Error("page stack not found");
    }
    return getComputedStyle(stack).getPropertyValue("--editor-zoom").trim();
  });
  const before = await canvasZoom();
  await statusBar.getByRole("button", { name: "縮小", exact: true }).click();
  await expect.poll(canvasZoom).not.toBe(before);
  const zoomSelect = statusBar.getByRole("combobox", { name: "ズーム", exact: true });
  await selectUiOption(zoomSelect, "150");
  await expect.poll(canvasZoom).toBe("1.5");
  await statusBar.getByRole("button", { name: "拡大", exact: true }).click();
  await expect.poll(canvasZoom).not.toBe("1.5");


  // 表示タブのズームも残っている（Word も両方にある）。
  await openRibbonTab(page, "表示");
  await expect(page.locator(".ribbon-body").getByRole("combobox", { name: "ズーム", exact: true })).toHaveCount(1);
});

test("the status bar is not reachable while the Backstage covers the document", async ({ page }) => {
  await switchToWordLayout(page);
  await expect(page.locator(".ribbon-statusbar")).toHaveCount(1);

  await openBackstage(page);
  // 覆っている間に押せると、見えていない本文のズームが変わる（WI-1/2 と同じ規約）。
  await expect(page.locator(".ribbon-statusbar")).toHaveCount(0);
  // ステータスバーの行は残るので、Backstage をその行まで伸ばさないと下端に
  // 26px の «何も無い帯» が残る。
  const covered = await page.evaluate(() => {
    const panel = document.querySelector(".ribbon-backstage");
    if (!panel) {
      throw new Error("backstage not found");
    }
    return window.innerHeight - panel.getBoundingClientRect().bottom;
  });
  expect(covered).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(backstage(page)).toHaveCount(0);
  await expect(page.locator(".ribbon-statusbar")).toHaveCount(1);
});

/**
 * 2ページ以上に渡る教材。ステータスバーの `ページ N / M` は 1 ページの教材では
 * 「常に 1 / 1」でも緑になってしまい、総数も現在ページも検証にならない。
 * beforeEach の mock の後にもう一度 install すると、後から登録した init script が
 * 勝つ（実測: data-page-count が 2 になる）。
 */
const MULTI_PAGE_DOCUMENT = {
  ...sampleDocument,
  docId: "doc_statusbar_pages",
  metadata: { ...sampleDocument.metadata, title: "ページ数確認" },
  content: Array.from({ length: 60 }, (_, index) => ({
    type: "paragraph" as const,
    id: `statusbar_p_${index + 1}`,
    children: [{ type: "text" as const, text: `段落 ${index + 1} 本文テキストのサンプルです。` }],
  })),
} as SigmaDocument;

test("the status bar follows the current page across a multi-page document", async ({ page }) => {
  test.slow();
  await installDesktopRuntimeMock(page, MULTI_PAGE_DOCUMENT, {
    uiLayout: { mode: "docs" },
    preserveStorageKeys: [LAYOUT_STORAGE_KEY],
  });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
  await switchToWordLayout(page);

  const statusBar = page.locator(".ribbon-statusbar");
  const renderedPageCount = await page.locator(".page-canvas").first().getAttribute("data-page-count");
  const totalPages = Number(renderedPageCount);
  // 1ページきりだと「N を出せていない」バグを見逃すので、複数ページであること自体を固定する。
  expect(totalPages).toBeGreaterThan(1);
  const pages = statusBar.locator(".ribbon-statusbar-pages");
  await expect(pages).toHaveText(`ページ 1 / ${totalPages}`);

  // 最終ページまでスクロールすると現在ページが動く（既存の scroll 更新経路に乗っている）。
  await page.evaluate(() => {
    const scroller = document.querySelector(".editor-canvas") ?? document.querySelector("main.workspace");
    if (!scroller) {
      throw new Error("scroller not found");
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" as ScrollBehavior });
  });
  await expect(pages).toHaveText(`ページ ${totalPages} / ${totalPages}`, { timeout: 15_000 });

  // 先頭へ戻してから縮小する。ビューポートを丸ごとモデル座標へ割り戻すと、
  // スクロールしていないのに «最終ページ» を指す (実測: 3ページを10%にして「3 / 3」)。
  // 1ページ教材では表示側の Math.min に隠れて見えないので、必ず複数ページで見る。
  await page.evaluate(() => {
    const scroller = document.querySelector(".editor-canvas") ?? document.querySelector("main.workspace");
    scroller?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  });
  await expect(pages).toHaveText(`ページ 1 / ${totalPages}`, { timeout: 15_000 });
  await selectUiOption(page.locator(".ribbon-statusbar").getByRole("combobox", { name: "ズーム", exact: true }), "10");
  await expect(pages).not.toHaveText(`ページ ${totalPages} / ${totalPages}`, { timeout: 15_000 });
});
