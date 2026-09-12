import type { Extensions } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import type { BoxedTextRunHeightOptions } from "@/components/tiptap/boxed-text-run-height";
import { createRichTextEngineExtensions, runListKeyboardShortcut, shouldLiftNestedEmptyListItemOnEnter } from "@/components/tiptap/rich-text-engine";

describe("rich text engine", () => {
  it("shares inline text, math, and boxed-height extensions across text surfaces", () => {
    expect(extensionNames(createRichTextEngineExtensions())).toEqual(expect.arrayContaining([
      "starterKit",
      "underline",
      "boxed",
      "boxedTextRunHeight",
      "styledText",
      "mathInline",
      "listKeyboardShortcuts",
    ]));
  });

  it("adds the (1) marker input rule only where list structure is persisted", () => {
    // 本文以外の面 (図形テキスト / 表セル / ブロックエディタ) は inline 変換で保存するので、
    // そこでリストが作られると本文ごと落ちる。既定 off がその安全側。
    expect(extensionNames(createRichTextEngineExtensions())).not.toContain("parenOrderedList");
    expect(extensionNames(createRichTextEngineExtensions({ orderedListMarkerStyles: true })))
      .toContain("parenOrderedList");
  });

  it("matches the marker to the first run's font only where a static twin draws lists", () => {
    // 静的な双子がリストを描かない面 (図形テキスト / 表セル / ブロックエディタ) で有効にすると、
    // 編集面だけマーカーの字体が変わって印刷結果と食い違う。
    expect(extensionNames(createRichTextEngineExtensions())).not.toContain("listMarkerTypography");
    expect(extensionNames(createRichTextEngineExtensions({ listMarkerTypography: true })))
      .toContain("listMarkerTypography");
  });

  it("adds only surface-specific extensions from options", () => {
    const names = extensionNames(createRichTextEngineExtensions({
      blockExtensions: [stubExtension("sigmaDocTextAttrs")],
      lineHeight: true,
      placeholder: "入力",
      searchHighlight: true,
      textBlockStyle: true,
    }));

    expect(names).toEqual(expect.arrayContaining([
      "sigmaDocTextAttrs",
      "lineHeight",
      "placeholder",
      "searchHighlight",
      "textBlockStyle",
    ]));
  });

  it("draws one rectangle per boxed run by default and lets a surface opt out", () => {
    // Surfaces that swap the editor for a static renderer on blur must opt out: that renderer has
    // no frame layer, so a single drawn rectangle there would change the box shape on focus.
    expect(boxedRunFrameOption(createRichTextEngineExtensions())).toBe(true);
    expect(boxedRunFrameOption(createRichTextEngineExtensions({ drawBoxedRunFrames: false }))).toBe(false);
  });

  it("keeps Tab inside active list items instead of letting focus move away", () => {
    const calls: string[] = [];
    const editor = {
      isActive: (name: string) => name === "listItem",
      commands: {
        sinkListItem: (typeOrName: string) => {
          calls.push(`sink:${typeOrName}`);
          return false;
        },
        liftListItem: (typeOrName: string) => {
          calls.push(`lift:${typeOrName}`);
          return true;
        },
      },
    };

    expect(runListKeyboardShortcut(editor, "sink")).toBe(true);
    expect(runListKeyboardShortcut(editor, "lift")).toBe(true);
    expect(calls).toEqual(["sink:listItem", "lift:listItem"]);
  });

  it("allows normal Tab focus traversal outside list items", () => {
    const editor = {
      isActive: () => false,
      commands: {
        sinkListItem: () => {
          throw new Error("should not sink outside list items");
        },
        liftListItem: () => {
          throw new Error("should not lift outside list items");
        },
      },
    };

    expect(runListKeyboardShortcut(editor, "sink")).toBe(false);
    expect(runListKeyboardShortcut(editor, "lift")).toBe(false);
  });

  it("ends a nested list when Enter is pressed in its empty item", () => {
    const schema = getSchema(createRichTextEngineExtensions());
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "親" }] },
            {
              type: "orderedList",
              content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
            },
          ],
        }],
      }],
    });
    let emptyParagraphPos = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && node.content.size === 0) {
        emptyParagraphPos = pos;
        return false;
      }
      return true;
    });
    const state = EditorState.create({ schema, doc });
    const selected = state.apply(state.tr.setSelection(TextSelection.create(doc, emptyParagraphPos + 1)));

    expect(shouldLiftNestedEmptyListItemOnEnter(selected)).toBe(true);
  });

  it("keeps Enter unchanged for an empty item in the outermost list", () => {
    const schema = getSchema(createRichTextEngineExtensions());
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
      }],
    });
    const state = EditorState.create({ schema, doc });
    const selected = state.apply(state.tr.setSelection(TextSelection.create(doc, 3)));

    expect(shouldLiftNestedEmptyListItemOnEnter(selected)).toBe(false);
  });
});

function extensionNames(extensions: Extensions): string[] {
  return extensions.map((extension) => extension.name);
}

function boxedRunFrameOption(extensions: Extensions): unknown {
  const extension = extensions.find((candidate) => candidate.name === "boxedTextRunHeight");
  return (extension?.options as BoxedTextRunHeightOptions | undefined)?.drawRunFrames;
}

function stubExtension(name: string): Extensions[number] {
  return { name } as Extensions[number];
}
