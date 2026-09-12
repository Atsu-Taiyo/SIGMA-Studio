// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  LOCAL_EDIT_HISTORY_ATTRIBUTE,
  deliverHistoryShortcutToFocusedSurface,
  isCommandShortcutBlockedByTarget,
  isCompositionStillActive,
  resolveEditorHistoryShortcutTarget,
  shouldEndCompositionForEvent,
} from "@/components/editor/editor-shell/command-shortcut-targets";
import { EDITOR_COMMAND_SHORTCUTS, getCommandTargetPolicy } from "@/lib/editor-command-shortcuts";

/**
 * 「いまフォーカスがある面で ⌘Z がどこへ届くか」の真理値表。
 *
 * ここが無条件ブロックだった頃、数式編集中・AI チャット入力欄・ダイアログ上で undo は
 * **ステータス表示すら無く無音で死んで**いた。逆にメニュー経路 (WI-1 以降 macOS では
 * これが唯一の入口) はこの判定を丸ごと迂回していて、AI チャット欄の ⌘Z が教材本体を
 * 巻き戻していた。**両経路が同じここを通る**のが WI-5 の中心。
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const target = document.body.querySelector<HTMLElement>("[data-target]");
  expect(target, "data-target を持つ要素が要る").not.toBeNull();
  return target as HTMLElement;
}

function resolve(target: EventTarget | null, direction: "undo" | "redo" = "undo", isComposing = false) {
  return resolveEditorHistoryShortcutTarget({ target, direction, isComposing });
}

describe("resolveEditorHistoryShortcutTarget", () => {
  it("sends a plain body caret to the document", () => {
    const target = mount('<div contenteditable="true" data-target>本文</div>');
    expect(resolve(target).kind).toBe("document");
  });

  it("keeps working inside a non-modal panel", () => {
    // グラフ設定パネルを開いたままでも undo は効かなければならない。
    const target = mount(
      '<div role="dialog" data-non-modal-surface><button data-target>閉じる</button></div>',
    );
    expect(resolve(target).kind).toBe("document");
  });

  it("refuses to reach the document from a modal dialog's non-input area", () => {
    // **DOM でも見る。** React の open フラグに載っていないダイアログ (表設定・色ピッカー・
    // 箱設定など) の上で ⌘Z を押すと、背後の文書へ突き抜けていた。目印は backdrop ——
    // このリポジトリで「背面を覆う面が前に出ている」を表しているのはこれ。
    const target = mount(
      '<div data-modal-backdrop><div role="dialog"><button data-target>OK</button></div></div>',
    );
    expect(resolve(target).kind).toBe("blockedByModalSurface");
  });

  it("keeps working inside a toolbar popover", () => {
    // `ToolbarPopover` の既定 role は "dialog"。フォントサイズ・色・線端のポップオーバーが
    // 全部モーダル扱いになると、**開いている間 ⌘Z が死ぬ**。backdrop は描かれない。
    const target = mount(
      '<div role="dialog" data-toolbar-popover><button data-target>16pt</button></div>',
    );
    expect(resolve(target).kind).toBe("document");
  });

  it("keeps working on the AI approval card", () => {
    // クリックでボタンにフォーカスが乗る。**「いまの適用を取り消したい」が最も起きやすい
    // 瞬間**なので、ここで無音になるのがいちばん困る。カード自身が非モーダルを名乗っている。
    const target = mount(
      '<section role="dialog" aria-modal="false"><button data-target>適用</button></section>',
    );
    expect(resolve(target).kind).toBe("document");
  });

  it("keeps working inside the comments panel", () => {
    // 本文を編集しながら開いておく面。`role="dialog"` を持つが背面は隔離していない。
    const target = mount('<aside role="dialog"><button data-target>返信</button></aside>');
    expect(resolve(target).kind).toBe("document");
  });

  it("leaves a text field to its own native undo", () => {
    // AI チャット・検索欄・リネーム欄。中身は SigmaDoc に一切入っていないので、ここで文書を
    // 戻すと「打った文は消えないまま教材だけ勝手に戻る」という最も驚く挙動になる。
    const target = mount("<textarea data-target></textarea>");
    expect(resolve(target).kind).toBe("nativeField");
  });

  it("leaves an input to its own native undo", () => {
    const target = mount('<input data-target value="名前" />');
    expect(resolve(target).kind).toBe("nativeField");
  });

  it("routes a local-draft surface to its own history", () => {
    // コメント下書き・箱タイトル。SigmaDoc に入らないので、その面の履歴へ戻す。
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" contenteditable="true" data-target>下書き</div>`,
    );
    const resolved = resolve(target);
    expect(resolved.kind).toBe("surfaceHistory");
  });

  it("yields to MathLive while it still has something to undo", () => {
    // 数式欄の打鍵は SigmaDoc/PM に入らない (コミットは Enter / blur / 矢印離脱のみ)。
    // まだ確定していない打鍵を戻す先は MathLive の履歴しかない。
    const target = mount("<math-field data-target></math-field>");
    Object.assign(target, { canUndo: () => true, canRedo: () => true });
    expect(resolve(target, "undo").kind).toBe("mathField");
    expect(resolve(target, "redo").kind).toBe("mathField");
  });

  it("falls through to the document when MathLive has nothing left", () => {
    // **ここが「無音で死なない」の肝。** 譲る先が空なら文書を戻す。
    const target = mount("<math-field data-target></math-field>");
    Object.assign(target, { canUndo: () => false, canRedo: () => false });
    expect(resolve(target, "undo").kind).toBe("document");
    expect(resolve(target, "redo").kind).toBe("document");
  });

  it("checks the direction that was actually asked for", () => {
    const target = mount("<math-field data-target></math-field>");
    Object.assign(target, { canUndo: () => true, canRedo: () => false });
    expect(resolve(target, "undo").kind).toBe("mathField");
    expect(resolve(target, "redo").kind).toBe("document");
  });

  it("does nothing while an IME composition is unresolved", () => {
    // 変換中に文書を差し替えると未確定の文字列ごと壊れる。
    const target = mount('<div contenteditable="true" data-target>あ</div>');
    expect(resolve(target, "undo", true).kind).toBe("ignore");
  });
});

describe("isCommandShortcutBlockedByTarget", () => {
  it("blocks edit history inside a dialog's non-input area", () => {
    const target = mount(
      '<div data-modal-backdrop><div role="dialog"><button data-target>OK</button></div></div>',
    );
    expect(isCommandShortcutBlockedByTarget(target, "editHistory", { primary: true, key: "z" }, "undo"))
      .toBe(true);
  });

  it("does not block edit history on a non-modal panel", () => {
    // グラフ設定パネルを開いたままでも undo は効かなければならない。
    const target = mount(
      '<div role="dialog" data-non-modal-surface><button data-target>閉じる</button></div>',
    );
    expect(isCommandShortcutBlockedByTarget(target, "editHistory", { primary: true, key: "z" }, "undo"))
      .toBe(false);
  });

  it("blocks edit history inside a text field", () => {
    const target = mount("<textarea data-target></textarea>");
    expect(isCommandShortcutBlockedByTarget(target, "editHistory", { primary: true, key: "z" }, "undo"))
      .toBe(true);
  });

  it("still blocks a document-surface command inside a dialog", () => {
    // 既存の振る舞いを変えない。`edit.bold` などは従来どおりダイアログ上で走らない。
    const target = mount('<div role="dialog"><button data-target>OK</button></div>');
    expect(isCommandShortcutBlockedByTarget(target, "documentSurface", { primary: true, key: "b" }, null))
      .toBe(true);
  });

  it("keeps a document-surface command alive on a non-modal panel", () => {
    const target = mount(
      '<div role="dialog" data-non-modal-surface><button data-target>閉じる</button></div>',
    );
    expect(isCommandShortcutBlockedByTarget(target, "documentSurface", { primary: true, key: "b" }, null))
      .toBe(false);
  });
});

describe("editor command target policy", () => {
  it("marks exactly the history commands as editHistory", () => {
    // **バインドが単一文字かで推測しない。** ユーザーがキーを再割り当てしても性質は変わらない。
    const editHistory = EDITOR_COMMAND_SHORTCUTS
      .filter((command) => command.targetPolicy === "editHistory")
      .map((command) => command.id);
    expect(editHistory).toEqual(["edit.undo", "edit.redo"]);
  });

  it("defaults every other command to documentSurface", () => {
    expect(getCommandTargetPolicy("edit.bold")).toBe("documentSurface");
    expect(getCommandTargetPolicy("custom.anything")).toBe("documentSurface");
    expect(getCommandTargetPolicy("edit.undo")).toBe("editHistory");
  });
});

/**
 * 届け先へ実際に届くか。**メニュー経路はここが唯一の配達口**で、届けそこねると
 * OS が既にキーを消費しているぶん無音で死ぬ。構造検査ではなく本物の DOM で見る。
 */
