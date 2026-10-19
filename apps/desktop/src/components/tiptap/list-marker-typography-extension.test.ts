import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";

import {
  createListMarkerTypographyDecorations,
  ListMarkerTypographyExtension,
} from "@/components/tiptap/list-marker-typography-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import type { InlineNode, ListNode } from "@/features/document";
import { cssTextFromDeclarations, listMarkerTypographyDomSpecs } from "@/features/rendering/adapters";
import { inlineNodesToTiptapNodes } from "@/lib/tiptap-adapter";

const schema: Schema = getSchema(createRichTextEngineExtensions({ orderedListMarkerStyles: true }));

interface StyledRun {
  text?: string;
  tex?: string;
  fontFamily?: string;
  fontSize?: number | string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

function inlineNode(run: StyledRun): Record<string, unknown> {
  const marks: Array<Record<string, unknown>> = [];
  if (run.fontFamily || run.fontSize !== undefined || run.color) {
    marks.push({
      type: "styledText",
      attrs: { fontFamily: run.fontFamily ?? null, fontSize: run.fontSize ?? null, color: run.color ?? null },
    });
  }
  if (run.bold) {
    marks.push({ type: "bold" });
  }
  if (run.italic) {
    marks.push({ type: "italic" });
  }
  const node = run.tex !== undefined
    ? { type: "mathInline", attrs: { id: "m_1", tex: run.tex } }
    : { type: "text", text: run.text ?? "" };
  return marks.length > 0 ? { ...node, marks } : node;
}

function listItem(runs: StyledRun[], nested?: StyledRun[][]): Record<string, unknown> {
  return {
    type: "listItem",
    content: [
      { type: "paragraph", ...(runs.length ? { content: runs.map(inlineNode) } : {}) },
      ...(nested ? [{ type: "orderedList", content: nested.map((items) => listItem(items)) }] : []),
    ],
  };
}

function docWithList(items: Array<Record<string, unknown>>, listType = "orderedList"): ProseMirrorNode {
  return schema.nodeFromJSON({ type: "doc", content: [{ type: listType, content: items }] });
}

function markerDecorations(doc: ProseMirrorNode): Array<{ from: number; attrs: Record<string, string> }> {
  return createListMarkerTypographyDecorations(doc)
    .find()
    .map((decoration: Decoration) => ({
      from: decoration.from,
      attrs: (decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs,
    }));
}

/** The static renderer's declarations for a one-item list holding `children`. */
function staticItemStyle(children: InlineNode[]): string | undefined {
  const list: ListNode = { type: "list", id: "list_1", listType: "ordered", items: [{ type: "listItem", id: "li_1", children }] };
  return cssTextFromDeclarations(listMarkerTypographyDomSpecs(list).get("li_1")?.style);
}

describe("createListMarkerTypographyDecorations", () => {
  it("puts the first run's font on the list item so ::marker can read it", () => {
    const doc = docWithList([listItem([{ text: "いち", fontFamily: '"Yu Mincho", serif', fontSize: 18 }])]);
    const decorations = markerDecorations(doc);

    expect(decorations).toHaveLength(1);
    // The list starts at 0, so its first item opens at 1.
    expect(decorations[0].from).toBe(1);
    expect(decorations[0].attrs["data-list-marker-typography"]).toBe("");
    expect(decorations[0].attrs.style).toBe(
      '--sigma-doc-list-marker-font-family: "Yu Mincho", serif; --sigma-doc-list-marker-font-size: 18pt',
    );
  });

  it("normalizes a px font size to pt exactly like the run's own span", () => {
    const doc = docWithList([listItem([{ text: "いち", fontSize: "24px" }])]);

    expect(markerDecorations(doc)[0].attrs.style).toBe("--sigma-doc-list-marker-font-size: 18pt");
  });

  it("takes only the size from a leading formula, never the family", () => {
    const doc = docWithList([listItem([{ tex: "x^2", fontFamily: '"Yu Mincho", serif', fontSize: 18 }])]);

    expect(markerDecorations(doc)[0].attrs.style).toBe("--sigma-doc-list-marker-font-size: 18pt");
  });

  it("leaves an item without styling alone", () => {
    expect(markerDecorations(docWithList([listItem([{ text: "いち" }])]))).toEqual([]);
    expect(markerDecorations(docWithList([listItem([])]))).toEqual([]);
  });

  it("does not carry a styled parent's font into an unstyled nested item", () => {
    const doc = docWithList([listItem([{ text: "いち", fontFamily: "serif" }], [[{ text: "こ" }]])]);
    const decorations = markerDecorations(doc);

    expect(decorations).toHaveLength(1);
    expect(decorations[0].from).toBe(1);
  });

  it("decorates a nested item that has its own styling", () => {
    const doc = docWithList([listItem([{ text: "いち" }], [[{ text: "こ", fontSize: 9 }]])]);

    expect(markerDecorations(doc).map((decoration) => decoration.attrs.style))
      .toEqual(["--sigma-doc-list-marker-font-size: 9pt"]);
  });

  it("gives an empty item the typography of the text written right before it", () => {
    const doc = docWithList([
      listItem([{ text: "いち", fontFamily: "serif", fontSize: 18, bold: true }]),
      listItem([]),
    ]);

    expect(markerDecorations(doc).map((decoration) => decoration.attrs.style)).toEqual([
      "--sigma-doc-list-marker-font-family: serif; --sigma-doc-list-marker-font-size: 18pt; --sigma-doc-list-marker-font-weight: bold",
      "--sigma-doc-list-marker-font-family: serif; --sigma-doc-list-marker-font-size: 18pt; --sigma-doc-list-marker-font-weight: bold",
    ]);
  });

  it("reads the last run of the item before, which is what Enter carries into the new item", () => {
    const doc = docWithList([
      listItem([{ text: "見出し", fontSize: 18, bold: true }, { text: "本文", fontSize: 9 }]),
      listItem([]),
    ]);

    expect(markerDecorations(doc).map((decoration) => decoration.attrs.style)).toEqual([
      "--sigma-doc-list-marker-font-size: 18pt; --sigma-doc-list-marker-font-weight: bold",
      "--sigma-doc-list-marker-font-size: 9pt",
    ]);
  });

  it("keeps reaching back over consecutive empty items, and into a nested list's first item", () => {
    const doc = docWithList([
      listItem([{ text: "いち", fontSize: 18 }], [[]]),
      listItem([]),
      listItem([]),
    ]);

    expect(markerDecorations(doc)).toHaveLength(4);
    expect(new Set(markerDecorations(doc).map((decoration) => decoration.attrs.style)))
      .toEqual(new Set(["--sigma-doc-list-marker-font-size: 18pt"]));
  });

  it("does not reach outside the list or past unstyled text", () => {
    const outside = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", content: [inlineNode({ text: "前の段落", fontSize: 18 })] },
        { type: "orderedList", content: [listItem([])] },
      ],
    });
    expect(markerDecorations(outside)).toEqual([]);

    const unstyled = docWithList([listItem([{ text: "いち", fontSize: 18 }]), listItem([{ text: "に" }]), listItem([])]);
    expect(markerDecorations(unstyled).map((decoration) => decoration.from)).toEqual([1]);
  });

