// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import {
  textFlowToTiptap,
  tiptapToTextFlow,
} from "@/components/editor/text-flow/tiptap-document-adapter";
import {
  codeBlockText,
  createCodeHighlightDecorations,
} from "@/components/tiptap/code-highlight-extension";
import { CodeBlockActionExtension } from "@/components/tiptap/code-block-action-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { applyTextFormatCommand } from "@/components/tiptap/text-format-controller";
import type { TextFlowBlock } from "@/features/text-editing";

/**
 * 生きているエディタ。ProseMirror の DOMObserver はタイマーで動くので、破棄しないと
 * テスト環境が畳まれた後に `document` を触って unhandled error になる。
 */
const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

/** 本文の面と同じ構成のエディタ。ここでの往復が保存される内容そのもの。 */
function createBodyEditor(
  blocks: TextFlowBlock[] = [{ type: "paragraph", id: "p_1", children: [] }],
  options: { codeAction?: boolean } = {},
) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
        LayoutSectionExtension,
        ...(options.codeAction
          ? [CodeBlockActionExtension.configure({ onOpen: () => {}, getLabel: () => "settings" })]
          : []),
      ],
      bodyBlocks: true,
      listMarkerTypography: true,
      orderedListMarkerStyles: true,
    }),
    content: textFlowToTiptap(blocks),
  });
  editors.push(editor);
  return editor;
}

/** 入力ルールは `handleTextInput` からしか走らないので、1 文字ずつそこへ通す。 */
function typeText(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp(
      "handleTextInput",
      (handler) => handler(editor.view, from, to, character, () => editor.state.tr),
    );
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }
}

/**
 * 本物の keydown を流す。
 *
 * `editor.commands.keyboardShortcut()` は使えない — あれはハンドラが作った transaction を
 * 捕まえて step を貼り直す作りで、複数 step のコマンド (消してから挿す) では 2 つ目の step が
 * 二重に map され doc が壊れる。実機の経路とも違うので、ここは view へ直接投げる。
 */
function pressKey(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  editor.view.someProp("handleKeyDown", (handler) => handler(
    editor.view,
    new KeyboardEvent("keydown", { key, ...options }),
  ));
}

function bodyBlocks(editor: Editor): TextFlowBlock[] {
  return tiptapToTextFlow(editor.getJSON() as Parameters<typeof tiptapToTextFlow>[0]);
}

function runBlockStyle(editor: Editor, value: string): boolean {
  return applyTextFormatCommand(editor, { command: "blockStyle", value }, {
    selection: null,
    blockNodeType: "paragraph",
    allowBlockStyle: true,
  });
}

describe("SigmaDoc に無いブロックは編集面にも無い", () => {
  // これがこの一連の変更の出発点。`blockquote` / `codeBlock` / `horizontalRule` は
  // StarterKit の既定で有効なまま残っていて、`> ` と打つと引用ができ、次の同期で
  // `tiptapToTextFlow` が知らない種別として捨て、**打った文字ごと黙って消えていた**。
  it("StarterKit の blockquote / horizontalRule はスキーマに載っていない", () => {
    const editor = createBodyEditor();

    expect(editor.schema.nodes.blockquote).toBeUndefined();
    expect(editor.schema.nodes.horizontalRule).toBeUndefined();
    // `codeBlock` という名前は使うが、これは SigmaDoc へ往復できる自前のノード。
    expect(editor.schema.nodes.codeBlock?.spec.whitespace).toBe("pre");
  });
});

