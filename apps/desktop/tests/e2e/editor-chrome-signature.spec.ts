import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Characterization ("golden master") test for the Google-Docs-style editor chrome.
 *
 * This spec is deliberately added BEFORE the chrome is extracted into shared group components,
 * and the expected arrays below are transcribed from the current DOM into source rather than
 * recorded into a snapshot file. That is the whole point: a later refactor cannot quietly
 * re-record its own baseline. If a control moves, a group is renamed or regrouped, nesting
 * depth changes, an element is reordered, or a control silently becomes disabled, the
 * extraction changed rendered output and this fails.
 *
 * The signature deliberately covers the `.toolbar-group` wrappers and each entry's nesting
 * depth, not just the leaf controls: regrouping controls is exactly what the extraction does,
 * so a flat list of leaves in order would let the interesting regressions through.
 *
 * Do NOT "fix" a failure here by editing the arrays unless the DOM change is intentional and is
 * being reviewed as such. One legitimate reason to edit them: the menubar signature contains the
 * sample document's title, so a deliberate rename in `sample-document.ts` lands here too.
 */

// The material editing dialog renders its own [data-editor-toolbar="quick"] from the same
// EditorToolbar component (materials.spec.ts asserts on it), so the signature must be scoped to
// the editor's own chrome or it would silently pick up whichever one appeared first.
const TOOLBAR_SCOPE = '.editor-menubar [data-editor-toolbar="quick"]';
const MENUBAR_SCOPE = ".editor-menubar .menubar-row";

const SIGNATURE_SELECTOR =
  "button, select, input, [role='tab'], .toolbar-group, .toolbar-splitter, .toolbar-inline-divider";

const DOCS_TOOLBAR_SIGNATURE: readonly string[] = [
  "|DIV|toolbar-group flat|編集|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|元に戻す|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|やり直す|||false|||",
  "toolbar-group flat|BUTTON|icon-button with-text|素材|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|書式|||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select block-style|段落スタイル|||false|||",
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select|フォント: 標準ゴシック|||false|||",
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select compact|フォントサイズ|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|太字|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|斜体|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|下線|false||false|||",
  "toolbar-group flat>shape-menu-anchor boxed-text-toolbar-control>Tooltip-module__trigger|BUTTON|icon-button boxed-text-toggle-button|囲み文字を適用|false||false|||",
  "toolbar-group flat>shape-menu-anchor boxed-text-toolbar-control|BUTTON|shape-menu-button icon-only boxed-text-menu-button boxed-text-menu-trigger|囲み文字の種類と上下余白 0px|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color toolbar-icon-color-text|文字色|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color toolbar-icon-color-text|文字背景色|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-height-menu-button|行間: 1.75行|||false|||",
  "toolbar-group flat>align-tip>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only text-align-menu-button|文字揃え: 左揃え|||false|||",
  // 箇条書き / 番号付きは直接操作し、引用 / コード / 区切り線 / 囲み枠は「その他」にまとめる。
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|箇条書き|false||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|番号付きリスト|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|その他のブロック|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|挿入|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|icon-button|数式|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|テキスト|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|グラフ|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|3D教材|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|表|false||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|図形|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|線|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|図形スタイル|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color|枠線|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color|内部塗りつぶし|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-dash-menu-button|線種（現在: 混在）|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-width-menu-button|線幅（現在: 混在）|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-endpoint-menu-button|線の左端（現在: 混在）|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-endpoint-menu-button|線の右端（現在: 混在）|||true|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat search-anchor|検索置換|||false|||",
  "toolbar-group flat search-anchor>Tooltip-module__trigger|BUTTON|icon-button|検索置換|||false|||",
  "|DIV|toolbar-group flat push|表示と出力|||false|||",
  "toolbar-group flat push>Tooltip-module__trigger|BUTTON|icon-button|縮小|||false|||",
  "toolbar-group flat push|BUTTON|ui-select Select-module__trigger toolbar-select compact|ズーム|||false|100||16",
  "toolbar-group flat push>Tooltip-module__trigger|BUTTON|icon-button|拡大|||false|||",
];

