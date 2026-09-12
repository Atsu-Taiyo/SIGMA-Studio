import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EDITOR_COMMAND_SHORTCUTS,
  formatElectronAccelerator,
  getCommandShortcutDefinition,
} from "@/lib/editor-command-shortcuts";

/**
 * ネイティブメニューの accelerator と、レンダラのコマンド既定バインドを突き合わせる。
 *
 * **この 2 つは同じ操作の同じキーを別々の場所に書いていて、結ぶものが何も無かった。**
 * それが ⌘P 衝突 (メニューが ⌘P を先取りして、レンダラのリスナーには永久に届かない)
 * を生んだ構造欠陥そのものなので、ここで固定する。
 *
 * Electron のアプリケーションメニュー accelerator は **レンダラの keydown より先に発火する**。
 * つまりズレたときに壊れるのは「メニューの表示」ではなく「レンダラ側のショートカット」で、
 * 手で触ってもなかなか気づけない。
 *
 * **立てる不変条件**: ネイティブメニューがレンダラの既定バインドと同じキーを持つなら、
 * その項目は **ネイティブ role ではなく、同じコマンドへ配る click を持たねばならない**。
 *
 * 「メニューにキーを持たせない」形では検査できない。`registerAccelerator: false` は
 * electron.d.ts で `@platform linux,win32` と明記されていて **macOS では契約上どちらでもよい**
 * ため、そこへ乗せた不変条件は当プロダクトの主対象プラットフォームで検証不能になる。
 * キーは持たせたまま「配る先」を縛るほうが強く、かつ実際に検証できる。
 *
 * **ここが見るのは `main.ts` のテンプレートに書かれた項目だけ**なので、
 * `{ role: "editMenu" }` のような **合成 role は禁止**する (下の
 * "never expands a composite role" )。合成 role は ⌘Z / ⇧⌘Z / ⌘0 / ⌘± を
 * ソースに文字列として現さないまま持ち込むので、この検査の目をすり抜けたまま
 * レンダラのショートカットを丸ごと殺せてしまう —— 実際 ⌘Z はそれで死んでいた。
 * 単独 role (`{ role: "cut" }` 等) は許すが、その既定 accelerator は
 * {@link DEFAULT_ROLE_ACCELERATORS} に写して検査対象に含める。
 */

/**
 * コメントを空白に潰した `main.ts`。**検査はこの上でだけ行う。**
 *
 * 「なぜ合成 role を置かないか」をコードのすぐ横に書くと、その説明文に含まれる
 * `role: "editMenu"` を検査自身が実装として読んでしまう。文字列リテラルは残すので
 * `"https://…"` の `//` をコメント開始と読み違えないよう、文字列判定を先に置く。
 */
function stripComments(source: string): string {
  let stripped = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      stripped += char;
      if (char === "\\") {
        stripped += next ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      stripped += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      stripped += " ";
      continue;
    }
    stripped += char;
  }
  return stripped;
}

const rawMainSource = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8");

/**
 * `buildMenu()` の本体だけを切り出してからコメントを潰す。**ファイル全体を舐めない。**
 *
 * `main.ts` の別の場所には `/\\"/g` のような**引用符を含む正規表現リテラル**があり、
 * 素朴な文字列スキャナはそこで引用符の内外を取り違える。検査したいのはメニュー
 * テンプレートだけなので、先に範囲を切って危険な行を射程から外す。
 */
function readBuildMenuSource(): string {
  const start = rawMainSource.indexOf("function buildMenu()");
  if (start < 0) {
    return "";
  }
  const end = rawMainSource.indexOf("\nfunction ", start + 1);
  return stripComments(rawMainSource.slice(start, end < 0 ? undefined : end));
}

const mainSource = readBuildMenuSource();

/** `sendMenuAction("<action>")` を持つメニュー項目 → 対応するコマンド id。 */
const MENU_ACTION_TO_COMMAND_ID: Readonly<Record<string, string>> = {
  "print-document": "view.printPreview",
  "new-document": "document.new",
  undo: "edit.undo",
  redo: "edit.redo",
};