describe("deliverHistoryShortcutToFocusedSurface", () => {
  function deliver(target: Element | null, direction: "undo" | "redo" = "undo", overrides: {
    isComposing?: boolean;
    isModalSurfaceOpen?: boolean;
  } = {}) {
    return deliverHistoryShortcutToFocusedSurface({
      activeElement: target,
      direction,
      isComposing: overrides.isComposing ?? false,
      isModalSurfaceOpen: overrides.isModalSurfaceOpen ?? false,
    });
  }

  it("hands a plain body caret back to the caller", () => {
    const target = mount('<div contenteditable="true" data-target>本文</div>');
    expect(deliver(target)).toBe("document");
  });

  it("refuses to jump over an open modal", () => {
    // メニューがダイアログを飛び越えて背後の文書を戻さない。
    const target = mount('<div contenteditable="true" data-target>本文</div>');
    expect(deliver(target, "undo", { isModalSurfaceOpen: true })).toBe("ignored");
  });

  it("does nothing while an IME composition is unresolved", () => {
    const target = mount('<div contenteditable="true" data-target>あ</div>');
    expect(deliver(target, "undo", { isComposing: true })).toBe("ignored");
  });

  it("asks MathLive to undo when it still has something", () => {
    const target = mount("<math-field data-target></math-field>");
    const executed: string[] = [];
    Object.assign(target, {
      canUndo: () => true,
      canRedo: () => true,
      executeCommand: (selector: string) => {
        executed.push(selector);
        return true;
      },
    });

    expect(deliver(target, "redo")).toBe("handled");
    expect(executed).toEqual(["redo"]);
  });

  it("falls back to the document when MathLive has nothing left", () => {
    const target = mount("<math-field data-target></math-field>");
    Object.assign(target, { canUndo: () => false, executeCommand: () => true });
    expect(deliver(target, "undo")).toBe("document");
  });

  it("fires the field's own undo for a text input", () => {
    const target = mount("<textarea data-target></textarea>");
    const executed: string[] = [];
    Object.defineProperty(target.ownerDocument, "execCommand", {
      configurable: true,
      value: (command: string) => {
        executed.push(command);
        return true;
      },
    });

    expect(deliver(target, "undo")).toBe("handled");
    expect(executed).toEqual(["undo"]);
    expect(target.ownerDocument.activeElement).toBe(target);
  });

  it("signals a local-draft surface through the beforeinput channel", () => {
    // WI-2 で入れた `beforeinput` の受け口へ、OS が投げるのと同じ形の合図を送る。
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" contenteditable="true" data-target>下書き</div>`,
    );
    const seen: string[] = [];
    target.addEventListener("beforeinput", (event) => {
      seen.push((event as InputEvent).inputType);
    });

    expect(deliver(target, "redo")).toBe("handled");
    expect(seen).toEqual(["historyRedo"]);
  });

  it("keeps the document undo out of a surface that owns its own history", () => {
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" contenteditable="true" data-target>下書き</div>`,
    );
    expect(deliver(target, "undo")).not.toBe("document");
  });
});