const DOCS_MENUBAR_SIGNATURE: readonly string[] = [
  "brand>document-title-row>document-title-field|INPUT|document-title-input|教材タイトル|||false|複素数平面の正方形と積の範囲||",
  "brand>app-menu-list>app-menu-anchor|BUTTON|app-menu-button ||||false||ファイル|",
  "brand>app-menu-list>app-menu-anchor|BUTTON|app-menu-button ||||false||挿入|",
  "brand>app-menu-list>app-menu-anchor|BUTTON|app-menu-button ||||false||AI|",
  "brand>app-menu-list>app-menu-anchor|BUTTON|app-menu-button ||||false||設定|",
  // 分割ペインを扱うタブ列に差し替えたので、タブはペインごとの囲み (.workspace-tab-cluster)
  // の中に入る。囲みは 1 ペインのときも DOM に居るが、見た目は従来のタブ列のまま。
  "brand>document-tabs-row workspace-tabs-row>document-tabs-scroll>workspace-tab-cluster>document-tab workspace-tab active|BUTTON|document-tab-main|複素数平面の正方形と積の範囲|||false|||",
  "brand>document-tabs-row workspace-tabs-row>document-tabs-scroll>workspace-tab-cluster>document-tab workspace-tab active|BUTTON|document-tab-close|複素数平面の正方形と積の範囲 のタブを閉じる|||false|||",
  "|BUTTON|version-history-button|バージョン履歴|false||false|||",
  "|BUTTON|report-issue-button|問題を報告|||false|||",
  "menubar-right-actions|BUTTON|workspace-open-button|ワークスペース|||false|||",
  "menubar-right-actions>document-tab-actions>document-tab-action-hover|BUTTON|document-tab-action|新規教材|||false|||",
  "menubar-right-actions>document-tab-actions>Tooltip-module__trigger|BUTTON|document-tab-action|教材一覧|||false|||",
];

const OVERLAY_TOOLBAR_SIGNATURE: readonly string[] = [
  "|DIV|toolbar-group flat|編集|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|元に戻す|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|やり直す|||false|||",
  "toolbar-group flat|BUTTON|icon-button with-text|素材|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|書式|||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select block-style|段落スタイル|||true|||",
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select|フォント: 標準ゴシック|||true|||",
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>shape-menu-anchor|BUTTON|toolbar-font-select compact|フォントサイズ|||true|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|太字|false||true|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|斜体|false||true|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|下線|false||true|||",
  "toolbar-group flat>shape-menu-anchor boxed-text-toolbar-control>Tooltip-module__trigger|BUTTON|icon-button boxed-text-toggle-button|囲み文字を適用|false||true|||",
  "toolbar-group flat>shape-menu-anchor boxed-text-toolbar-control|BUTTON|shape-menu-button icon-only boxed-text-menu-button boxed-text-menu-trigger|囲み文字の種類と上下余白 0px|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color toolbar-icon-color-text|文字色|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color toolbar-icon-color-text|文字背景色|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-height-menu-button|行間: 1.75行|||true|||",
  "toolbar-group flat>align-tip>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only text-align-menu-button|文字揃え: 左揃え|||true|||",
  "toolbar-group flat|SPAN|toolbar-inline-divider||||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|箇条書き|false||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|番号付きリスト|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|その他のブロック|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|挿入|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|icon-button|数式|||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|テキスト|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|グラフ|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|3D教材|false||false|||",
  "toolbar-group flat>Tooltip-module__trigger|BUTTON|icon-button|表|false||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|図形|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only|線|||false|||",
  "|DIV|toolbar-splitter||||false|||",
  "|DIV|toolbar-group flat|図形スタイル|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color|枠線|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|toolbar-icon-color|内部塗りつぶし|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-dash-menu-button|線種（現在: 実線）|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-width-menu-button|線幅（現在: 中）|||false|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-endpoint-menu-button|線の左端（現在: 混在）|||true|||",
  "toolbar-group flat>shape-menu-anchor>Tooltip-module__trigger|BUTTON|shape-menu-button icon-only line-endpoint-menu-button|線の右端（現在: 混在）|||true|||",
  "|DIV|toolbar-group flat push|表示と出力|||false|||",
  "toolbar-group flat push>Tooltip-module__trigger|BUTTON|icon-button|縮小|||false|||",
  "toolbar-group flat push|BUTTON|ui-select Select-module__trigger toolbar-select compact|ズーム|||false|100||16",
  "toolbar-group flat push>Tooltip-module__trigger|BUTTON|icon-button|拡大|||false|||",
];