describe("引用ブロック", () => {
  it("`> ` で引用の入れ物ができ、中身は本文ブロックのまま", () => {
    const editor = createBodyEditor();
    typeText(editor, "> 引用の中身");

    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({
        type: "quote",
        blocks: [
          expect.objectContaining({
            type: "paragraph",
            children: [{ type: "text", text: "引用の中身" }],
          }),
        ],
      }),
    ]);
  });

  // 段落を積んで隣接 CSS で縦棒を繋いでいた頃の壊れ方 (何段も続くとずれる) が構造的に
  // 起きないこと。何行あっても入れ物は 1 つ。
  it("複数行の引用は 1 つのブロックに入る", () => {
    const blocks: TextFlowBlock[] = [{
      type: "quote",
      id: "q_1",
      blocks: [
        { type: "paragraph", id: "q_p1", children: [{ type: "text", text: "1行目" }] },
        { type: "paragraph", id: "q_p2", children: [{ type: "text", text: "2行目" }] },
        { type: "paragraph", id: "q_p3", children: [{ type: "text", text: "3行目" }] },
      ],
    }];

    const roundTripped = bodyBlocks(createBodyEditor(blocks));
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped).toEqual(blocks);
  });

  it("引用の中に見出し・リスト・コードを置ける", () => {
    const blocks: TextFlowBlock[] = [{
      type: "quote",
      id: "q_1",
      blocks: [
        { type: "heading", id: "q_h", level: 2, children: [{ type: "text", text: "見出し" }] },
        {
          type: "list",
          id: "q_l",
          listType: "bullet",
          items: [{ type: "listItem", id: "q_li", children: [{ type: "text", text: "項目" }] }],
        },
        { type: "codeBlock", id: "q_c", children: [{ type: "text", text: "code()" }] },
      ],
    }];

    expect(bodyBlocks(createBodyEditor(blocks))).toEqual(blocks);
  });

  it("ツールバーの引用ボタンで包み、もう一度押すと外れる", () => {
    const editor = createBodyEditor([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(runBlockStyle(editor, "quote")).toBe(true);
    expect(editor.isActive("quote")).toBe(true);
    expect(bodyBlocks(editor)[0]?.type).toBe("quote");

    expect(runBlockStyle(editor, "quote")).toBe(true);
    expect(editor.isActive("quote")).toBe(false);
    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({ type: "paragraph", children: [{ type: "text", text: "本文" }] }),
    ]);
  });

  it("中身の無い引用は段落 1 つを持った形で開く (content 式が `+` なので空では作れない)", () => {
    const editor = createBodyEditor([{ type: "quote", id: "q_1", blocks: [] } as never]);

    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({
        type: "quote",
        blocks: [expect.objectContaining({ type: "paragraph" })],
      }),
    ]);
  });
});

