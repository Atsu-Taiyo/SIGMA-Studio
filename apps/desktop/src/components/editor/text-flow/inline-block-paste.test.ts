// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import {
  inlinePasteContent,
  pasteAsSingleBlockInlineContent,
  resolveInlinePasteBlock,
} from "@/components/editor/text-flow/inline-block-paste";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

/**
 * 貼り付け先が inline しか持てない入れ物のとき、貼るものをどう畳むか。
 *
 * 見るのは畳んだ結果の 1 点だけ。実際に入るかどうか (＝箱から溢れないか) は
 * `tests/e2e/body-block-paste.spec.ts` が実機で見る。
 */

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

function createBodyEditor(content: Record<string, unknown>) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
        LayoutSectionExtension,
      ],
      bodyBlocks: true,
    }),
    content,
  });
  editors.push(editor);
  return editor;
}

/** 貼るもの (ProseMirror が解釈済みの slice)。 */
function sliceOf(editor: Editor, nodes: Array<Record<string, unknown>>): Slice {
  const doc = editor.schema.nodeFromJSON({ type: "doc", content: nodes });
  return new Slice(doc.content, 0, 0);
}

function clipboard(text: string): Pick<DataTransfer, "getData"> {
  return { getData: (type: string) => (type === "text/plain" ? text : "") };
}

/** 畳んだ結果を「行」で読む。hardBreak が行の区切り。 */
function lines(fragment: Fragment | null): string[] {
  if (!fragment) {
    return [];
  }
  const result: string[] = [""];
  fragment.forEach((node: ProseMirrorNode) => {
    if (node.type.name === "hardBreak") {
      result.push("");
      return;
    }
    result[result.length - 1] += node.isText ? node.text ?? "" : `<${node.type.name}>`;
  });
  return result;
}

function markNames(fragment: Fragment | null): string[] {
  const names: string[] = [];
  fragment?.forEach((node: ProseMirrorNode) => names.push(...node.marks.map((mark) => mark.type.name)));
  return names;
}

const CODE_DOC = {
  type: "doc",
  content: [{
    type: "codeBlock",
    attrs: { sigmaDocId: "code_1", sigmaDocType: "codeBlock" },
    content: [{ type: "text", text: "const a = 1;" }],
  }],
};

const BOX_DOC = {
  type: "doc",
  content: [{
    type: "boxBlock",
    attrs: { sigmaDocId: "box_1", styleId: "fancybox" },
    content: [
      { type: "boxBlockTitle", content: [{ type: "text", text: "タイトル" }] },
      {
        type: "boxBlockBody",
        content: [{
          type: "paragraph",
          attrs: { sigmaDocId: "box_body", sigmaDocType: "paragraph" },
          content: [{ type: "text", text: "本文" }],
        }],
      },
    ],
  }],
};

describe("inline だけの入れ物への貼り付け", () => {
  it("コードブロックの中にキャレットがあるときだけ対象になる", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    expect(resolveInlinePasteBlock(editor.state)?.type.name).toBe("codeBlock");
  });

  it("段落と見出しは対象外 (複数段落を貼れば段落が増えるのが正しい)", () => {
    const editor = createBodyEditor({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { sigmaDocId: "p_1", sigmaDocType: "paragraph" }, content: [{ type: "text", text: "本文" }] },
        { type: "heading", attrs: { level: 2, sigmaDocId: "h_1", sigmaDocType: "heading" }, content: [{ type: "text", text: "見出し" }] },
      ],
    });
    editor.commands.setTextSelection(2);
    expect(resolveInlinePasteBlock(editor.state)).toBeNull();
    editor.commands.setTextSelection(9);
    expect(resolveInlinePasteBlock(editor.state)).toBeNull();
  });

  it("入れ物を跨いだ選択は通常の貼り付けに任せる", () => {
    const editor = createBodyEditor({
      type: "doc",
      content: [
        CODE_DOC.content[0],
        { type: "paragraph", attrs: { sigmaDocId: "p_1", sigmaDocType: "paragraph" }, content: [{ type: "text", text: "後ろ" }] },
      ],
    });
    const { doc } = editor.state;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, 3, doc.content.size - 1)));
    expect(resolveInlinePasteBlock(editor.state)).toBeNull();
  });
});