/**
 * モーダルの扱いは**両方向に壊れうる**。列挙した open フラグに頼りすぎると列挙外の
 * ダイアログで文書へ突き抜け、フラグを先に見すぎるとフォーカスされた入力欄へ何も届かない。
 */
describe("modal surfaces", () => {
  it("still delivers to a focused field while a modal flag is up", () => {
    // **フラグを先に見て "ignored" で返すと、列挙した 12 面すべてで ⌘Z が完全に無音になる。**
    // macOS はメニューが ⌘Z を持っていてキーボードのフォールバックが無い。
    const target = mount("<textarea data-target></textarea>");
    const executed: string[] = [];
    Object.defineProperty(target.ownerDocument, "execCommand", {
      configurable: true,
      value: (command: string) => {
        executed.push(command);
        return true;
      },
    });

    const outcome = deliverHistoryShortcutToFocusedSurface({
      activeElement: target,
      direction: "undo",
      isComposing: false,
      isModalSurfaceOpen: true,
    });

    expect(outcome).toBe("handled");
    expect(executed).toEqual(["undo"]);
  });

  it("still delivers to a local-draft surface while a modal flag is up", () => {
    // 箱設定ダイアログのタイトル欄がこれ。ダイアログが開いていてもその欄の undo は正しい。
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" contenteditable="true" data-target>題名</div>`,
    );
    const seen: string[] = [];
    target.addEventListener("beforeinput", (event) => seen.push((event as InputEvent).inputType));

    const outcome = deliverHistoryShortcutToFocusedSurface({
      activeElement: target,
      direction: "undo",
      isComposing: false,
      isModalSurfaceOpen: true,
    });

    expect(outcome).toBe("handled");
    expect(seen).toEqual(["historyUndo"]);
  });

  it("refuses the document undo under a dialog that has no open flag", () => {
    // `TableSettingsDialog` / `ColorPickerDialog` / ワークスペース系 / PDF 完了ダイアログは
    // 12 個の React フラグに載っていない。DOM 側でも見ておかないと背後の文書へ突き抜ける。
    const target = mount(
      '<div data-modal-backdrop><div role="dialog"><button data-target>OK</button></div></div>',
    );
    expect(resolve(target).kind).toBe("blockedByModalSurface");
    expect(deliverHistoryShortcutToFocusedSurface({
      activeElement: target,
      direction: "undo",
      isComposing: false,
      isModalSurfaceOpen: false,
    })).toBe("ignored");
  });

  it("keeps the non-modal panel exempt", () => {
    const target = mount(
      '<div role="dialog" data-non-modal-surface><button data-target>閉じる</button></div>',
    );
    expect(resolve(target).kind).toBe("document");
  });
});