describe("コードブロック", () => {
  it("``` で 1 つのコードブロックになる", () => {
    const editor = createBodyEditor();
    typeText(editor, "``` const a = 1;");

    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({
        type: "codeBlock",
        children: [{ type: "text", text: "const a = 1;" }],
      }),
    ]);
  });

  it("空白なしの ``` から作っても fence を編集 DOM や Tiptap JSON に残さない", () => {
    const editor = createBodyEditor(undefined, { codeAction: true });
    typeText(editor, "```asdasda");
    pressKey(editor, "Enter");
    typeText(editor, "asdasdasdsaadasdasdas");
    // 実画面では最初の同期で SigmaDoc id が採番され、その id を使って設定ボタンが付く。
    editor.commands.updateAttributes("codeBlock", { sigmaDocId: "c_input", theme: "dark" });

    const expectedText = "asdasda\nasdasdasdsaadasdasdas";
    const json = editor.getJSON();
    expect(json.content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: expect.objectContaining({ theme: "dark" }),
      content: [
        { type: "text", text: "asdasda" },
        { type: "hardBreak" },
        { type: "text", text: "asdasdasdsaadasdasdas" },
      ],
    });
    expect(codeBlockText(editor.state.doc.firstChild!)).toBe(expectedText);

    const code = editor.view.dom.querySelector<HTMLElement>(".print-code");
    expect(code?.dataset.codeTheme).toBe("dark");
    expect(code?.querySelector("[data-code-block-action-button='true']")?.textContent).toBe("⋯");
    const domText = code ? readEditingCodeDomText(code) : "";
    expect(domText).toBe(expectedText);
    expect(domText.startsWith("```")).toBe(false);
  });

  it("コード本文として保存済みの fence は勝手に削らない", () => {
    const literal = "```js\nconst fence = \"```\";\n```";
    const editor = createBodyEditor([{
      type: "codeBlock",
      id: "c_literal",
      children: [{ type: "text", text: literal }],
    }]);

    expect(codeBlockText(editor.state.doc.firstChild!)).toBe(literal);
    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({
        type: "codeBlock",
        children: [{ type: "text", text: literal }],
      }),
    ]);
  });

  // 段落を積んでいた頃はここが「1 ブロック 1 行」で、行間が不揃いになる原因だった。
  it("何行あっても 1 ブロックで、改行は run の中の改行文字として往復する", () => {
    const blocks: TextFlowBlock[] = [{
      type: "codeBlock",
      id: "c_1",
      children: [{ type: "text", text: "function f() {\n  return 1;\n}" }],
    }];

    const roundTripped = bodyBlocks(createBodyEditor(blocks));
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped).toEqual(blocks);
  });

  it("Enter は改行を足す (ブロックは割れない)", () => {
    const editor = createBodyEditor([
      { type: "codeBlock", id: "c_1", children: [{ type: "text", text: "a" }] },
    ]);
    editor.commands.setTextSelection(2);
    pressKey(editor, "Enter");

    const blocks = bodyBlocks(editor);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(expect.objectContaining({
      type: "codeBlock",
      children: [{ type: "text", text: "a\n" }],
    }));
  });

  it("末尾の空行の上で Enter を押すとブロックの外へ出る", () => {
    const editor = createBodyEditor([
      { type: "codeBlock", id: "c_1", children: [{ type: "text", text: "a\n" }] },
    ]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    pressKey(editor, "Enter");

    // 空行は残さず、後ろに入力できる段落ができる。
    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({ type: "codeBlock", children: [{ type: "text", text: "a" }] }),
      expect.objectContaining({ type: "paragraph" }),
    ]);
  });

  it("文字単位の書式を持てる (フォント・大きさ・色を変えられる)", () => {
    const blocks: TextFlowBlock[] = [{
      type: "codeBlock",
      id: "c_1",
      children: [
        { type: "text", text: "const ", color: "#c0392b", marks: ["bold"] },
        { type: "text", text: "a = 1;", fontFamily: "serif", fontSize: 15 },
      ],
    }];

    expect(bodyBlocks(createBodyEditor(blocks))).toEqual(blocks);
  });

  it("ライト／ダークの背景設定を SigmaDoc と編集 DOM で同じ値に保つ", () => {
    const blocks: TextFlowBlock[] = [{
      type: "codeBlock",
      id: "c_dark",
      language: "typescript",
      theme: "dark",
      children: [{ type: "text", text: "const answer: number = 42;" }],
    }];
    const editor = createBodyEditor(blocks);

    expect(editor.view.dom.querySelector(".print-code")?.getAttribute("data-code-theme"))
      .toBe("dark");
    expect(bodyBlocks(editor)).toEqual(blocks);
  });

  it("ツールバーのコードボタンで段落と行き来する", () => {
    const editor = createBodyEditor([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "code()" }] },
    ]);

    expect(runBlockStyle(editor, "code")).toBe(true);
    expect(bodyBlocks(editor)[0]?.type).toBe("codeBlock");

    expect(runBlockStyle(editor, "code")).toBe(true);
    expect(bodyBlocks(editor)[0]?.type).toBe("paragraph");
  });

  it("ツールバーでコード化するときは段落先頭の fence だけを marker として消す", () => {
    const editor = createBodyEditor([{
      type: "paragraph",
      id: "p_fenced",
      children: [{ type: "text", text: "```asdasda\nasdasdasdsaadasdasdas" }],
    }]);

    expect(runBlockStyle(editor, "code")).toBe(true);
    expect(codeBlockText(editor.state.doc.firstChild!)).toBe("asdasda\nasdasdasdsaadasdasdas");
    expect(editor.view.dom.querySelector(".print-code")?.textContent?.startsWith("```")).toBe(false);
  });

  it("コード本文の途中にある fence はツールバー変換でも残す", () => {
    const literal = "const fence = \"```\";";
    const editor = createBodyEditor([{
      type: "paragraph",
      id: "p_inner_fence",
      children: [{ type: "text", text: literal }],
    }]);

    expect(runBlockStyle(editor, "code")).toBe(true);
    expect(codeBlockText(editor.state.doc.firstChild!)).toBe(literal);
  });
});

function readEditingCodeDomText(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) {
    return root.textContent ?? "";
  }
  if (root instanceof HTMLElement) {
    if (root.dataset.codeBlockActionButton === "true") {
      return "";
    }
    if (root.tagName === "BR") {
      return "\n";
    }
  }
  let text = "";
  root.childNodes.forEach((node) => {
    text += readEditingCodeDomText(node);
  });
  return text;
}

