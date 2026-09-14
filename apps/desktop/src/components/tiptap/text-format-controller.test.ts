import { describe, expect, it } from "vitest";

import { getSchema, type Editor as TiptapEditor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

import {
  applyTextFormatCommand,
  collectSelectionFontFamilies,
  createTextFormatStateDetail,
  isCaretScopedTextFormatCommand,
  isValidTextFormatSelection,
  normalizeTextFormatAlign,
  normalizeTextFormatBoxedVariant,
  normalizeTextFormatFontSize,
  normalizeTextFormatNonnegativeNumber,
} from "./text-format-controller";

describe("text format controller", () => {
  it("keeps every inline format scoped to text typed from a collapsed caret", () => {
    expect([
      "bold",
      "italic",
      "underline",
      "boxed",
      "boxedPaddingY",
      "boxedVariant",
      "color",
      "backgroundColor",
      "fontFamily",
      "fontSize",
    ].every(isCaretScopedTextFormatCommand)).toBe(true);
    expect(isCaretScopedTextFormatCommand("lineHeight")).toBe(false);
    expect(isCaretScopedTextFormatCommand("textAlign")).toBe(false);
  });

  it("applies inline commands while restoring the selected range", () => {
    const { editor, calls } = createEditor();

    expect(applyTextFormatCommand(editor, { command: "bold" }, {
      selection: { from: 3, to: 8 },
      blockNodeType: "paragraph",
    })).toBe(true);
    expect(calls).toEqual([
      ["focus"],
      ["setTextSelection", { from: 3, to: 8 }],
      ["toggleBold"],
      ["setTextSelection", { from: 3, to: 8 }],
      ["run"],
    ]);
  });

  it("supports block style and preserves selection for TextFlow block attributes", () => {
    const heading = createEditor();
    applyTextFormatCommand(heading.editor, { command: "blockStyle", value: "h2" }, {
      selection: { from: 2, to: 7 },
      blockNodeType: "paragraph",
      allowBlockStyle: true,
    });
    expect(heading.calls).toContainEqual(["setHeading", { level: 2 }]);

    const aligned = createEditor();
    applyTextFormatCommand(aligned.editor, { command: "textAlign", value: "center" }, {
      selection: { from: 2, to: 7 },
      blockNodeType: "heading",
      preserveSelectionForBlockAttributes: true,
    });
    expect(aligned.calls).toEqual([
      ["focus"],
      ["setTextSelection", { from: 2, to: 7 }],
      ["updateAttributes", "heading", { textAlign: "center" }],
      ["setTextSelection", { from: 2, to: 7 }],
      ["run"],
    ]);
  });

  it("keeps RichText block attributes on the active node without replacing selection", () => {
    const { editor, calls } = createEditor();

    applyTextFormatCommand(editor, { command: "lineHeight", value: "1.75" }, {
      selection: { from: 2, to: 7 },
      blockNodeType: "paragraph",
      preserveSelectionForBlockAttributes: false,
    });

    expect(calls).toEqual([
      ["focus"],
      ["updateAttributes", "paragraph", { lineHeight: "1.75" }],
      ["run"],
    ]);
  });

  it("rejects unknown commands and invalid values without running a chain", () => {
    const { editor, calls } = createEditor();

    expect(applyTextFormatCommand(editor, { command: "unknown" }, {
      selection: null,
      blockNodeType: "paragraph",
    })).toBe(false);
    expect(applyTextFormatCommand(editor, { command: "fontSize", value: "0" }, {
      selection: null,
      blockNodeType: "paragraph",
    })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reads one shared toolbar state from Tiptap attributes", () => {
    const editor = {
      isActive: (name: string) => name === "boxed" || name === "bold" || name === "paragraph",
      getAttributes: (name: string) => name === "boxed"
        ? { paddingY: "2.5", variant: "double" }
        : { fontFamily: " serif ", fontSize: "13.5" },
    } as Pick<TiptapEditor, "getAttributes" | "isActive">;

    expect(createTextFormatStateDetail(editor, "material-editor")).toEqual({
      target: "material-editor",
      enabled: true,
      nodeType: "paragraph",
      blockId: null,
      bold: true,
      italic: false,
      underline: false,
      boxed: true,
      boxedPaddingY: 2.5,
      boxedVariant: "double",
      color: null,
      backgroundColor: null,
      fontFamily: " serif ",
      fontFamilyMixed: false,
      fontSize: 13.5,
      fontSizeMixed: false,
      lineHeight: null,
      inQuoteBlock: false,
      inCodeBlock: false,
      onDivider: false,
      codeLanguage: null,
      listType: null,
      orderedMarkerStyle: null,
    });
  });

  // The toolbar's 太字/斜体/下線 buttons render straight off this detail, so every inline mark the
  // selection carries has to survive the trip — a missing field silently reads back as "inactive".
  it("reports the inline marks and block line height under the selection", () => {
    const editor = {
      isActive: (name: string) => name === "bold" || name === "underline" || name === "heading",
      getAttributes: (name: string) => {
        if (name === "boxed") {
          return {};
        }
        if (name === "heading") {
          return { lineHeight: "1.35", level: 2 };
        }
        if (name === "paragraph") {
          return { lineHeight: "2" };
        }
        return { color: "#dc2626", backgroundColor: "#fff3c2" };
      },
    } as Pick<TiptapEditor, "getAttributes" | "isActive">;

    expect(createTextFormatStateDetail(editor)).toMatchObject({
      target: "document",
      bold: true,
      italic: false,
      underline: true,
      color: "#dc2626",
      backgroundColor: "#fff3c2",
      // Read from `heading`, not `paragraph`: the selection sits in a heading.
      lineHeight: "1.35",
    });
  });

  it("normalizes command values and selection bounds consistently", () => {
    expect(normalizeTextFormatAlign("justify")).toBe("justify");
    expect(normalizeTextFormatAlign("middle")).toBeUndefined();
    expect(normalizeTextFormatFontSize("12.5")).toBe(12.5);
    expect(normalizeTextFormatFontSize(0)).toBeUndefined();
    expect(normalizeTextFormatNonnegativeNumber("0")).toBe(0);
    expect(normalizeTextFormatNonnegativeNumber("-1")).toBeUndefined();
    expect(normalizeTextFormatBoxedVariant("oval")).toBe("oval");
    expect(normalizeTextFormatBoxedVariant("round")).toBeUndefined();
    expect(isValidTextFormatSelection({ from: 1, to: 4 }, 4)).toBe(true);
    expect(isValidTextFormatSelection({ from: 4, to: 4 }, 4)).toBe(false);
  });
});

function createEditor(): {
  editor: TiptapEditor;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const chain = new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        calls.push([String(property), ...args]);
        return chain;
      };
    },
  });
  const editor = {
    chain: () => chain,
  } as unknown as TiptapEditor;
  return { editor, calls };
}

