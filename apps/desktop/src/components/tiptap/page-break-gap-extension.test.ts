// @vitest-environment happy-dom

import { Editor, Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { EditorState } from "@tiptap/pm/state";

import {
  createPageBreakDecorations,
  PageBreakGapExtension,
  paginationGapKey,
  shouldRebuildPageBreakDecorations,
} from "@/components/tiptap/page-break-gap-extension";

const SigmaDocIdAttrs = Extension.create({
  name: "testSigmaDocIdAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          sigmaDocId: {
            default: null,
          },
        },
      },
    ];
  },
});

const schema = getSchema([
  StarterKit.configure({
    heading: {
      levels: [1, 2, 3],
    },
    undoRedo: false,
  }),
  SigmaDocIdAttrs,
]);

describe("page break gap extension", () => {
  it("renders computed page gaps as non-editable spacer widgets instead of node margins", () => {
    const doc = createDoc([
      { id: "p_before", text: "before" },
      { id: "p_after", text: "after" },
    ]);

    const decorations = createPageBreakDecorations(doc, { p_after: 128 }, new Set(), { markerLabel: (kind) => kind }).find();

    expect(decorations).toHaveLength(1);
    expect(decorations[0].from).toBe(decorations[0].to);
    expect(decorationType(decorations[0]).spec).toMatchObject({
      blockId: "p_after",
      gap: 128,
      kind: "page-break-spacer",
      key: "page-break-spacer-p_after-128",
      side: -1,
    });
    expect(decorationType(decorations[0]).attrs).toBeUndefined();
  });

  it("keeps manual page break markers before automatic spacer widgets", () => {
    const doc = createDoc([
      { id: "p_before", text: "before" },
      { id: "p_after", text: "after" },
    ]);

    const decorations = createPageBreakDecorations(doc, { p_after: 96.4 }, new Set(["p_after"]), { markerLabel: (kind) => kind }).find();

    expect(decorations.map((decoration) => decorationType(decoration).spec.kind)).toEqual([
      "page-break-marker",
      "page-break-spacer",
    ]);
    expect(decorations.map((decoration) => decorationType(decoration).spec.side)).toEqual([-2, -1]);
    expect(decorations.map((decoration) => decorationType(decoration).spec.key)).toEqual([
      "page-break-marker-p_after-pageBreak-pageBreak-inline",
      "page-break-spacer-p_after-96",
    ]);
  });

  it("renders an accessible remove button and invokes the marker callback", () => {
    const doc = createDoc([
      { id: "p_before", text: "before" },
      { id: "p_after", text: "after" },
    ]);
    const removed: string[] = [];
    const marker = createPageBreakDecorations(doc, {}, new Set(["p_after"]), {
      markerLabel: () => "改ページ",
      removeLabel: () => "改ページを解除",
      removeButtonLabel: () => "× 解除",
      onRemove: (blockId) => removed.push(blockId),
    }).find()[0];
    const dom = decorationType(marker).toDOM?.() as HTMLElement;
    const button = dom.querySelector<HTMLButtonElement>("button");

    expect(button?.getAttribute("aria-label")).toBe("改ページを解除");
    expect(button?.textContent).toBe("× 解除");
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button?.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(removed).toEqual(["p_after"]);

    // A pointer click after mousedown must not dispatch twice, even if it lands late.
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(removed).toEqual(["p_after"]);

    const keyboardMarker = createPageBreakDecorations(doc, {}, new Set(["p_after"]), {
      markerLabel: () => "改ページ",
      removeLabel: () => "改ページを解除",
      removeButtonLabel: () => "× 解除",
      onRemove: (blockId) => removed.push(blockId),
    }).find()[0];
    const keyboardButton = (decorationType(keyboardMarker).toDOM?.() as HTMLElement)
      .querySelector<HTMLButtonElement>("button");
    keyboardButton?.click();
    expect(removed).toEqual(["p_after", "p_after"]);
  });

  it("does not render an actionable remove button on a continuation replica", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        SigmaDocIdAttrs,
        PageBreakGapExtension.configure({
          getGaps: () => ({}),
          getBreakBeforeIds: () => ["p_after"],
          getBreakBeforeKind: () => "pageBreak",
          getBreakBeforeKinds: () => ({}),
          getBreakBeforeLabel: () => "改ページ",
          getRemoveBreakLabel: () => "改ページを解除",
          getRemoveBreakButtonLabel: () => "× 解除",
          onRemoveBreak: () => {
            throw new Error("replica must not own removal");
          },
          isReplicaSurface: () => true,
          getBreakBeforeMarkerLayouts: () => ({}),
        }),
      ],
      content: createDoc([{ id: "p_after", text: "after" }]).toJSON(),
    });

    expect(element.querySelector("[data-page-break-marker] button")).toBeNull();
    editor.destroy();
    element.remove();
  });

  it("marks a column break by kind, not by the label text", () => {
    const doc = createDoc([
      { id: "p_before", text: "before" },
      { id: "p_after", text: "after" },
    ]);

    // **ラベルではなく種別で判定していること**が要点。英語表示にしても
    // `manual-column-break-before` が付き続けなければ段組が崩れる。
    const decorations = createPageBreakDecorations(doc, {}, new Set(["p_after"]), {
      markerKind: "columnBreak",
      markerLabel: () => "Column break",
    }).find();
    const marker = decorations.find((decoration) => decorationType(decoration).spec.kind === "page-break-marker");
    const columnBreakNode = decorations.find((decoration) => decorationType(decoration).attrs?.class === "manual-column-break-before");

    expect(marker && decorationType(marker).spec).toMatchObject({
      blockId: "p_after",
      kind: "page-break-marker",
      markerKind: "columnBreak",
      markerLabel: "Column break",
    });
    expect(columnBreakNode).toBeDefined();
  });

  it("uses a nested marker-kind override for an inner column break", () => {
    const doc = createDoc([
      { id: "p_before", text: "before" },
      { id: "p_after", text: "after" },
    ]);

    const decorations = createPageBreakDecorations(
      doc,
      {},
      new Set(["p_after"]),
      {
        markerKind: "pageBreak",
        markerKinds: { p_after: "columnBreak" },
        markerLabel: (kind) => (kind === "columnBreak" ? "改段" : "改ページ"),
      },
    ).find();
    const marker = decorations.find((decoration) => decorationType(decoration).spec.kind === "page-break-marker");

    expect(marker && decorationType(marker).spec.markerLabel).toBe("改段");
  });
  it("ignores prototype members when a block id collides with one", () => {
    // `sigmaDocId` は教材が決める任意の文字列。素のオブジェクトを id で引くと
    // `constructor` という id のブロックが `Object.prototype.constructor` を掴み、
    // 印のラベルが関数のソースになったり配置が NaN になったりする。
    const doc = createDoc([
      { id: "constructor", text: "危険な id" },
      { id: "p_after", text: "after" },
    ]);

    const decorations = createPageBreakDecorations(
      doc,
      {},
      new Set(["constructor"]),
      { markerKind: "pageBreak", markerLabel: () => "改ページ" },
    ).find();
    const marker = decorations.find((decoration) => decorationType(decoration).spec.kind === "page-break-marker");

    expect(marker && decorationType(marker).spec.markerLabel).toBe("改ページ");
    expect(marker && decorationType(marker).spec.key).toBe("page-break-marker-constructor-pageBreak-改ページ-inline");
    // 余白も同じ: `gaps["toString"]` が関数を返して spacer が生えてはいけない。
    expect(createPageBreakDecorations(
      createDoc([{ id: "toString", text: "本文" }]),
      {},
      new Set(),
      { markerLabel: (kind) => kind },
    ).find()).toEqual([]);
  });
  it("finds a manual break on a block nested inside another block", () => {
    // 改ページは枠や段組みセクションの中のブロックにも載る。走査を textblock で打ち切ったので、
    // 「入れ子には降り続ける」ことをここで固定する (この関数の存在理由そのもの)。
    const nested = schema.nodes.doc.create(null, [
      schema.nodes.blockquote.create(null, [
        schema.nodes.paragraph.create({ sigmaDocId: "p_inner" }, schema.text("中の段落")),
      ]),
    ]);

    const decorations = createPageBreakDecorations(nested, {}, new Set(["p_inner"]), { markerLabel: (kind) => kind }).find();

    expect(decorations.map((decoration) => decorationType(decoration).spec.kind)).toEqual([
      "page-break-marker",
    ]);
  });
});