const DOCS_APP_MENU_ITEMS: Readonly<Record<string, readonly string[]>> = {
  "ファイル": [
    "menuitem|現在の教材を複製||false|true",
    "menuitem|現在の教材を削除||true|true",
    "menuitem|インポート（JSON / TeX）||false|true",
    "menuitem|他の形式をインポート||false|true",
    "menuitem|テキストから読み込み||false|true",
    "menuitem|エクスポート||false|true",
    "menuitem|JSONをエクスポート||false|false",
    "menuitem|PDFを書き出し||false|false",
    "menuitem|テキストでコピー||false|false",
  ],
  "挿入": [
    "menuitem|本文||false|true",
    "menuitem|見出し||false|true",
    "menuitem|問題||false|true",
    "menuitem|数式⌘⇧M||false|true",
    "menuitem|グラフG||false|true",
    "menuitem|3D教材||false|true",
    "menuitem|画像||false|true",
    "menuitem|図形||false|true",
  ],
  "AI": [
    "menuitem|AIチャットを開く||false|true",
    "menuitem|AI設定||false|true",
  ],
  "設定": [
    "menuitemcheckbox|コメント表示|true|false|true",
    "menuitem|アウトラインを表示||false|true",
    "menuitem|ショートカット設定⌘⌥,||false|true",
    "menuitem|数式コマンド確認||false|true",
    "menuitem|TeX環境設定||false|true",
    "menuitem|ページ設定||false|true",
    "menuitemcheckbox|Word風のリボン表示|false|false|true",
    "menuitem|UIの選択画面を再表示||false|true",
    "menuitem|アプリ設定||false|true",
  ],
};

/**
 * path|tag|class|aria-label|aria-pressed|aria-disabled|disabled|value|text|options for every
 * control AND every `.toolbar-group` wrapper in the scope, in document order.
 *
 * - `path` is the chain of ancestor classes between the scope root and the element. It replaces a
 *   bare depth count so that renaming or removing an intermediate wrapper (`.shape-menu-anchor`,
 *   `.align-tip`) is visible, not just a change in nesting distance.
 * - `aria-disabled` is captured next to native `:disabled` because wrapping a control in a shared
 *   component is a common way to switch from one to the other, and that must not read as "same".
 * - `value` pins a control's current value (zoom level, document title); `options` pins the size of
 *   a dropdown's option list. Pinning the list without the selection would miss a default-value
 *   regression, and vice versa. The app's `Select` keeps its options in a portal that only exists
 *   while it is open, so both are read from the closed trigger's `data-*` attributes.
 * - `text` is suppressed for labelled elements precisely so that a dropdown's textContent does not
 *   drag its current value into every field.
 */
async function readSignature(page: Page, scope: string): Promise<string[]> {
  return page.$eval(
    scope,
    (root, selector) =>
      Array.from(root.querySelectorAll(selector)).map((element) => {
        const describe = (node: Element) => {
          const nodeClass = typeof node.className === "string" ? node.className.trim() : "";
          // CSS Module class names carry a build hash (Tooltip-module__88Z_uW__trigger) that
          // changes whenever that .module.css is edited. Normalise the hash away so an unrelated
          // stylesheet edit does not fail this spec, while still pinning that the wrapper exists.
          return nodeClass.replace(/-module__[^\s]*?__/g, "-module__") || node.tagName;
        };
        // Same CSS Module hash normalisation as `describe`, but without its trim/tagName
        // fallback: this field pins the raw class attribute, trailing space and all.
        const className = (typeof element.className === "string" ? element.className : "")
          .replace(/-module__[^\s]*?__/g, "-module__");
        const label = element.getAttribute("aria-label") ?? "";
        // The app menu buttons (ファイル / 挿入 / AI / 設定) carry no aria-label and no
        // distinguishing class, so without their text they would all serialize to the same
        // string and a reordering would slip through. Only fall back to text where the label
        // is missing: for a <select>, textContent would drag in every option.
        const text = label ? "" : (element.textContent ?? "").trim();
        const options = element.getAttribute("data-option-count") ?? "";
        const value = element.getAttribute("data-value")
          ?? (element instanceof HTMLInputElement ? element.value : "");
        const path: string[] = [];
        for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
          path.unshift(describe(node));
        }
        return [
          path.join(">"),
          element.tagName,
          className,
          label,
          element.getAttribute("aria-pressed") ?? "",
          element.getAttribute("aria-disabled") ?? "",
          String(element.matches(":disabled")),
          value,
          text,
          options,
        ].join("|");
      }),
    SIGNATURE_SELECTOR,
  );
}