describe("effective font under the selection", () => {
  const DOCUMENT_FONT = "Hiragino Sans, sans-serif";
  const BOX_BODY_FONT = "Hiragino Mincho ProN, serif";
  const BOX_TITLE_FONT = "Yu Gothic, sans-serif";
  const schema = getSchema(createRichTextEngineExtensions({
    blockExtensions: [SigmaDocTextAttrs, BoxBlockExtension, BoxBlockTitleExtension, BoxBlockBodyExtension],
  }));

  function styled(text: string, fontFamily?: string) {
    return {
      type: "text",
      text,
      ...(fontFamily ? { marks: [{ type: "styledText", attrs: { fontFamily } }] } : {}),
    };
  }

  function stateOf(content: unknown[], select?: { from: number; to?: number }): EditorState {
    const doc = schema.nodeFromJSON({ type: "doc", content });
    const state = EditorState.create({ schema, doc });
    if (!select) {
      return state;
    }
    return state.apply(state.tr.setSelection(
      TextSelection.create(state.doc, select.from, select.to ?? select.from),
    ));
  }

  function fontOf(state: EditorState) {
    const detail = createTextFormatStateDetail(
      { isActive: () => false, getAttributes: () => ({}) } as Pick<TiptapEditor, "getAttributes" | "isActive">,
      "document",
      undefined,
      { state, documentFontFamily: DOCUMENT_FONT },
    );
    return { fontFamily: detail.fontFamily, fontFamilyMixed: detail.fontFamilyMixed };
  }

  it("shows the document default where the caret sits in unmarked text", () => {
    const state = stateOf([{ type: "paragraph", content: [styled("あいうえお")] }], { from: 3 });

    expect(fontOf(state)).toEqual({ fontFamily: DOCUMENT_FONT, fontFamilyMixed: false });
  });

  it("shows the run's own font where the caret sits inside a marked run", () => {
    const state = stateOf([{ type: "paragraph", content: [styled("あいう", "Courier New, monospace")] }], { from: 3 });

    expect(fontOf(state)).toEqual({ fontFamily: "Courier New, monospace", fontFamilyMixed: false });
  });

  it("blanks the toolbar when the selection spans two fonts", () => {
    const state = stateOf(
      [{ type: "paragraph", content: [styled("あい", "Courier New, monospace"), styled("うえ", "Times New Roman, serif")] }],
      { from: 1, to: 5 },
    );

    expect(fontOf(state).fontFamilyMixed).toBe(true);
  });

  it("keeps a single-font selection showing that font", () => {
    const state = stateOf(
      [{ type: "paragraph", content: [styled("あいうえ", "Courier New, monospace")] }],
      { from: 1, to: 5 },
    );

    expect(fontOf(state)).toEqual({ fontFamily: "Courier New, monospace", fontFamilyMixed: false });
  });

  it("does not call a selection mixed when the unmarked part resolves to the same font", () => {
    const state = stateOf(
      [{ type: "paragraph", content: [styled("あい"), styled("うえ", DOCUMENT_FONT)] }],
      { from: 1, to: 5 },
    );

    expect(fontOf(state)).toEqual({ fontFamily: DOCUMENT_FONT, fontFamilyMixed: false });
  });

  it("shows the surrounding default in an empty paragraph", () => {
    const state = stateOf([{ type: "paragraph" }], { from: 1 });

    expect(fontOf(state)).toEqual({ fontFamily: DOCUMENT_FONT, fontFamilyMixed: false });
  });

  it("inherits the run on the left at a boundary between two fonts", () => {
    // ProseMirror の既定。表示と「次に打つ文字のフォント」を一致させるため、この挙動に従う。
    const state = stateOf(
      [{ type: "paragraph", content: [styled("あい", "Courier New, monospace"), styled("うえ", "Times New Roman, serif")] }],
      { from: 3 },
    );

    expect(fontOf(state)).toEqual({ fontFamily: "Courier New, monospace", fontFamilyMixed: false });
  });

  it("follows the box body font inside a frame", () => {
    const state = stateOf([{
      type: "boxBlock",
      attrs: { frame: { bodyFontFamily: BOX_BODY_FONT, titleFontFamily: BOX_TITLE_FONT } },
      content: [
        { type: "boxBlockTitle" },
        { type: "boxBlockBody", content: [{ type: "paragraph", content: [styled("枠の本文")] }] },
      ],
    }], { from: 6 });

    expect(fontOf(state)).toEqual({ fontFamily: BOX_BODY_FONT, fontFamilyMixed: false });
  });

  it("follows the box title font inside a frame title", () => {
    const state = stateOf([{
      type: "boxBlock",
      attrs: { frame: { bodyFontFamily: BOX_BODY_FONT, titleFontFamily: BOX_TITLE_FONT } },
      content: [
        { type: "boxBlockTitle", content: [styled("枠のタイトル")] },
        { type: "boxBlockBody", content: [{ type: "paragraph", content: [styled("枠の本文")] }] },
      ],
    }], { from: 3 });

    expect(fontOf(state)).toEqual({ fontFamily: BOX_TITLE_FONT, fontFamilyMixed: false });
  });

  it("ignores a frame whose style makes the stored font never reach the glyphs", () => {
    // cornerbox は本文/タイトルに `font-family: inherit` を宣言しており、枠に保存された明朝は
    // 実際には描かれない。ここで枠のフォントを返すと、まさにこの WI が潰した「嘘の表示」になる。
    const state = stateOf([{
      type: "boxBlock",
      attrs: {
        styleId: "cornerbox",
        frame: {
          bodyFontFamily: BOX_BODY_FONT,
          titleFontFamily: BOX_TITLE_FONT,
          decorations: [{ type: "titleDoubleRule", ruleWidthPx: 1, ruleColor: "#111111", guideColor: "#b8b8b8" }],
        },
      },
      content: [
        { type: "boxBlockTitle" },
        { type: "boxBlockBody", content: [{ type: "paragraph", content: [styled("枠の本文")] }] },
      ],
    }], { from: 6 });

    expect(fontOf(state)).toEqual({ fontFamily: DOCUMENT_FONT, fontFamilyMixed: false });
  });

  it("leaves a frame title on the document default when only the body font is set", () => {
    const state = stateOf([{
      type: "boxBlock",
      attrs: { frame: { bodyFontFamily: BOX_BODY_FONT } },
      content: [
        { type: "boxBlockTitle", content: [styled("枠のタイトル")] },
        { type: "boxBlockBody", content: [{ type: "paragraph", content: [styled("枠の本文")] }] },
      ],
    }], { from: 3 });

    expect(fontOf(state)).toEqual({ fontFamily: DOCUMENT_FONT, fontFamilyMixed: false });
  });

  it("stops collecting once enough distinct fonts prove the selection is mixed", () => {
    // 長い選択を保持したまま打鍵しても、走査が選択末尾まで伸び続けないこと。
    const runs = Array.from({ length: 200 }, (_, index) => styled("あ", `Font${index}, serif`));
    const state = stateOf([{ type: "paragraph", content: runs }], { from: 1, to: 201 });

    expect(collectSelectionFontFamilies(state).length).toBeLessThanOrEqual(3);
    expect(fontOf(state).fontFamilyMixed).toBe(true);
  });

  it("keeps the previous behaviour when no editor state is supplied", () => {
    // 疑似エディタしか渡さない既存の呼び出しを壊さない。
    const editor = {
      isActive: () => false,
      getAttributes: () => ({ fontFamily: "serif" }),
    } as Pick<TiptapEditor, "getAttributes" | "isActive">;

    expect(createTextFormatStateDetail(editor, "document")).toMatchObject({
      fontFamily: "serif",
      fontFamilyMixed: false,
    });
  });
});