  it("works the same for bullet lists (the user asked for (1) 'とか', not only (1))", () => {
    const doc = docWithList([listItem([{ text: "いち", fontFamily: "serif" }])], "bulletList");

    expect(markerDecorations(doc)).toHaveLength(1);
  });

  it("stays empty for a document without lists", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [inlineNode({ text: "本文", fontFamily: "serif" })] }],
    });

    expect(createListMarkerTypographyDecorations(doc).find()).toEqual([]);
  });
});

/**
 * The editing surface reads Tiptap nodes and the static renderer reads SigmaDoc, so "the first run"
 * is decided twice. Whenever the two disagree, the marker changes the moment the document is
 * printed or opened in the embedded viewer — with no test failing anywhere near the difference.
 * These cases feed the same SigmaDoc content through both projections and compare the result.
 */
describe("editing and static projections agree on the first run", () => {
  function editingStyle(children: InlineNode[]): string | undefined {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: inlineNodesToTiptapNodes(children) }],
        }],
      }],
    });
    return markerDecorations(doc)[0]?.attrs.style;
  }

  function staticStyle(children: InlineNode[]): string | undefined {
    return staticItemStyle(children);
  }

  const cases: Array<[string, InlineNode[]]> = [
    ["書体と大きさを持つ先頭 run", [{ type: "text", text: "いち", fontFamily: "serif", fontSize: 18 }]],
    ["無印の項目", [{ type: "text", text: "いち" }]],
    ["空文字で始まる項目", [
      { type: "text", text: "", fontFamily: "monospace" },
      { type: "text", text: "いち", fontFamily: "serif" },
    ]],
    // SigmaDoc では改行は text run の中の `\n`、編集面では hardBreak という別ノード。
    ["改行だけの run で始まる項目", [
      { type: "text", text: "\n", fontFamily: "monospace" },
      { type: "text", text: "いち", fontFamily: "serif" },
    ]],
    ["改行を含む 1 つの run で始まる項目", [{ type: "text", text: "\nいち", fontFamily: "serif" }]],
    ["ゼロ幅文字で始まる項目", [
      { type: "text", text: "​", fontFamily: "monospace" },
      { type: "text", text: "いち", fontFamily: "serif" },
    ]],
    ["中身の無い数式で始まる項目", [
      { type: "mathInline", id: "m_1", tex: "", display: "inline", fontSize: 9 },
      { type: "text", text: "いち", fontFamily: "serif", fontSize: 18 },
    ]],
    ["数式で始まる項目", [
      { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", fontFamily: "serif", fontSize: 18 },
      { type: "text", text: " いち" },
    ]],
    ["空の項目", []],
  ];

  it.each(cases)("%s", (_name, children) => {
    expect(editingStyle(children)).toBe(staticStyle(children));
  });
});

