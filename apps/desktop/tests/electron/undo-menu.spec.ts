import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

/**
 * ⌘Z を押したときに走るのが **我々の click ハンドラ**であることを、実物の Electron メニューで測る。
 *
 * 直す対象は「メニューが ⌘Z を持っていること」ではなく「持った先が `role: "undo"` =
 * `webContents.undo()` だったこと」。だからメニューはキーを持ったままでよく、
 * 見るべきは **⌘Z / ⇧⌘Z を持つ項目が role ではなく click 項目であること**。
 * (キーを手放す `registerAccelerator: false` は macOS では契約上サポート外なので使わない。)
 *
 * Chromium の e2e ではこれが一切測れない (メニューが存在しないので、⌘Z を丸ごと奪われて
 * いても緑になる)。実際そのせいで「⌘Z が効かない」が長く残った。だから修正と同じ WI に
 * 検証手段を新設する。
 *
 * **自動テストの限界 (重要)**: Playwright の `page.keyboard` は CDP でレンダラへ直接
 * イベントを注入するので、**メニューのキー等価を一切通らない**。最後のテストは
 * 「Electron 環境でもレンダラ経路が生きている」ことしか示さない。実機の ⌘Z が
 * どこへ行くかは、メニュー不変条件 (1 本目) と Undo / Redo のクリック経路で担保する。
 * OS のキーイベントを本当に流す自動テストは存在しないので、⌘Z / ⇧⌘Z と
 * クリップボード (⌘X / ⌘C / ⌘V) の実機手動確認はチェックリストとして残す。
 */

// spec は CJS へトランスパイルされるので `import.meta.url` は使えない (先例: tests/e2e/perf-probe.spec.ts)。
const APP_ROOT = path.resolve(__dirname, "../..");
const MAIN_ENTRY = path.join(APP_ROOT, "dist-electron", "main.cjs");
const RENDERER_ENTRY = path.join(APP_ROOT, "out", "index.html");
const PREPARED = existsSync(MAIN_ENTRY) && existsSync(RENDERER_ENTRY);

const BODY = ".page-flow .ProseMirror";
const CRASH_SCREEN = '[data-testid="app-crash-screen"]';
const SPLASH = "[data-startup-splash]";

/** `text-flow/history-grouping.ts` の 500ms グループ窓を確実に閉じるための待ち。 */
const HISTORY_GROUP_SETTLE_MS = 800;

/** ⌘Z / ⇧⌘Z に解決される accelerator。表記ゆれを吸うために正規化して照合する。 */
const UNDO_ACCELERATOR_PATTERN = /^(?:cmdorctrl|commandorcontrol|command|cmd|ctrl|control)(?:\+shift)?\+z$/;

/**
 * 既定のキー等価を **持ったままでなければいけない** role (Electron は role を小文字で返す)。
 *
 * macOS の ⌘C / ⌘V は AppKit のメニューキー等価から NSResponder の `copy:` / `paste:` へ届く。
 * このアプリのクリップボード経路は DOM の clipboard イベント駆動で keydown のフォールバックが
 * 無いため、ここのキー等価を落とすとアプリ全体でコピー & ペーストが死ぬ。
 */
const CLIPBOARD_ROLES = ["cut", "copy", "paste", "pasteandmatchstyle", "delete", "selectall"];

/** 比較用に Electron 自身の `{ role: "editMenu" }` から読む 1 項目。 */
interface MenuRoleReference {
  label: string;
  accelerator: string | null;
  registerAccelerator: boolean;
}

interface MenuSnapshotItem {
  path: string;
  label: string;
  /** Electron は role を小文字で返す (`pasteAndMatchStyle` → `pasteandmatchstyle`)。 */
  role: string | null;
  type: string;
  accelerator: string | null;
  registerAccelerator: boolean;
}

let app: ElectronApplication;
let page: Page;
let userDataRoot = "";

function launchEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // 実機の教材ライブラリを絶対に触らない。ここを渡さないと開発者の本物のワークスペースに
  // スモーク用の文書が積まれる。
  env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
  return env;
}

