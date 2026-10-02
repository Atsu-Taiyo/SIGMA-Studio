// @vitest-environment happy-dom

import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer, type Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { beforeAll, describe, expect, it } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

/**
 * クリップボードの HTML は、スキーマ自身の直列化 (`renderHTML`) を同じスキーマの解析 (`parseHTML`)
 * が読み戻す往復で成り立つ。ProseMirror は同じ優先度なら mark の規則を node の規則より先に評価するので、
 * どれかの mark が「どの span でも」受けると、数式の span が食われて KaTeX の文字列へ崩れる。
 * 貼り付け先が別の編集面 (本文 → 図中テキスト・表のセル・コメント) でも数式が数式のまま戻ることを、
 * 数式を包む mark の組み合わせごとに固定する。
 */
let schema: Schema;

beforeAll(() => {
  schema = getSchema(createRichTextEngineExtensions({ bodyBlocks: true }));
});

function paragraphOf(...children: ProseMirrorNode[]): ProseMirrorNode {
  return schema.nodes.paragraph.create(null, children);
}

function math(tex: string, marks: ReturnType<Schema["mark"]>[] = []): ProseMirrorNode {
  return schema.nodes.mathInline.create({ id: `m_${tex.length}`, tex }, null, marks);
}

function roundTrip(paragraph: ProseMirrorNode): ProseMirrorNode {
  const container = document.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(paragraph.content, { document }));
  // 段落の中身だけを直列化したので、解析結果も段落に入れて元と並べる。
  return paragraphOf(...childrenOf(DOMParser.fromSchema(schema).parseSlice(container).content));
}

function childrenOf(fragment: Fragment): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((child) => children.push(child));
  return children;
}

describe("clipboard HTML round trip", () => {
  const boxed = () => schema.mark("boxed", { math: true, paddingY: 2, variant: "double", tone: "blue" });

  it.each([
    ["plain math", () => []],
    ["boxed math", () => [boxed()]],
    ["underlined boxed math", () => [schema.mark("underline"), boxed()]],
    ["colored boxed math", () => [schema.mark("styledText", { color: "#cc0000", fontSize: 14 }), boxed()]],
  ])("keeps %s as a math node with the same marks", (_name, marks) => {
    const source = paragraphOf(
      schema.text("は明らか. "),
      math("|x|=\\frac{1}{1+h}", marks()),
      schema.text("なら"),
    );

    const parsed = roundTrip(source);

    expect(parsed.toJSON()).toEqual(source.toJSON());
    expect(parsed.child(1).type.name).toBe("mathInline");
  });

  it("keeps boxed text and boxed math side by side", () => {
    const source = paragraphOf(
      math("0<|x|<1", [boxed()]),
      schema.text("なら", [schema.mark("boxed", { math: false })]),
    );

    expect(roundTrip(source).toJSON()).toEqual(source.toJSON());
  });

  it("does not turn a span without any text styling into an empty styling mark", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p><span>素の</span><span style=\"color: rgb(204, 0, 0)\">赤い</span>文字</p>";

    const paragraph = DOMParser.fromSchema(schema).parseSlice(container).content.firstChild!;

    expect(paragraph.child(0).marks).toEqual([]);
    expect(paragraph.child(1).marks.map((mark) => [mark.type.name, mark.attrs.color])).toEqual([
      ["styledText", "rgb(204, 0, 0)"],
    ]);
  });
});