describe("shouldRebuildPageBreakDecorations", () => {
  const doc = createDoc([{ id: "p1", text: "本文" }]);

  it("rebuilds whenever the document changed", () => {
    // 写像で済ませると (a) `setContent` (= undo/redo) で spacer と印が丸ごと消え、
    // (b) 先頭で Enter/Backspace したときに widget が別のブロックへ移る。
    const state = EditorState.create({ doc });

    expect(shouldRebuildPageBreakDecorations(state.tr.insertText("あ", 1))).toBe(true);
    expect(shouldRebuildPageBreakDecorations(
      state.tr.replaceWith(0, state.doc.content.size, doc.content),
    )).toBe(true);
  });

  it("rebuilds when the layout reports new gaps", () => {
    const state = EditorState.create({ doc });

    expect(shouldRebuildPageBreakDecorations(state.tr.setMeta(paginationGapKey, Date.now()))).toBe(true);
  });

  it("keeps the previous decorations for everything else", () => {
    // 選択の移動や、他の装飾の再描画合図では歩き直さない — これが WI-9 で消した無駄。
    const state = EditorState.create({ doc });

    expect(shouldRebuildPageBreakDecorations(state.tr)).toBe(false);
    expect(shouldRebuildPageBreakDecorations(state.tr.setMeta("otherPlugin", 1))).toBe(false);
  });
});

function createDoc(blocks: Array<{ id: string; text: string }>): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    blocks.map((block) =>
      schema.nodes.paragraph.create(
        {
          sigmaDocId: block.id,
        },
        block.text ? schema.text(block.text) : undefined,
      ),
    ),
  );
}

interface DecorationTypeWithSpec {
  toDOM?: () => Node;
  spec: {
    blockId?: string;
    gap?: number;
    key?: string;
    kind?: string;
    markerLabel?: string;
    side?: number;
  };
}

interface NodeDecorationType {
  attrs: Record<string, string>;
}

function decorationType(decoration: Decoration): DecorationTypeWithSpec & Partial<NodeDecorationType> {
  return (decoration as unknown as { type: DecorationTypeWithSpec & Partial<NodeDecorationType> }).type;
}