/**
 * role|name|aria-checked|disabled|visible for the items of one app menu, in document order.
 *
 * Roles matter as much as the labels: WI-1's ribbon toggle is a menuitemcheckbox and the
 * extraction must not quietly demote it to a plain menuitem. `menuitemradio` is enumerated too —
 * it already occurs elsewhere in this chrome, so an extraction that introduces one here would
 * otherwise vanish. Visibility is a captured field rather than a filter: the export submenu's
 * children are hidden by CSS (.app-menu-submenu-panel { display: none }) until hovered, and
 * pinning them AS hidden catches both a new item and an item that silently stops being hidden.
 */
async function readAppMenuItems(page: Page, menuName: string): Promise<string[]> {
  await page.locator(".app-menu-list").getByRole("button", { name: menuName, exact: true }).click();
  const menu = page.getByRole("menu", { name: menuName });
  await expect(menu).toBeVisible();
  const items = await menu
    .locator('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        [
          element.getAttribute("role") ?? "",
          (element.textContent ?? "").trim(),
          element.getAttribute("aria-checked") ?? "",
          String(element.matches(":disabled")),
          String(element.checkVisibility()),
        ].join("|"),
      ),
    );
  // Close again so the next menu opens from a clean state.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  return items;
}

/** Draws one rectangle, which puts the chrome into its overlay-editing state. */
async function insertSquare(page: Page): Promise<void> {
  await page.getByRole("button", { name: "図形", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "四角形", exact: true }).click();
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
  await expect(page.locator(".overlay-shape[data-overlay-shape-id]")).toHaveCount(1);
  // The toolbar reacts to the selection, which lands a beat after the shape does.
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 5_000 });
});

test("docs chrome toolbar renders the same controls in the same order", async ({ page }) => {
  // page.$eval silently takes the first match, so an ambiguous scope would read some other
  // toolbar and still pass. Pin the scope down to exactly one element. This guard is
  // load-bearing rather than decorative: expect.poll retries a failing MATCHER, but an
  // exception thrown by the polled function (which is what $eval does on a missing or
  // ambiguous scope) propagates immediately.
  await expect(page.locator(TOOLBAR_SCOPE)).toHaveCount(1);
  // The toolbar root is outside its own querySelectorAll result, so pin it separately.
  await expect(page.locator(TOOLBAR_SCOPE)).toHaveClass("quick-toolbar-row");
  await expect(page.locator(TOOLBAR_SCOPE)).toHaveAttribute("aria-label", "編集ツール");
  // expect.poll retries: several labels are selection-derived and the document tabs arrive from
  // async store state, so a one-shot read would turn "not settled yet" into a hard failure.
  await expect.poll(() => readSignature(page, TOOLBAR_SCOPE)).toEqual(DOCS_TOOLBAR_SIGNATURE);
});

test("secondary body blocks live in the overflow menu while lists stay direct", async ({ page }) => {
  const toolbar = page.locator(TOOLBAR_SCOPE);

  await expect(toolbar.getByRole("button", { name: "箇条書き", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "番号付きリスト", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "コード", exact: true })).toHaveCount(0);

  await toolbar.getByRole("button", { name: "その他のブロック", exact: true }).click();
  const menu = page.getByRole("menu", { name: "その他のブロック", exact: true });
  await expect(menu.getByRole("menuitem", { name: "引用", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "コードブロック", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "区切り線", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "囲み枠（fancybox）", exact: true })).toBeVisible();
});