describe("non-text inputs", () => {
  it.each(["checkbox", "range", "color", "radio", "file"])(
    "sends %s inputs to the document instead of swallowing the shortcut",
    (type) => {
      // スライダーやチェックボックスの変更は SigmaDoc に入る。`execCommand("undo")` は
      // これらでは no-op なので、ネイティブ欄として扱うと ⌘Z が黙って飲まれる。
      const target = mount(`<input type="${type}" data-target />`);
      expect(resolve(target).kind).toBe("document");
    },
  );

  it.each(["text", "search", "email", "number", "password"])(
    "keeps %s inputs on their own native undo",
    (type) => {
      const target = mount(`<input type="${type}" data-target />`);
      expect(resolve(target).kind).toBe("nativeField");
    },
  );
});

describe("deliverToFocusedSurface", () => {
  it("does not bounce the signal back to the surface that sent it", () => {
    // `beforeinput` ガード由来の入口は面ごとの振り分けを既に済ませている。ここで
    // 下書き面へ投げ返すと同じ合図がガードとの間で往復する。
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" contenteditable="true" data-target>下書き</div>`,
    );
    const seen: string[] = [];
    target.addEventListener("beforeinput", (event) => seen.push((event as InputEvent).inputType));

    const outcome = deliverHistoryShortcutToFocusedSurface({
      activeElement: target,
      direction: "undo",
      isComposing: false,
      isModalSurfaceOpen: false,
      deliverToFocusedSurface: false,
    });

    expect(outcome).toBe("ignored");
    expect(seen).toEqual([]);
  });
});