/**
 * Electron が role から持ち込む既定 accelerator。**ソースに文字列として現れない**ので
 * ここに写す。表記は `formatElectronAccelerator` の出力形 (`CmdOrCtrl+…`) に正規化して
 * ある — 突き合わせる相手がその形だから。元の Electron 表記が違う場合は行末に併記する。
 *
 * `null` = そもそもキーを持たない role。
 */
const DEFAULT_ROLE_ACCELERATORS: Readonly<Record<string, string | null>> = {
  about: null,
  services: null,
  hide: "Command+H",
  hideOthers: "Command+Alt+H",
  unhide: null,
  quit: "CmdOrCtrl+Q",
  help: null,
  // Edit
  // undo / redo は使用そのものを禁止しているが、**ここにも載せる**。載せないと
  // `role: "undo"` を書き戻したとき accelerator が null 扱いになり、主検査
  // ("routes every renderer key…") の射程から静かに外れてしまう。
  undo: "CmdOrCtrl+Z",
  redo: "CmdOrCtrl+Shift+Z", // Windows のみ Control+Y
  cut: "CmdOrCtrl+X",
  copy: "CmdOrCtrl+C",
  paste: "CmdOrCtrl+V",
  pasteAndMatchStyle: "CmdOrCtrl+Shift+V", // Electron: Shift+CommandOrControl+V
  delete: null, // macOS は無印。Windows/Linux は Delete
  selectAll: "CmdOrCtrl+A",
  startSpeaking: null,
  stopSpeaking: null,
  // View
  reload: "CmdOrCtrl+R",
  forceReload: "CmdOrCtrl+Shift+R",
  toggleDevTools: "Command+Alt+I", // Windows/Linux: Ctrl+Shift+I
  resetZoom: "CmdOrCtrl+0",
  zoomIn: "CmdOrCtrl+=", // Electron: CommandOrControl+Plus (同じ物理キー)
  zoomOut: "CmdOrCtrl+-",
  togglefullscreen: "Control+Command+F", // Windows/Linux: F11
};

/**
 * まだ展開していない合成 role と、それが持ち込むキー。
 *
 * `windowMenu` の ⌘M / ⌘W は **レンダラが持ってはいけない OS 側のキー**なので展開しない。
 * 代わりに「レンダラのどのコマンドもこの 2 キーを既定バインドに持たない」を逆向きに検査する。
 */
const ALLOWED_COMPOSITE_ROLES: Readonly<Record<string, readonly string[]>> = {
  windowMenu: ["CmdOrCtrl+M", "CmdOrCtrl+W"],
};

/** 展開を禁じる合成 role。中身がソースに現れないので、この検査の射程から丸ごと逃げてしまう。 */
const FORBIDDEN_COMPOSITE_ROLES = ["appMenu", "fileMenu", "editMenu", "viewMenu"] as const;

/**
 * 今もネイティブが握っていて、レンダラ側の同名コマンドに届かないと**分かっている**キー。
 *
 * ⌘0 / ⌘± のズーム一本化は別 WI。ここに名前で書くのは、散文の但し書きと違って
 * **直したときに消し忘れを落とせる**から (下の "stale" 検査)。
 */
const KNOWN_NATIVE_KEY_OWNERS: readonly string[] = ["view.zoomIn", "view.zoomOut", "view.zoomReset"];

/**
 * 既定のキー等価を **手放してはいけない** Edit 系 role。
 *
 * macOS では ⌘C / ⌘V は AppKit のメニューキー等価から NSResponder の `copy:` / `paste:` へ
 * 届く。このアプリのクリップボード経路は DOM の clipboard イベント駆動で keydown の
 * フォールバックが無いため、ここのキー等価を落とすとアプリ全体でコピー & ペーストが死ぬ。
 */
const RENDERER_OWNED_ROLES = ["cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"] as const;