async function readApplicationMenu(): Promise<MenuSnapshotItem[]> {
  return app.evaluate(({ Menu }): MenuSnapshotItem[] => {
    const walk = (menu: Electron.Menu | null, trail: readonly string[]): MenuSnapshotItem[] => {
      if (!menu) {
        return [];
      }
      return menu.items.flatMap((item) => [
        {
          path: [...trail, item.label].filter((part) => part.length > 0).join(" > "),
          label: item.label,
          role: item.role ? String(item.role).toLowerCase() : null,
          type: item.type,
          accelerator: item.accelerator ?? null,
          registerAccelerator: item.registerAccelerator,
        },
        ...walk(item.submenu ?? null, [...trail, item.label]),
      ]);
    };
    return walk(Menu.getApplicationMenu(), []);
  });
}

/**
 * Electron 自身の `{ role: "editMenu" }` を **参照実装として**組み立てて読む。
 *
 * 「今日の挙動を 1mm も変えない」を自分の思い込みではなく Electron の定義と突き合わせて
 * 測るため。macOS では cut / copy / paste の `registerAccelerator` を Electron 自身が
 * false で返す (キー等価は AppKit 側が持つ) ので、**期待値をハードコードすると必ず外す**。
 */
async function readDefaultEditMenuRoles(): Promise<Record<string, MenuRoleReference>> {
  return app.evaluate(({ Menu }): Record<string, MenuRoleReference> => {
    const reference = Menu.buildFromTemplate([{ role: "editMenu" }]);
    const roles: Record<string, MenuRoleReference> = {};
    for (const item of reference.items[0]?.submenu?.items ?? []) {
      if (!item.role) {
        continue;
      }
      roles[String(item.role).toLowerCase()] = {
        label: item.label,
        accelerator: item.accelerator ?? null,
        registerAccelerator: item.registerAccelerator,
      };
    }
    return roles;
  });
}