describe("a modal that focus is not inside", () => {
  /**
   * **本命の穴。** ダイアログはフォーカスを奪うとは限らない (`TableSettingsDialog` /
   * `PdfExportSuccessDialog` / ワークスペース系)。本文にキャレットを置いたまま開くと、
   * 祖先だけを見る判定では素通りして、⌘Z / 右クリック Undo が**ダイアログ越しに背後の
   * 文書**を巻き戻す。React の open フラグに載っていない面ではこれを止める手が他に無い。
   */
  it("blocks the document undo while the caret is still in the body", () => {
    // `TableSettingsDialog` は autoFocus もフォーカストラップも持たない手組み。
    const target = mount(
      '<div contenteditable="true" data-target>本文</div>'
      + '<div data-modal-backdrop><div role="dialog"><button>OK</button></div></div>',
    );
    expect(resolve(target).kind).toBe("blockedByModalSurface");
  });

  it("honours a surface that declares it does not isolate the background", () => {
    // 契約の固定 (実在の面はまだ backdrop 側にこの印を持たない)。印を無視すると、
    // 「開いたままでも Undo が効く」と宣言した面で ⌘Z が死ぬ。
    for (const surface of [
      "<dialog open data-non-modal-surface>非モーダル</dialog>",
      '<dialog open aria-modal="false">非モーダル</dialog>',
    ]) {
      const target = mount(`<div contenteditable="true" data-target>本文</div>${surface}`);
      expect(resolve(target).kind, surface).toBe("document");
    }
  });

  it("blocks it on the guard path too, where nothing is delivered", () => {
    // 3 本目の入口 (`beforeinput` ガード → window イベント) は面へ配達しない。
    // **配達しないことと抑止を無視することは別**で、ここを取り違えると受信側だけが
    // モーダルを飛び越えて文書を戻す。
    const target = mount(
      '<div contenteditable="true" data-target>本文</div>'
      + '<div role="dialog" aria-modal="true"><button>OK</button></div>',
    );
    target.focus();
    expect(deliverHistoryShortcutToFocusedSurface({
      activeElement: document.activeElement,
      direction: "undo",
      isComposing: false,
      isModalSurfaceOpen: false,
      ownerDocument: document,
      deliverToFocusedSurface: false,
    })).toBe("ignored");
  });

  it("still lets the document through for surfaces that do not isolate the background", () => {
    // AI 承認カード (`aria-modal="false"`)・グラフ設定パネル・コメントパネル・ツールバーの
    // ポップオーバーは本文を編集しながら開いておく面。ここで文書 undo を止めると、
    // **そのあいだ ⌘Z が丸ごと死ぬ**。
    for (const surface of [
      '<div role="dialog" aria-modal="false">AI 承認カード</div>',
      '<div role="dialog" data-non-modal-surface>グラフ設定</div>',
      '<div role="dialog">コメントパネル</div>',
      '<div role="dialog" data-toolbar-popover>フォントサイズ</div>',
    ]) {
      const target = mount(`<div contenteditable="true" data-target>本文</div>${surface}`);
      expect(resolve(target).kind, surface).toBe("document");
    }
  });

  it("names a modal by its own declaration, not only by role", () => {
    // `aria-modal="true"` だけの面と `<dialog open>`。列挙漏れで DOM 判定の意味が薄れる。
    for (const surface of [
      '<section aria-modal="true">名乗りだけ</section>',
      "<dialog open>ネイティブ dialog</dialog>",
      '<div role="alertdialog" aria-modal="true">確認</div>',
    ]) {
      const target = mount(`<div contenteditable="true" data-target>本文</div>${surface}`);
      expect(resolve(target).kind, surface).toBe("blockedByModalSurface");
    }
  });

  it("ignores a dialog element that is not open", () => {
    const target = mount(
      '<div contenteditable="true" data-target>本文</div><dialog>閉じている</dialog>',
    );
    expect(resolve(target).kind).toBe("document");
  });

  it("still blocks when the nearest surface is non-modal but sits inside a modal one", () => {
    const target = mount(
      '<div role="dialog" aria-modal="true">'
      + '<div role="dialog" data-non-modal-surface><button data-target>OK</button></div>'
      + "</div>",
    );
    expect(resolve(target).kind).toBe("blockedByModalSurface");
  });
});