interface MenuItem {
  label: string;
  /** 単独 role 項目なら role 名。`sendMenuAction` 項目なら null。 */
  role: string | null;
  accelerator: string | null;
  /** `registerAccelerator` を **書いているか**。macOS 非対応の指定なので使わせない。 */
  declaresRegisterAccelerator: boolean;
  action: string | null;
}

/**
 * `at` を含むオブジェクトリテラルを `{` … 対応する `}` まで切り出す。
 *
 * 前向きに数えるのは、`registerAccelerator` 等の指定が `role:` / `click:` の**後ろに**
 * 書かれうるため。文字列リテラルの中の波括弧は数えない (コメントは既に潰してある)。
 */
function readEnclosingObjectLiteral(at: number): string {
  const open = mainSource.lastIndexOf("{", at);
  if (open < 0) {
    return "";
  }
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < mainSource.length; index += 1) {
    const char = mainSource[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return mainSource.slice(open, index + 1);
      }
    }
  }
  return "";
}

/**
 * `sendMenuAction("…")` と `role: "…"` を起点に、それを含むオブジェクトリテラルを切り出す。
 *
 * 1 行で書かれていても複数行に折り返されていても拾えること。**正規表現で
 * 「1 行の形」だけを見に行くと、整形しただけで検査が黙って 0 件になる**
 * (実測: `registerAccelerator` を足して複数行にしたら 1 行版は何も拾わなくなった)。
 */
function readMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  const collect = (pattern: RegExp, toItem: (slice: string, captured: string) => MenuItem) => {
    for (const match of mainSource.matchAll(pattern)) {
      const slice = readEnclosingObjectLiteral(match.index ?? 0);
      if (!slice) {
        continue;
      }
      items.push(toItem(slice, match[1] ?? ""));
    }
  };

  collect(/sendMenuAction\("([^"]+)"\)/gu, (slice, action) => ({
    label: /label:\s*"([^"]+)"/u.exec(slice)?.[1] ?? "",
    role: null,
    accelerator: /accelerator:\s*"([^"]+)"/u.exec(slice)?.[1] ?? null,
    declaresRegisterAccelerator: /registerAccelerator\s*:/u.test(slice),
    action,
  }));

  collect(/\brole:\s*"([A-Za-z]+)"/gu, (slice, role) => ({
    label: /label:\s*"([^"]+)"/u.exec(slice)?.[1] ?? "",
    role,
    accelerator:
      /accelerator:\s*"([^"]+)"/u.exec(slice)?.[1] ?? DEFAULT_ROLE_ACCELERATORS[role] ?? null,
    declaresRegisterAccelerator: /registerAccelerator\s*:/u.test(slice),
    action: null,
  }));

  return items;
}

function rendererCommandsByAccelerator(): Map<string, string[]> {
  const byAccelerator = new Map<string, string[]>();
  for (const command of EDITOR_COMMAND_SHORTCUTS) {
    const accelerator = formatElectronAccelerator(command.defaultBinding);
    if (!accelerator) {
      continue;
    }
    byAccelerator.set(accelerator, [...(byAccelerator.get(accelerator) ?? []), command.id]);
  }
  return byAccelerator;
}