/** トップレベルメニュー配下の項目を実際にクリックする (メニュー項目が唯一の到達経路)。 */
async function clickMenuItem(menuLabel: string, itemLabel: string): Promise<boolean> {
  return app.evaluate(({ Menu }, labels) => {
    const top = Menu.getApplicationMenu()?.items.find((item) => item.label === labels.menu);
    const target = top?.submenu?.items.find((item) => item.label === labels.item);
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, { menu: menuLabel, item: itemLabel });
}

async function typeIntoBody(text: string): Promise<void> {
  await page.locator(BODY).first().click();
  await page.keyboard.type(text);
  await expect(page.locator(BODY).first()).toContainText(text);
  // 打鍵が 1 つの undo エントリに畳まれてから戻す (500ms のグループ窓を閉じる)。
  await page.waitForTimeout(HISTORY_GROUP_SETTLE_MS);
}

test.describe("Electron native menu and undo", () => {
  test.skip(
    !PREPARED,
    "dist-electron/main.cjs と out/index.html が要ります。`npm run electron:prepare` を先に実行してください",
  );
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    userDataRoot = mkdtempSync(path.join(tmpdir(), "sigma-electron-smoke-"));
    app = await electron.launch({
      // `--user-data-dir` は Chromium 側の単一インスタンスロックも切り離す
      // (開発者が本物のアプリを起動したままでもスモークが起動できる)。
      args: [APP_ROOT, `--user-data-dir=${path.join(userDataRoot, "chromium")}`],
      cwd: APP_ROOT,
      env: launchEnv(path.join(userDataRoot, "sigma")),
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector(BODY, { timeout: 60_000 });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    if (!userDataRoot) {
      return;
    }
    // `app.close()` が解決したあとも Chromium がプロファイルへ書き続けるので、素の rmSync は
    // ENOTEMPTY で落ちる (実測: このテストの flake 要因そのもの)。リトライしても消えなければ
    // temp の残骸が 1 つ残るだけなので握り潰す — 後始末でテストを赤くしない。
    try {
      rmSync(userDataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // OS の temp 掃除に任せる。
    }
  });

  test("gives the undo key to our own click handler, not a native role", async () => {
    const items = await readApplicationMenu();
    // 取得に失敗して空配列のまま「全部満たした」で緑にならないよう最低件数を先に固定する。
    expect(items.length).toBeGreaterThan(20);

    // role を付けると Electron は click を無視して webContents.undo() = Blink の
    // ネイティブ undo を呼ぶ。それが PM 所有 DOM を外から書き換える経路そのもの。
    expect(items.filter((item) => item.role === "undo" || item.role === "redo")).toEqual([]);

    // ⌘Z / ⇧⌘Z を持っているのは我々の click 項目 **だけ**であること。
    const undoKeyOwners = items.filter(
      (item) =>
        item.accelerator &&
        UNDO_ACCELERATOR_PATTERN.test(item.accelerator.replace(/\s+/gu, "").toLowerCase()),
    );
    expect(undoKeyOwners.map((item) => item.path)).toEqual(["Edit > Undo", "Edit > Redo"]);
    expect(undoKeyOwners.map((item) => item.role)).toEqual([null, null]);
  });

  test("keeps the clipboard roles identical to Electron's own edit menu", async () => {
    // ここを手放すと macOS でコピー & ペーストがアプリ全体で死ぬ (CLIPBOARD_ROLES 参照)。
    // 期待値は **Electron 自身の editMenu から読む** — ラベルもキー等価もプラットフォームと
    // ロケールで変わるので、ハードコードした期待値では「変えていない」ことを測れない。
    //
    // なお macOS では `registerAccelerator: false` を書いても書かなくても、ここから読める
    // MenuItem の状態は同じになる (Electron 自身が role のキー等価を AppKit に任せていて
    // false を返す)。**つまり実機からはその指定の有無を観測できない**ので、
    // 「書かせない」側の不変条件はソースを見る electron/menu-accelerator-parity.test.ts が持つ。
    const reference = await readDefaultEditMenuRoles();
    expect(CLIPBOARD_ROLES.filter((role) => reference[role] === undefined)).toEqual([]);

    const items = await readApplicationMenu();
    const drifted = CLIPBOARD_ROLES.map((role) => {
      const mine = items.find((item) => item.role === role);
      return {
        role,
        mine: mine
          ? {
            label: mine.label,
            accelerator: mine.accelerator,
            registerAccelerator: mine.registerAccelerator,
          }
          : null,
        reference: reference[role] ?? null,
      };
    }).filter((row) => JSON.stringify(row.mine) !== JSON.stringify(row.reference));
    expect(drifted).toEqual([]);
  });

  test("keeps Undo and Redo visible in the Edit menu", async () => {
    // キーを手放してもメニューの表記は従来どおり残す (支援技術からの到達性を含む)。
    const items = await readApplicationMenu();
    const undo = items.find((item) => item.path === "Edit > Undo");
    const redo = items.find((item) => item.path === "Edit > Redo");
    expect(undo).toMatchObject({ accelerator: "CmdOrCtrl+Z", role: null });
    expect(redo).toMatchObject({ accelerator: "CmdOrCtrl+Shift+Z", role: null });
  });

  test("undoes one step when the Edit menu item is clicked", async () => {
    // 「メニュー項目が SigmaDoc の undo を呼ぶ」の唯一の自動検証。
    // accelerator を手放した以上、クリックが到達経路として生きていることは実測が要る。
    const typed = "SmokeMenuUndo";
    await typeIntoBody(typed);

    expect(await clickMenuItem("Edit", "Undo")).toBe(true);

    await expect(page.locator(BODY).first()).not.toContainText(typed);
    // ネイティブ undo が PM 所有 DOM を壊すとここが React の例外で埋まる。
    await expect(page.locator(CRASH_SCREEN)).toHaveCount(0);
  });

  test("redoes one step when the Edit menu item is clicked", async () => {
    // Redo も accelerator を手放しているので、クリック経路が生きていることを実測する。
    const typed = "SmokeMenuRedo";
    await typeIntoBody(typed);

    expect(await clickMenuItem("Edit", "Undo")).toBe(true);
    await expect(page.locator(BODY).first()).not.toContainText(typed);

    expect(await clickMenuItem("Edit", "Redo")).toBe(true);
    await expect(page.locator(BODY).first()).toContainText(typed);
    await expect(page.locator(CRASH_SCREEN)).toHaveCount(0);
  });

  test("keeps the renderer shortcut path alive under Electron", async () => {
    // ⚠️ page.keyboard は CDP 注入なのでメニューのキー等価を通らない。
    // ここで見ているのは「Electron 環境でもレンダラのショートカット層が生きている」ことだけ。
    // 実機の ⌘Z はメニュー側が消費して click 経路 (上のテスト) を通る。
    const typed = "SmokeKeyUndo";
    await typeIntoBody(typed);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

    await expect(page.locator(BODY).first()).not.toContainText(typed);
    await expect(page.locator(CRASH_SCREEN)).toHaveCount(0);
  });
});
