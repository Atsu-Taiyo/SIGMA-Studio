import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import {
  LAYOUT_STORAGE_KEY,
  collectDocsCommands,
  collectWordCommands,
  switchToWordLayout,
  type CommandIndex,
} from "./ui-layout-chrome";

/**
 * 2系統のクローム（Googleドキュメント風 / Word風リボン）の **動線パリティ**。
 *
 * 「どちらのレイアウトでも同じコマンド集合に到達できる」ことを **双方向** で固定する。
 * 片方向だけだと、Word風にだけ足したコマンドが docs から永久に消えたまま緑になる
 * （実際に Word風の初版では、設定・ワークスペース・新規教材の動線が docs から
 * 消えたのに片方向テストは緑のままだった）。
 *
 * ここは集合の検査に専念する。タブ操作・Backstage・折りたたみ・高さといった
 * 「挙動」は ui-layout-ribbon.spec.ts、docs 側の DOM 署名は
 * editor-chrome-signature.spec.ts が持つ。
 *
 * **新しいコマンドを片方だけに足すとこのテストが落ちる。** それが目的なので、
 * 落ちたら許容リストに理由を書いて隠すのではなく、まず「もう片方のどこに置くか」を決めること。
 */

/**
 * 名前が違うだけで、機能は両方に在るもの。docs 名 → word 名。
 *
 * 名前替えは «本当に名前が違うもの» だけに絞る。開けば見えるメニュー
 * （エクスポートのサブメニュー・新規教材のホバーメニュー）は収集側で開いているので、
 * 「親の名前しか読めていない」ことを理由にした名前替えは要らない。
 */
const RENAMED: Readonly<Record<string, string>> = {
  // docs は右上のアイコン1つに «新規教材» としてまとまっている（押すと空の教材が増え、
  // ホバーでテンプレートも選べる）。Word風は Backstage の「新規」で2つに分かれる。
  "新規教材": "空の教材",
  // docs のファイルメニューでは «エクスポート» が子（JSON / PDF）を持つ親項目。
  // Word風は Backstage の「エクスポート」セクションに子だけが並ぶ（親に当たる
  // コマンドは無い）。Backstage の左ナビにも同名のセクションがあるが、ナビは
  // コマンド集合に入れていないので、ここで明示的に対応付ける。
  "エクスポート": "JSONをエクスポート",
};

/**
 * docs のクロームにしか無い構造部品。理由必須。
 *
 * 現状は空。docs 側にしか無いコマンドが生まれたら、それは Word風の動線が欠けている
 * ということなので、まず Word風側に置き場所を作ること。
 */
const DOCS_ONLY: Readonly<Record<string, string>> = {};

/** Word風のクロームにしか無い構造部品・コマンド。理由必須。 */
const WORD_ONLY: Readonly<Record<string, string>> = {
  "リボンを折りたたむ": "Word固有のクローム操作。docsは1段ツールバーで折りたためない",
  "ページ設定ダイアログを開く": "ダイアログランチャー。docsは設定メニューの『ページ設定』が同じ機能で、そちらは両方に在る",
  // 段組みは機能としては両方に在る（docs はキャンバスの右クリックメニュー）。
  // ここが見ているのは «クロームから到達できるか» なので、docs のクロームに無い以上
  // word-only 扱いになる。docs のクロームへ足すこと自体は可能で、そうすると
  // editor-chrome-signature.spec.ts の署名を張り替える判断が要る、というだけ。
  "2段組": "機能はdocsにもある（キャンバスの右クリックメニュー）が、docsのクロームには置いていない",
  "3段組": "機能はdocsにもある（キャンバスの右クリックメニュー）が、docsのクロームには置いていない",
  "4段組": "機能はdocsにもある（キャンバスの右クリックメニュー）が、docsのクロームには置いていない",
  "段組を解除": "機能はdocsにもある（キャンバスの右クリックメニュー）が、docsのクロームには置いていない",
};

/**
 * 収集していない面と、その理由。
 *
 * - **Backstage の左ナビ**（← 戻る / ホーム / 新規 / 開く / 情報 / エクスポート / オプション /
 *   ヘルプ）はセクション切替であってコマンドではないので、収集は内容側
 *   (`.ribbon-backstage-pane`) に絞っている。ここを許容リストで免除する形にすると、
 *   **同じ名前の本物の Word風専用コマンドが将来そっと免除される**（「ホーム」「新規」
 *   「開く」…はどれも普通のコマンド名になりうる）。ナビの項目名そのものは
 *   ui-layout-ribbon.spec.ts が固定している。
 * - 「リボンを展開」は折りたたみ中にしか無いボタン。折りたたみは «コマンドの到達性» ではなく
 *   クロームの状態なので、この集合検査では畳まずに巡回する（挙動は ui-layout-ribbon.spec.ts）。
 * - リボンのタブ名・docs のアプリメニューの trigger は aria-label を持たずテキストだけなので、
 *   両側とも収集対象から外れて対称。
 */