describe("区切り線", () => {
  it("`---` で区切り線になり、SigmaDoc の divider として運ばれる", () => {
    const editor = createBodyEditor();
    typeText(editor, "---");

    expect(bodyBlocks(editor)[0]).toEqual(expect.objectContaining({ type: "divider" }));
  });

  it("挿入した区切り線の後ろには必ず入力できる場所が残る", () => {
    // 本文は trailingNode を切ってあるので、文末に atom を置いたままだと
    // 「その先へ入力できない」行き止まりになる。
    const editor = createBodyEditor();
    editor.commands.toggleDivider();

    const blocks = bodyBlocks(editor);
    expect(blocks.at(-1)?.type).toBe("paragraph");
    expect(blocks.some((block) => block.type === "divider")).toBe(true);
  });

  it("往復しても id と改ページ指定が落ちない", () => {
    const blocks: TextFlowBlock[] = [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "前" }] },
      { type: "divider", id: "divider_1", pagination: { break: true } },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "後" }] },
    ];

    expect(bodyBlocks(createBodyEditor(blocks))).toEqual(blocks);
  });
});

describe("ツールバーの blockStyle コマンド", () => {
  it("箇条書き / 番号付き((1)) を作り、もう一度押すと解除する", () => {
    const editor = createBodyEditor([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "項目" }] },
    ]);

    expect(runBlockStyle(editor, "bulletList")).toBe(true);
    expect(editor.isActive("bulletList")).toBe(true);
    expect(runBlockStyle(editor, "bulletList")).toBe(true);
    expect(editor.isActive("bulletList")).toBe(false);

    expect(runBlockStyle(editor, "orderedListParen")).toBe(true);
    expect(editor.getAttributes("orderedList").markerStyle).toBe("paren");
    // 形式だけ切り替える (解除しない)
    expect(runBlockStyle(editor, "orderedList")).toBe(true);
    expect(editor.isActive("orderedList")).toBe(true);
    expect(editor.getAttributes("orderedList").markerStyle).toBeNull();
    // 同じ形式をもう一度で解除
    expect(runBlockStyle(editor, "orderedList")).toBe(true);
    expect(editor.isActive("orderedList")).toBe(false);
  });

  // `liftListItem` はリストの外では false を返す。Tiptap の chain は途中の false で
  // 中断しないので「本文」が見出しにも効く、という前提をここで固定する。
  it("「本文」は見出しからもリストからもコードからも素の段落へ戻す", () => {
    const editor = createBodyEditor([
      { type: "heading", id: "h_1", level: 2, children: [{ type: "text", text: "見出し" }] },
    ]);

    editor.commands.setTextSelection(2);
    runBlockStyle(editor, "paragraph");
    expect(bodyBlocks(editor)).toEqual([expect.objectContaining({ type: "paragraph", id: "h_1" })]);

    runBlockStyle(editor, "code");
    expect(editor.isActive("codeBlock")).toBe(true);
    runBlockStyle(editor, "paragraph");
    expect(editor.isActive("codeBlock")).toBe(false);

    runBlockStyle(editor, "bulletList");
    expect(editor.isActive("bulletList")).toBe(true);
    runBlockStyle(editor, "paragraph");
    expect(editor.isActive("bulletList")).toBe(false);
  });
});

