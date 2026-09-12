import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 配線の抜けを落とす。**新しい編集面が増えたときに気づける形**にしてある。
 *
 * 共通エンジン (`createRichTextEngineExtensions`) を通らない面が 2 つあり
 * (`CommentRichTextEditor` / `BoxTitleEditor`)、そこを見落とすと穴が残る。
 */
const SOURCE_ROOT = new URL("../../", import.meta.url);

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, directory));
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [fileURLToPath(new URL(entry.name, directory))]
      : [];
  });
}

interface EditorCallSite {
  file: string;
  line: number;
  guarded: boolean;
}

const GUARD_SOURCES = ["createRichTextEngineExtensions", "NativeHistoryGuardExtension"];

/** `extensions:` の中に guard へ到達する識別子が実際に現れるか (コメントは数えない)。 */
function isGuarded(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return false;
  }
  const extensions = options.properties.find((property) =>
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && property.name.text === "extensions");
  if (!extensions || !ts.isPropertyAssignment(extensions)) {
    return false;
  }

  let guarded = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && GUARD_SOURCES.includes(node.text)) {
      guarded = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(extensions.initializer);
  return guarded;
}

/**
 * `useEditor({...})` / `new Editor({...})` の**呼び出しごと**に、その引数の中で guard に
 * 到達しているかを見る。
 *
 * ファイル全体に guard の名前が出てくるかで判定すると、**すでにエンジンを import している
 * ファイルが 2 つ目のエディタを手組みの拡張リストで足したときに緑のまま通る** —
 * このテストが捕まえると謳っているまさにその回帰。だから呼び出し単位で見る。
 *
 * 判定は `extensions:` の**中に実際に現れる識別子**で行う。ソーステキストの部分一致に
 * すると、このリポジトリの厚い日本語コメント文化のもとでは「ここに guard は要らない」と
 * いう**注記がそのまま緑にする**。コメントは AST のノードではないので識別子だけを見れば
 * 混入しない。
 *
 * **残る限界 (できないことを「できる」と書かない)**:
 * - 走査するのは `apps/desktop/src` 配下だけ。テスト名は「Tiptap エディタを作る全ての
 *   呼び出し」と読めるが、**その前提は暗黙**である (今日の 6 箇所はすべてこの配下)。
 * - **拡張リストを呼び出しの外 (変数や `useMemo`) で組み立てる書き方は追えない**。
 *   今日の 6 箇所はすべて `extensions:` にインラインで書いているので成立している。
 *   外で組む面が増えたら「guard が無い」と誤検知して落ちる (黙って通るより落ちるほうを選ぶ)。
 * - `createRichTextEngineExtensions` を経由していれば guard 済みとみなす。エンジンから
 *   guard を外したら、別の検査 ("keeps the guard in the shared engine") が落ちる。
 */