test("code settings stay on the block and its background stays stable across editing", async ({ page }, testInfo) => {
  const toolbar = page.locator(TOOLBAR_SCOPE);
  const paragraph = page.locator(".text-flow-editor[contenteditable='true']:visible")
    .nth(2)
    .locator("p[data-sigma-doc-id]")
    .first();
  await paragraph.click({ position: { x: 12, y: 12 } });
  await expect(toolbar.getByRole("button", { name: "箇条書き", exact: true })).toBeEnabled();
  await toolbar.getByRole("button", { name: "その他のブロック", exact: true }).click();
  await page.getByRole("menu", { name: "その他のブロック", exact: true })
    .getByRole("menuitem", { name: "コードブロック", exact: true })
    .click();

  const code = page.locator(".text-flow-editor .print-code[data-sigma-doc-id]").first();
  await expect(code).toHaveAttribute("data-code-theme", "light");
  await expect(toolbar.getByRole("combobox", { name: "コードの言語" })).toHaveCount(0);
  const backgroundBefore = await code.evaluate((element) => getComputedStyle(element).backgroundColor);
  await code.click();
  await page.keyboard.type("x");
  const backgroundDuring = await code.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByRole("textbox", { name: "教材タイトル" }).click();
  const backgroundAfter = await code.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect([backgroundBefore, backgroundDuring, backgroundAfter]).toEqual([
    "rgb(247, 248, 250)",
    "rgb(247, 248, 250)",
    "rgb(247, 248, 250)",
  ]);

  await code.hover();
  await code.getByRole("button", { name: "コードブロックの設定", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "コードブロックの設定", exact: true });
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
  await expect(dialog.locator(".code-block-settings-title")).toHaveCount(0);
  const language = dialog.getByRole("combobox", { name: "コードの言語" });
  await expect(language).toBeFocused();
  await language.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await language.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await language.click();
  await page.getByRole("option", { name: "TypeScript", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(language).toHaveText("TypeScript");
  await expect(language).toBeFocused();
  await expect.poll(() => language.evaluate((element) => getComputedStyle(element).minHeight)).toBe("34px");
  await dialog.screenshot({ path: testInfo.outputPath("code-block-settings.png") });
  await language.click();
  await page.screenshot({ path: testInfo.outputPath("code-block-languages.png") });
  await language.press("Escape");
  await dialog.getByRole("radio", { name: "ダーク", exact: true }).click();

  await expect(code).toHaveAttribute("data-code-language", "typescript");
  await expect(code).toHaveAttribute("data-code-theme", "dark");
  await expect.poll(() => code.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(23, 23, 23)");
  await page.getByRole("textbox", { name: "教材タイトル" }).click();
  await expect(dialog).toHaveCount(0);
  await code.hover();
  await code.getByRole("button", { name: "コードブロックの設定", exact: true }).click();
  await expect(language).toHaveText("TypeScript");
  await language.press("Escape");
  await expect(dialog).toHaveCount(0);

  const codeId = await code.getAttribute("data-sigma-doc-id");
  const readSaved = () => page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null"));
  await expect.poll(async () => JSON.stringify(await readSaved())).toContain('"theme":"dark"');
  const savedDocument = await readSaved();
  const reloaded = await page.context().newPage();
  await installDesktopRuntimeMock(reloaded, savedDocument);
  await reloaded.goto("/");
  const savedCode = reloaded.locator(`.text-flow-editor .print-code[data-sigma-doc-id="${codeId}"]`).first();
  await expect(savedCode).toHaveAttribute("data-code-language", "typescript");
  await expect(savedCode).toHaveAttribute("data-code-theme", "dark");
  await reloaded.close();
});

test("docs chrome menubar row renders the same controls in the same order", async ({ page }) => {
  await expect(page.locator(MENUBAR_SCOPE)).toHaveCount(1);
  await expect.poll(() => readSignature(page, MENUBAR_SCOPE)).toEqual(DOCS_MENUBAR_SIGNATURE);
});

test("docs chrome app menus expose the same items", async ({ page }) => {
  for (const [menuName, expectedItems] of Object.entries(DOCS_APP_MENU_ITEMS)) {
    // The 削除 item's disabled state is derived from the async document list, so poll here too.
    await expect
      .poll(() => readAppMenuItems(page, menuName), { message: `${menuName} メニュー` })
      .toEqual(expectedItems);
  }
});

test("selecting an overlay shape swaps the search group out of the toolbar", async ({ page }) => {
  // The search/replace group is the only part of the toolbar rendered conditionally
  // ({!overlayEditing && ...}); every other group stays mounted and merely disables itself.
  // Word's contextual tab has to reproduce this same show/hide, so pin it explicitly.
  await expect(page.locator(TOOLBAR_SCOPE)).toHaveCount(1);
  await expect
    .poll(() => readSignature(page, TOOLBAR_SCOPE).then((entries) =>
      entries.some((entry) => entry.includes("|検索置換|"))))
    .toBe(true);

  await insertSquare(page);

  await expect.poll(() => readSignature(page, TOOLBAR_SCOPE)).toEqual(OVERLAY_TOOLBAR_SIGNATURE);
  // Asserted against the pinned constant rather than by re-reading the page: the poll above
  // already proved the live toolbar equals it, so a second round-trip would only add flake.
  expect(OVERLAY_TOOLBAR_SIGNATURE.some((entry) => entry.includes("|検索置換|"))).toBe(false);
});