/** The same SigmaDoc list through both projections, item by item (empty items included). */
describe("editing and static projections agree on empty items", () => {
  function toTiptapList(list: ListNode): Record<string, unknown> {
    return {
      type: list.listType === "ordered" ? "orderedList" : "bulletList",
      content: list.items.map((item) => ({
        type: "listItem",
        content: [
          { type: "paragraph", content: inlineNodesToTiptapNodes(item.children) },
          ...(item.continuations ?? []).map((continuation) => ({
            type: "paragraph",
            content: continuation.type === "divider" ? [] : inlineNodesToTiptapNodes(continuation.children),
          })),
          ...(item.nested ?? []).map(toTiptapList),
        ],
      })),
    };
  }

  /** Item ids in the order the editing surface walks its `listItem` nodes (item, then nested). */
  function itemIds(list: ListNode): string[] {
    return list.items.flatMap((item) => [item.id, ...(item.nested ?? []).flatMap(itemIds)]);
  }

  function editingStyles(list: ListNode): Record<string, string> {
    const doc = schema.nodeFromJSON({ type: "doc", content: [toTiptapList(list)] });
    const ids = itemIds(list);
    const positions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "listItem") positions.push(pos);
    });
    const styles: Record<string, string> = {};
    for (const decoration of markerDecorations(doc)) {
      styles[ids[positions.indexOf(decoration.from)]] = decoration.attrs.style;
    }
    return styles;
  }

  function staticStyles(list: ListNode): Record<string, string> {
    return Object.fromEntries(Array.from(listMarkerTypographyDomSpecs(list), ([id, spec]) => [id, cssTextFromDeclarations(spec.style) ?? ""]));
  }

  const big: InlineNode = { type: "text", text: "いち", fontFamily: "serif", fontSize: 18, marks: ["bold"] };
  const lists: Array<[string, ListNode]> = [
    ["空の項目が続く", { type: "list", id: "l", listType: "ordered", items: [
      { type: "listItem", id: "a", children: [big] },
      { type: "listItem", id: "b", children: [] },
      { type: "listItem", id: "c", children: [{ type: "text", text: "" }] },
    ] }],
    ["続きの段落の最後の run を継ぐ", { type: "list", id: "l", listType: "bullet", items: [
      { type: "listItem", id: "a", children: [big], continuations: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "続き", color: "#c0392b" }] }] },
      { type: "listItem", id: "b", children: [] },
    ] }],
    ["入れ子の空の項目と、その後の親の空の項目", { type: "list", id: "l", listType: "ordered", items: [
      { type: "listItem", id: "a", children: [big], nested: [{ type: "list", id: "n", listType: "bullet", items: [
        { type: "listItem", id: "a1", children: [] },
        { type: "listItem", id: "a2", children: [{ type: "text", text: "こ", fontSize: 9 }] },
      ] }] },
      { type: "listItem", id: "b", children: [] },
    ] }],
    ["数式で終わる項目の後 (書体は採らない)", { type: "list", id: "l", listType: "ordered", items: [
      { type: "listItem", id: "a", children: [big, { type: "mathInline", id: "m", tex: "x^2", display: "inline", fontFamily: "serif", fontSize: 12 }] },
      { type: "listItem", id: "b", children: [] },
    ] }],
  ];

  it.each(lists)("%s", (_name, list) => {
    expect(editingStyles(list)).toEqual(staticStyles(list));
  });
});