describe("native menu accelerators", () => {
  it("keeps string literals while stripping comments", () => {
    // ヘルパが壊れると **このファイルの検査が軒並み黙って通る**。URL の `//` を
    // コメント開始と読み違えるのが最も踏みやすいので、そこを名指しで固定する。
    expect(stripComments('openExternal("https://example.test/a"); // note')).toBe(
      'openExternal("https://example.test/a"); \n',
    );
    expect(stripComments('const a = 1; /* role: "editMenu" */ const b = 2;')).toBe(
      "const a = 1;   const b = 2;",
    );
  });

  it("finds the menu template in main.ts", () => {
    // 抽出に失敗したときに「全部一致した」で緑にならないよう、最低件数を先に固定する。
    expect(mainSource).toContain("Menu.setApplicationMenu");
    const items = readMenuItems();
    expect(items.filter((item) => item.action !== null).length).toBeGreaterThanOrEqual(4);
    expect(items.filter((item) => item.role !== null).length).toBeGreaterThanOrEqual(5);
    expect(items.map((item) => item.action)).toContain("print-document");
    expect(items.find((item) => item.action === "print-document")?.label).toBe("PDF Preview…");
  });

  it("keeps every mapped menu accelerator equal to the command default binding", () => {
    const mismatches = readMenuItems()
      .filter((item) => item.action !== null && MENU_ACTION_TO_COMMAND_ID[item.action] !== undefined)
      .map((item) => {
        const commandId = MENU_ACTION_TO_COMMAND_ID[item.action ?? ""] ?? "";
        const expected = formatElectronAccelerator(getCommandShortcutDefinition(commandId).defaultBinding);
        return { action: item.action, commandId, expected, actual: item.accelerator };
      })
      .filter((row) => row.actual !== row.expected);

    expect(mismatches).toEqual([]);
  });

  it("routes every renderer key the menu owns to the same renderer command", () => {
    // ⌘P / ⌘Z 事故そのものを検知する不変条件。メニューがレンダラ既定バインドと同じキーを
    // 持つなら、その項目は **同じコマンドへ配る click** を持たねばならない。ネイティブ role の
    // ままだと、押した先は webContents.undo() のようなレンダラの与り知らぬ既定動作になり、
    // そのコマンドは永久に届かない。**キーを持つか否かではなく配る先を縛る** のは、
    // キーを手放す指定 (registerAccelerator) が macOS で契約上効くとは限らないから。
    const rendererByAccelerator = rendererCommandsByAccelerator();

    const misrouted = readMenuItems()
      .filter((item) => item.accelerator)
      .flatMap((item) => {
        const dispatched = item.action ? MENU_ACTION_TO_COMMAND_ID[item.action] : undefined;
        return (rendererByAccelerator.get(item.accelerator ?? "") ?? [])
          .filter((commandId) => commandId !== dispatched)
          .map((commandId) => ({
            accelerator: item.accelerator,
            menu: item.action ?? item.role,
            swallows: commandId,
          }));
      });

    expect(misrouted.filter((row) => !KNOWN_NATIVE_KEY_OWNERS.includes(row.swallows))).toEqual([]);

    // 名前で残した既知の重なりが実際には解消済み = 消し忘れ。散文の但し書きでは落とせない。
    const stale = KNOWN_NATIVE_KEY_OWNERS.filter(
      (commandId) => !misrouted.some((row) => row.swallows === commandId),
    );
    expect(stale).toEqual([]);
  });

  it("covers every mapped action with a real menu item", () => {
    // 対応表に書いたのにメニューから消えた (= 対応が形骸化した) ことを落とす。
    const actions = new Set(readMenuItems().map((item) => item.action));
    const missing = Object.keys(MENU_ACTION_TO_COMMAND_ID).filter((action) => !actions.has(action));
    expect(missing).toEqual([]);
  });

  it("never expands a composite role into the template", () => {
    // 合成 role の中身はソースに現れないので、上の検査を丸ごとすり抜けて
    // レンダラのキーを奪える。明示テンプレートに展開して検査下に置く。
    const used = FORBIDDEN_COMPOSITE_ROLES.filter((role) =>
      new RegExp(`role:\\s*"${role}"`, "u").test(mainSource),
    );
    expect(used).toEqual([]);
  });

  it("never uses the undo or redo roles", () => {
    // `role` を付けると Electron は `click` を無視して webContents.undo() を呼ぶ。
    // それは PM が所有する contenteditable を外から書き換える Blink のネイティブ undo で、
    // レンダラの edit.undo には決してならない。undo / redo だけは role を使えない。
    const used = ["undo", "redo"].filter((role) => new RegExp(`role:\\s*"${role}"`, "u").test(mainSource));
    expect(used).toEqual([]);
  });

  it("knows the default accelerator of every role in the template", () => {
    // 未知の role を足したら「accelerator 不明のまま検査対象外」で静かに通ってしまう。
    const unknown = readMenuItems()
      .map((item) => item.role)
      .filter((role): role is string => role !== null)
      .filter(
        (role) =>
          !(role in DEFAULT_ROLE_ACCELERATORS) && ALLOWED_COMPOSITE_ROLES[role] === undefined,
      );
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("keeps the default key equivalents on the clipboard and selection roles", () => {
    // これらの role からキー等価を外すと macOS でコピー & ペーストがアプリ全体で死ぬ
    // (RENDERER_OWNED_ROLES の宣言のコメント参照)。素の role のままであることを固定する。
    const occurrences = new Map<string, MenuItem[]>();
    for (const item of readMenuItems()) {
      if (item.role === null) {
        continue;
      }
      occurrences.set(item.role, [...(occurrences.get(item.role) ?? []), item]);
    }

    expect(RENDERER_OWNED_ROLES.filter((role) => !occurrences.has(role))).toEqual([]);

    // **全出現**を見る。delete / selectAll は isMac 分岐と非 isMac 分岐の両方に現れるので、
    // role ごとに 1 件だけ残す形 (Map への詰め直し) だと片方が壊れても緑のままになる。
    const declaring = RENDERER_OWNED_ROLES.flatMap((role) =>
      (occurrences.get(role) ?? [])
        .map((item, index) => ({ role, index, declares: item.declaresRegisterAccelerator }))
        .filter((row) => row.declares),
    );
    expect(declaring).toEqual([]);
  });

  it("keeps the composite roles it still uses away from renderer commands", () => {
    // windowMenu は展開しない代わりに、そのキーをレンダラが要求していないことを逆向きに見る。
    const rendererByAccelerator = rendererCommandsByAccelerator();
    const conflicts = Object.entries(ALLOWED_COMPOSITE_ROLES)
      .filter(([role]) => new RegExp(`role:\\s*"${role}"`, "u").test(mainSource))
      .flatMap(([role, accelerators]) =>
        accelerators.flatMap((accelerator) =>
          (rendererByAccelerator.get(accelerator) ?? []).map((commandId) => ({
            role,
            accelerator,
            swallows: commandId,
          })),
        ),
      );
    expect(conflicts).toEqual([]);
  });
});

/**
 * メニューが送るアクションを、レンダラが本当に受けているか。
 *
 * accelerator を手放した以上、**メニュークリックが唯一の到達経路**になる項目がある。
 * `sendMenuAction("undo")` を足しても `useDesktopMenuActions` 側の分岐を足し忘れると、
 * メニューは無反応のまま静かに壊れる (テンプレート側だけを見る上の検査は気づけない)。
 */
const shellSource = readFileSync(
  fileURLToPath(new URL("../src/components/editor/EditorShell.tsx", import.meta.url)),
  "utf8",
);
const menuActionsSource = stripComments(readFileSync(
  fileURLToPath(new URL("../src/components/editor/editor-shell/use-desktop-menu-actions.ts", import.meta.url)),
  "utf8",
));

describe("native menu actions", () => {
  it("dispatches every menu action in the renderer", () => {
    // 判定はコードの形に寄せず「アクション名がディスパッチの比較として現れるか」で見る
    // (if/else でも switch でも通るように)。
    // 配送実装だけ残して shell から hook を外しても、検査が通らないようにする。
    expect(shellSource).toContain('from "./editor-shell/use-desktop-menu-actions"');
    expect(shellSource).toMatch(/\buseDesktopMenuActions\(\s*\{/u);
    expect(menuActionsSource).toContain("onMenuAction(");
    const actions = [
      ...new Set(
        readMenuItems()
          .map((item) => item.action)
          .filter((action): action is string => action !== null),
      ),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(4);
    const unhandled = actions.filter(
      (action) =>
        !menuActionsSource.includes(`action === "${action}"`) && !menuActionsSource.includes(`case "${action}"`),
    );
    expect(unhandled).toEqual([]);
  });
});