/**
 * 「どこかに有効な置き場所があるか」を、名前替えの別名まで含めて解く。
 *
 * 直接ヒットしても **無効だった場合は別名も見る**。片方に無効なまま名前が残っていると
 * （例: 使えない `新規教材` が残っていて、実際の操作は `空の教材` に移っている）、
 * 直接ヒットだけを見る実装は「使えない」と誤判定して偽の赤を出す。
 */
function resolveWithAlias(command: string, target: CommandIndex, alias: string | undefined): boolean | undefined {
  const direct = target.get(command);
  const aliased = alias === undefined ? undefined : target.get(alias);
  if (direct === undefined && aliased === undefined) {
    return undefined;
  }
  return (direct ?? false) || (aliased ?? false);
}

function resolveInWord(command: string, word: CommandIndex): boolean | undefined {
  return resolveWithAlias(command, word, RENAMED[command]);
}

function resolveInDocs(command: string, docs: CommandIndex): boolean | undefined {
  const original = Object.entries(RENAMED).find(([, wordName]) => wordName === command)?.[0];
  return resolveWithAlias(command, docs, original);
}

test.beforeEach(async ({ page }) => {
  // 既定（Googleドキュメント風）で起動する。切り替えは必ずUI操作で行う。
  await installDesktopRuntimeMock(page, sampleDocument, {
    uiLayout: { mode: "docs" },
    preserveStorageKeys: [LAYOUT_STORAGE_KEY],
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
});

test("both chromes reach the same set of commands, in both directions", async ({ page }) => {
  // 両レイアウトを «全部の面» 巡るので、既定の1テスト枠では足りない。
  test.slow();

  const docs = await collectDocsCommands(page);
  await switchToWordLayout(page);
  const word = await collectWordCommands(page);

  // --- サニティ: そもそも十分な数を読めているか -------------------------------
  // 収集が壊れて空に近くなると、差集合は当然空になり «全部緑» に見える。
  expect(docs.size).toBeGreaterThan(30);
  expect(word.size).toBeGreaterThan(30);
  expect([...docs.values()].filter(Boolean).length).toBeGreaterThan(30);
  expect([...word.values()].filter(Boolean).length).toBeGreaterThan(30);

  // --- 1. docs ⊆ word ---------------------------------------------------------
  const missingInWord = [...docs.keys()]
    .filter((command) => !(command in DOCS_ONLY))
    .filter((command) => resolveInWord(command, word) === undefined);
  expect(missingInWord, "Googleドキュメント風にしか無いコマンド（Word風の置き場所を決めること）").toEqual([]);

  // --- 2. word ⊆ docs ---------------------------------------------------------
  const missingInDocs = [...word.keys()]
    .filter((command) => !(command in WORD_ONLY))
    .filter((command) => resolveInDocs(command, docs) === undefined);
  expect(missingInDocs, "Word風にしか無いコマンド（Googleドキュメント風の置き場所を決めること）").toEqual([]);

  // --- 3/4. 「有効なものは有効」を両方向で ------------------------------------
  // 置き場所があっても常に disabled なら到達できたことにならない。
  const unusableInWord = [...docs.entries()]
    .filter(([command]) => !(command in DOCS_ONLY))
    .filter(([command, enabledInDocs]) => enabledInDocs && resolveInWord(command, word) === false)
    .map(([command]) => command);
  expect(unusableInWord, "docsでは使えるのにWord風ではどこでも無効なコマンド").toEqual([]);

  const unusableInDocs = [...word.entries()]
    .filter(([command]) => !(command in WORD_ONLY))
    .filter(([command, enabledInWord]) => enabledInWord && resolveInDocs(command, docs) === false)
    .map(([command]) => command);
  expect(unusableInDocs, "Word風では使えるのにdocsではどこでも無効なコマンド").toEqual([]);

  // --- 5. 許容リストの腐敗検出 -------------------------------------------------
  // 実体の無いエントリが残ると、そのぶん検査が緩む（消えたコマンドを許容し続ける）。
  const staleRenamedDocsSide = Object.keys(RENAMED).filter((command) => !docs.has(command));
  expect(staleRenamedDocsSide, "RENAMED の docs 側の名前が実在しない").toEqual([]);
  const staleRenamedWordSide = Object.values(RENAMED).filter((command) => !word.has(command));
  expect(staleRenamedWordSide, "RENAMED の word 側の名前が実在しない").toEqual([]);
  const staleDocsOnly = Object.keys(DOCS_ONLY).filter((command) => !docs.has(command));
  expect(staleDocsOnly, "DOCS_ONLY のエントリが docs に実在しない").toEqual([]);
  const staleWordOnly = Object.keys(WORD_ONLY).filter((command) => !word.has(command));
  expect(staleWordOnly, "WORD_ONLY のエントリが word に実在しない").toEqual([]);

  // 許容リストは «理由» とセットでしか増やせない。
  for (const [command, reason] of [...Object.entries(DOCS_ONLY), ...Object.entries(WORD_ONLY)]) {
    expect(reason.length, `${command} の許容理由が空`).toBeGreaterThan(10);
  }
});