describe("コードブロックへ畳む", () => {
  it("複数行のテキストは hardBreak 区切りの 1 ブロックになり、空行も残る", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard("if (a) {\n\n  return 1;\n}"),
      sliceOf(editor, [
        { type: "paragraph", content: [{ type: "text", text: "if (a) {" }] },
        { type: "paragraph", content: [{ type: "text", text: "  return 1;" }] },
        { type: "paragraph", content: [{ type: "text", text: "}" }] },
      ]),
    );
    // ProseMirror が HTML から作る slice は空行を畳むので、行は生のテキストから割る。
    expect(lines(content)).toEqual(["if (a) {", "", "  return 1;", "}"]);
  });

  it("改行コードは CRLF でも 1 つの改行になる", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(editor.schema, target!, clipboard("a\r\nb\rc"), Slice.empty);
    expect(lines(content)).toEqual(["a", "b", "c"]);
  });

  it("コピー元の書式は持ち込まない (自前の色分けと喧嘩する)", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard("太字のコード"),
      sliceOf(editor, [
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "太字のコード" }] },
      ]),
    );
    expect(lines(content)).toEqual(["太字のコード"]);
    expect(markNames(content)).toEqual([]);
  });

  it("コードから写したものは書式ごと運ぶ (自分で付けた色が消えない)", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard("赤い行\n\n次の行"),
      sliceOf(editor, [{
        type: "codeBlock",
        attrs: { sigmaDocId: "code_src", sigmaDocType: "codeBlock" },
        content: [
          { type: "text", marks: [{ type: "styledText", attrs: { color: "#d00" } }], text: "赤い行" },
          { type: "hardBreak" },
          { type: "hardBreak" },
          { type: "text", text: "次の行" },
        ],
      }]),
    );
    expect(lines(content)).toEqual(["赤い行", "", "次の行"]);
    expect(markNames(content)).toEqual(["styledText"]);
  });

  it("プレーンテキストが無いクリップボードでは slice の文字を使う", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard(""),
      sliceOf(editor, [
        { type: "paragraph", content: [{ type: "text", text: "1 行目" }] },
        { type: "paragraph", content: [{ type: "text", text: "2 行目" }] },
      ]),
    );
    expect(lines(content)).toEqual(["1 行目", "2 行目"]);
  });

  it("文字を持たないクリップボードでは何も返さない (通常の貼り付けへ譲る)", () => {
    const editor = createBodyEditor(CODE_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    expect(inlinePasteContent(editor.schema, target!, clipboard(""), Slice.empty)).toBeNull();
  });
});

describe("箱のタイトルへ畳む", () => {
  it("段落が並んでいても 1 つのタイトルに収まり、数式と書式は残る", () => {
    const editor = createBodyEditor(BOX_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    expect(target?.type.name).toBe("boxBlockTitle");

    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard("太字と $x^2$"),
      sliceOf(editor, [
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "太字と " }] },
        { type: "paragraph", content: [{ type: "mathInline", attrs: { id: "m_1", tex: "x^2" } }] },
      ]),
    );
    expect(lines(content)).toEqual(["太字と ", "<mathInline>"]);
    expect(markNames(content)).toEqual(["bold"]);
  });

  it("引用やリストの入れ物は行を作らず、中のブロックだけが行になる", () => {
    const editor = createBodyEditor(BOX_DOC);
    editor.commands.setTextSelection(3);
    const target = resolveInlinePasteBlock(editor.state);
    const content = inlinePasteContent(
      editor.schema,
      target!,
      clipboard(""),
      sliceOf(editor, [
        {
          type: "quote",
          attrs: { sigmaDocId: "q_1", sigmaDocType: "quote" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "引用 1" }] },
            { type: "paragraph", content: [{ type: "text", text: "引用 2" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] },
          ],
        },
      ]),
    );
    expect(lines(content)).toEqual(["引用 1", "引用 2", "項目"]);
  });
});

describe("inline しか保存できない面 (表のセル・コメント・ブロックエディタ)", () => {
  /** 表のセルと同じ構成: 段落 1 つぶんの inline だけが保存される面。 */
  function createSingleBlockEditor() {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({ enableMathDelimiters: true, heading: false }),
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "既存" }] }] },
      editorProps: {
        handlePaste: (view, event, slice) => pasteAsSingleBlockInlineContent(view, event, slice),
      },
    });
    editors.push(editor);
    return editor;
  }

  it("複数行を貼っても段落は 1 つのまま (2 行目以降が保存で消えない)", () => {
    const editor = createSingleBlockEditor();
    editor.commands.setTextSelection(3);
    editor.view.pasteText("1 行目\n2 行目\n3 行目");

    const doc = editor.getJSON() as { content?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
    expect(doc.content?.map((block) => block.type)).toEqual(["paragraph"]);
    expect(doc.content?.[0]?.content?.map((child) => child.text ?? `<${child.type}>`)).toEqual([
      "既存1 行目",
      "<hardBreak>",
      "2 行目",
      "<hardBreak>",
      "3 行目",
    ]);
  });
});