function editorCallSites(): EditorCallSite[] {
  return sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    if (!/\buseEditor\(|\bnew Editor\(/u.test(source)) {
      return [];
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const sites: EditorCallSite[] = [];
    const visit = (node: ts.Node) => {
      const isUseEditor = ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "useEditor";
      const isNewEditor = ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "Editor";
      if (isUseEditor || isNewEditor) {
        sites.push({
          file: file.slice(file.indexOf("/src/") + 1),
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          guarded: isGuarded(node.arguments?.[0]),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return sites;
  });
}

describe("native history guard wiring", () => {
  it("guards every call that builds a Tiptap editor", () => {
    const sites = editorCallSites();

    // 抽出が壊れて空配列のまま「全部満たした」で緑にならないための床。
    // **今日の数を固定する意図ではない** (増えたぶんは下の unguarded 検査が受け持つ)。
    // 逆に面を 1 つ消すと「抽出が壊れた」と読める形でここが落ちる — その場合は床を下げる。
    expect(sites.length).toBeGreaterThanOrEqual(6);

    const unguarded = sites
      .filter((site) => !site.guarded)
      .map((site) => `${site.file}:${site.line}`);

    expect(unguarded).toEqual([]);
  });

  it("keeps the guard in the shared engine so new surfaces inherit it", () => {
    const engine = readFileSync(fileURLToPath(new URL("rich-text-engine.ts", import.meta.url)), "utf8");
    expect(engine).toContain("NativeHistoryGuardExtension");
  });

  it("keeps a receiver for the guard's window event", () => {
    // 受け口が無いと guard はネイティブ undo を止めるだけになり、⌘Z が**無音で死ぬ**。
    // 止める側と受ける側は必ず対で存在する。
    const shell = readFileSync(
      fileURLToPath(new URL("../editor/EditorShell.tsx", import.meta.url)),
      "utf8",
    );
    expect(shell).toContain("NATIVE_HISTORY_COMMAND_EVENT");
    expect(shell).toMatch(/addEventListener\(NATIVE_HISTORY_COMMAND_EVENT/u);

    // 後始末 (開いているメニュー・ポップオーバーを閉じる) は、キーボード /
    // コマンドパレット / ネイティブメニューが通る経路と**同じ関数で共有する**。
    // 片方だけ後始末を飛ばすと、ポップオーバーが「消えた内容の状態」を表示したまま残る。
    //
    // 出現回数では見ない (宣言・コメント・deps 配列が数を水増しして、呼び出しを 1 つ
    // 落としても閾値を割らない)。**受け口の中身を切り出して**そこに call があることを見る。
    const handlerStart = shell.indexOf("const handleNativeHistoryCommand");
    const handlerEnd = shell.indexOf("addEventListener(NATIVE_HISTORY_COMMAND_EVENT", handlerStart);
    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const receiverBody = shell.slice(handlerStart, handlerEnd);
    expect(receiverBody).toContain("closeTransientCommandSurfaces()");

    // 共有相手は routing hook が公開する runner。Shell の宣言・コメントだけで
    // 通さず、実際の runner 本文に後始末が残っていることを見る。
    const routing = readFileSync(
      fileURLToPath(new URL("../editor/editor-shell/use-editor-command-routing.ts", import.meta.url)),
      "utf8",
    );
    const actions = readFileSync(
      fileURLToPath(new URL("../editor/editor-shell/editor-command-actions.ts", import.meta.url)),
      "utf8",
    );
    expect(routing).toContain("runShortcutCommandRef.current = createEditorCommandRunner(customCommands, actions)");
    const runnerStart = actions.indexOf("return (commandId: EditorCommandId) => {");
    expect(runnerStart).toBeGreaterThan(-1);
    expect(actions.slice(runnerStart)).toContain("closeTransientCommandSurfaces()");
  });

  it("routes the local-draft surfaces to their own history", () => {
    // 振り分けの規則: **その面の内容が SigmaDoc に入るなら SigmaDoc へ戻す /
    // 入らない (ローカルな下書き state) なら、その面自身の履歴へ戻す。**
    // 下の 2 つは後者 — 箱タイトルはダイアログ内の入力、コメントは投稿するまで
    // SigmaDoc に 1 文字も入らない下書き。既定のまま SigmaDoc へ委譲すると、
    // 打った内容はそのままで無関係な本文編集が巻き戻る。
    const localDraftSurfaces = ["BoxTitleEditor.tsx", "CommentRichTextEditor.tsx"];
    const notRouted = localDraftSurfaces.filter((name) => {
      const source = readFileSync(
        fileURLToPath(new URL(`../editor/${name}`, import.meta.url)),
        "utf8",
      );
      return !/NativeHistoryGuardExtension\.configure\(/u.test(source)
        || !/commands\.undo\(\)/u.test(source)
        // 自前の履歴が要る。`undoRedo: false` だと戻す先が無い。
        || /undoRedo:\s*false/u.test(source);
    });
    expect(notRouted).toEqual([]);
  });

  it("never imports the editor shell from the tiptap layer", () => {
    // `components/tiptap` → `components/editor` の逆流を作らない。
    // 受け渡しは window CustomEvent (先例: inline-math-extension の requestInlineMathEdit)。
    const guard = readFileSync(fileURLToPath(new URL("native-history-guard.ts", import.meta.url)), "utf8");
    expect(guard).not.toMatch(/from\s+"@\/components\/editor/u);
  });
});