describe("ListMarkerTypographyExtension plugin", () => {
  it("keeps the same decoration set across transactions that do not change the document", () => {
    const [plugin] = ListMarkerTypographyExtension.config.addProseMirrorPlugins?.call({
      // The extension reads nothing off `this`, so an empty context is enough here.
    } as never) ?? [];
    if (!plugin) {
      throw new Error("The extension must register one ProseMirror plugin");
    }

    const state = EditorState.create({
      schema,
      doc: docWithList([listItem([{ text: "いち", fontFamily: "serif" }])]),
      plugins: [plugin],
    });
    const before = plugin.getState(state);
    const after = plugin.getState(state.apply(state.tr.setMeta("noop", true)));

    // Rebuilding on every update would walk the document on each keystroke, which is exactly the
    // cost this repository's typing-performance work removed elsewhere.
    expect(after).toBe(before);
  });
});

describe("マーカーが継ぐ書式の範囲", () => {
  // `::marker` が受け付けるのは color と font-* だけ (MDN)。継げるものだけを継ぎ、
  // 継げないものは編集面でも静的描画でも同じように「継がない」ことを固定する。
  it("先頭 run の色・太字・斜体をマーカーへ運ぶ", () => {
    const doc = docWithList([listItem([{ text: "いち", color: "#c0392b", bold: true, italic: true }])]);

    expect(markerDecorations(doc)[0]?.attrs.style).toBe(
      "--sigma-doc-list-marker-color: #c0392b; "
      + "--sigma-doc-list-marker-font-weight: bold; "
      + "--sigma-doc-list-marker-font-style: italic",
    );
  });

  it("編集面と静的描画が同じ宣言を出す (色・太字)", () => {
    const children: InlineNode[] = [{ type: "text", text: "いち", color: "#c0392b", marks: ["bold"] }];
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: inlineNodesToTiptapNodes(children) }],
        }],
      }],
    });

    expect(markerDecorations(doc)[0]?.attrs.style).toBe(staticItemStyle(children));
  });

  it("下線と囲みは運ばない (::marker が受け付けない書式)", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [{
            type: "paragraph",
            content: inlineNodesToTiptapNodes([
              { type: "text", text: "いち", marks: ["underline", "boxed"] },
            ]),
          }],
        }],
      }],
    });

    expect(markerDecorations(doc)).toEqual([]);
  });
});