describe("コードの色分け", () => {
  // 編集面 (ProseMirror の装飾) と静的描画 (印刷/PDF/ビューア) は同じ関数から色をもらう。
  // ここがずれると「画面では色が付いているのに紙では 1 文字ずれる」という形で出る。
  it("装飾の位置がブロック内の文字位置とぴったり合う", () => {
    const code = "function add(a, b) {\n  return a + b; // sum\n}";
    const editor = createBodyEditor([
      { type: "codeBlock", id: "c_1", language: "javascript", children: [{ type: "text", text: code }] },
    ]);

    const blockPos = 0;
    const contentStart = blockPos + 1;
    const decorations = createCodeHighlightDecorations(editor.state.doc).find();
    expect(decorations.length).toBeGreaterThan(0);

    for (const decoration of decorations) {
      const covered = editor.state.doc.textBetween(decoration.from, decoration.to, "\n", "￼");
      const expected = code.slice(decoration.from - contentStart, decoration.to - contentStart);
      expect(covered).toBe(expected);
    }

    // 先頭の `function` がキーワードとして塗られている。
    const first = decorations[0];
    expect(code.slice(first.from - contentStart, first.to - contentStart)).toBe("function");
  });

  it("改行 (hardBreak) を 1 文字として数えるので、2 行目以降もずれない", () => {
    const editor = createBodyEditor([
      { type: "codeBlock", id: "c_1", language: "python", children: [{ type: "text", text: "x = 1\n# あとがき" }] },
    ]);

    expect(codeBlockText(editor.state.doc.firstChild!)).toBe("x = 1\n# あとがき");
  });

  it("巨大なコードでは編集用 Decoration を作らない", () => {
    const code = Array.from({ length: 10_000 }, (_, index) => `const value${index} = ${index};`).join("\n");
    // 表示用adapterは長文を省略するため、装飾のサイズ制限には省略前のPM文書を渡す。
    const doc = createBodyEditor().schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "codeBlock",
        attrs: { id: "c_large", language: "javascript" },
        content: [{ type: "text", text: code }],
      }],
    });

    expect(createCodeHighlightDecorations(doc).find()).toHaveLength(0);
    expect(codeBlockText(doc.firstChild!)).toBe(code);
  });

  it("言語は往復し、読めない値は自動判定へ落ちる", () => {
    const blocks: TextFlowBlock[] = [
      { type: "codeBlock", id: "c_1", language: "python", children: [{ type: "text", text: "x = 1" }] },
    ];
    expect(bodyBlocks(createBodyEditor(blocks))).toEqual(blocks);

    const editor = createBodyEditor([
      { type: "codeBlock", id: "c_2", language: "存在しない", children: [{ type: "text", text: "x" }] } as never,
    ]);
    expect(bodyBlocks(editor)[0]).toEqual(expect.objectContaining({ type: "codeBlock", language: undefined }));
  });
});

describe("ブロックの解除", () => {
  // Tiptap の `lift` はキャレットのある段落だけを持ち上げるので、3 行の引用の途中で押すと
  // 引用が 2 つに割れる。ボタンは「このブロックを解除する」ものなので中身ごと外へ出す。
  it("引用は中身を全部そのまま外へ出す (途中の行で押しても割れない)", () => {
    const editor = createBodyEditor([{
      type: "quote",
      id: "q_1",
      blocks: [
        { type: "paragraph", id: "q_p1", children: [{ type: "text", text: "1行目" }] },
        { type: "paragraph", id: "q_p2", children: [{ type: "text", text: "2行目" }] },
        { type: "paragraph", id: "q_p3", children: [{ type: "text", text: "3行目" }] },
      ],
    }]);
    // 2 行目にキャレットを置く
    editor.commands.setTextSelection(10);
    expect(editor.isActive("quote")).toBe(true);

    runBlockStyle(editor, "quote");

    expect(bodyBlocks(editor)).toEqual([
      expect.objectContaining({ type: "paragraph", id: "q_p1" }),
      expect.objectContaining({ type: "paragraph", id: "q_p2" }),
      expect.objectContaining({ type: "paragraph", id: "q_p3" }),
    ]);
  });

  it("区切り線は選んでいるときボタンで消える", () => {
    const editor = createBodyEditor([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "前" }] },
      { type: "divider", id: "d_1" },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "後" }] },
    ]);
    // 段落「前」は nodeSize 3 (開始 + "前" + 終了) なので、区切り線はその直後。
    let dividerPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "divider") {
        dividerPos = pos;
      }
    });
    editor.commands.setNodeSelection(dividerPos);
    expect(editor.isActive("divider")).toBe(true);

    runBlockStyle(editor, "divider");

    expect(bodyBlocks(editor).some((block) => block.type === "divider")).toBe(false);
  });

  it("リスト項目の中にも区切り線を置ける", () => {
    const blocks: TextFlowBlock[] = [{
      type: "list",
      id: "l_1",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "li_1",
        children: [{ type: "text", text: "項目" }],
        continuations: [{ type: "divider", id: "li_d" }],
      }],
    }];

    expect(bodyBlocks(createBodyEditor(blocks))).toEqual(blocks);
  });
});