describe("the nearest surface wins", () => {
  /**
   * 種類ごとに `closest` を並べると「どれが近いか」ではなく「どれを先に書いたか」で
   * 勝敗が決まる。下書き面の中に `<input>` がある形は実在する (コメント欄のリンク URL 欄)。
   */
  it("gives an input inside a local-draft surface to the input", () => {
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true"><input type="text" data-target /></div>`,
    );
    expect(resolve(target).kind).toBe("nativeField");
  });

  it("gives the surface itself to the surface history", () => {
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true" data-target><input type="text" /></div>`,
    );
    expect(resolve(target).kind).toBe("surfaceHistory");
  });

  it("keeps a math-field with nothing to undo inside its own draft surface", () => {
    // コメント下書きの中で数式欄を開いた直後。`canUndo()` は偽なので譲る先が無いが、
    // **そこで文書へ落とすと、コメントを書いているのに教材が巻き戻る。**
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true"><math-field data-target></math-field></div>`,
    );
    Object.assign(target, { canUndo: () => false, canRedo: () => false });
    expect(resolve(target).kind).toBe("surfaceHistory");
  });

  it("keeps climbing past an element that has nothing to give back", () => {
    // チェックボックスは `execCommand("undo")` が効かない。そこで打ち切ると下書き面の
    // 履歴を飛ばして文書が動く。
    const target = mount(
      `<div ${LOCAL_EDIT_HISTORY_ATTRIBUTE}="true"><input type="checkbox" data-target /></div>`,
    );
    expect(resolve(target).kind).toBe("surfaceHistory");
  });
});

describe("a math-field that answers with an exception", () => {
  it("treats a throwing canUndo as nothing to undo", () => {
    // 未 upgrade / 別実装のカスタム要素。**例外を漏らすと keydown ハンドラごと落ちて
    // undo 自体が起きない**ので、譲る先が無い扱いに倒す。
    const target = mount("<math-field data-target></math-field>");
    Object.assign(target, {
      canUndo: () => {
        throw new Error("not upgraded");
      },
    });
    expect(() => resolve(target)).not.toThrow();
    expect(resolve(target).kind).toBe("document");
  });
});

describe("composition expiry", () => {
  /**
   * **「⌘Z が永久に死ぬ」を作らないための本体。** `compositionend` は取りこぼす経路が
   * いくつもあるので、失効の判定はフラグを降ろす側ではなく**読む側**に置く。
   */
  it("is active while the composing element is connected and focused", () => {
    const target = mount('<input type="text" data-target />');
    target.focus();
    expect(isCompositionStillActive(target)).toBe(true);
  });

  it("expires when the composing element is torn out of the DOM", () => {
    // AI 適用時の PM `setContent`・ページ割りのリフロー・数式ノードビューの破棄。
    const target = mount('<input type="text" data-target />');
    target.focus();
    target.remove();
    expect(isCompositionStillActive(target)).toBe(false);
  });

  it("expires when focus moved away without a compositionend", () => {
    // programmatic blur。要素は生きているのでフォーカスを見ないと立ちっぱなしになる。
    const target = mount('<input type="text" data-target /><input id="other" />');
    target.focus();
    document.querySelector<HTMLElement>("#other")?.focus();
    expect(isCompositionStillActive(target)).toBe(false);
  });

  it("counts a composing element that owns the focused node", () => {
    const target = mount(
      '<div contenteditable="true" data-target><span id="inner">あ</span></div>',
    );
    target.focus();
    expect(isCompositionStillActive(target)).toBe(true);
  });

  it("expires for a null element", () => {
    expect(isCompositionStillActive(null)).toBe(false);
  });

  it("keeps composing while the keys still say so", () => {
    expect(shouldEndCompositionForEvent(
      new KeyboardEvent("keydown", { isComposing: true }),
    )).toBe(false);
  });

  it("ends on a key that is no longer composing (Escape cancelled the IME)", () => {
    // Escape での変換キャンセルは `compositionend` を伴わないことがある。**次の打鍵で
    // 必ず解ける**ようにしておかないと、そのセッションのメニュー ⌘Z が死に続ける。
    expect(shouldEndCompositionForEvent(
      new KeyboardEvent("keydown", { isComposing: false }),
    )).toBe(true);
  });

  it("ends on events that carry no composing flag at all (window blur, pointer)", () => {
    // アプリ・ブラウザの切り替え。
    expect(shouldEndCompositionForEvent(new Event("blur"))).toBe(true);
    expect(shouldEndCompositionForEvent(new Event("pointerdown"))).toBe(true);
  });
});
