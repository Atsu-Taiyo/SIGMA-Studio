// @vitest-environment happy-dom

import { Editor, getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { textFlowToTiptap, tiptapToTextFlow } from "@/components/editor/text-flow/tiptap-document-adapter";
import type { TextFlowBlock } from "@/features/text-editing";
import type { TiptapDoc } from "@/lib/tiptap-adapter";
import { createRichTextEngineExtensions } from "./rich-text-engine";
import { SigmaDocTextAttrs } from "./sigma-doc-text-attributes";
import { SigmaDocTextIdentity, appendSigmaDocTextIdentityTransaction } from "./sigma-doc-text-identity";

describe("SigmaDoc text identity", () => {
  it("does not repair node metadata during selection-only transactions", () => {
    const schema = getSchema([...createRichTextEngineExtensions(), SigmaDocTextAttrs]);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("本文"))]);
    const state = EditorState.create({ schema, doc });
    const selection = state.tr.setSelection(TextSelection.create(doc, 2));

    expect(appendSigmaDocTextIdentityTransaction([selection], state, state.apply(selection))).toBeNull();
  });

  it("does not append a metadata step when a content edit already has stable identities", () => {
    const schema = getSchema([...createRichTextEngineExtensions(), SigmaDocTextAttrs]);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { sigmaDocId: "p_original", sigmaDocType: "paragraph", pagination: { break: true } },
        schema.text("本文"),
      ),
    ]);
    const state = EditorState.create({ schema, doc });
    const edit = state.tr.insertText("追加", 2);

    expect(appendSigmaDocTextIdentityTransaction([edit], state, state.apply(edit))).toBeNull();
  });

  it.each([0, 1, 2])("keeps one manual break after the real Enter shortcut at offset %i", (offset) => {
    const previous: TextFlowBlock[] = [{
      type: "paragraph", id: "break_owner", children: [{ type: "text", text: "ss" }],
      pagination: { break: true },
    }];
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: createRichTextEngineExtensions({
        blockExtensions: [SigmaDocTextAttrs, SigmaDocTextIdentity],
      }),
      content: textFlowToTiptap(previous),
    });
    editor.commands.setTextSelection(1 + offset);
    editor.commands.keyboardShortcut("Enter");
    const result = tiptapToTextFlow(editor.getJSON() as TiptapDoc, previous);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("break_owner");
    expect(result.map(block => block.pagination?.break === true)).toEqual([true, false]);
    expect(editor.getJSON().content?.map(node => node.attrs?.pagination?.break === true)).toEqual([true, false]);
    editor.destroy();
  });

  it("keeps inline formatting armed after Enter assigns a fresh paragraph id", () => {
    const schema = getSchema([
      ...createRichTextEngineExtensions(),
      SigmaDocTextAttrs,
    ]);
    const styledText = schema.marks.styledText.create({
      color: "#1d4ed8",
      fontFamily: '"Yu Mincho", serif',
      fontSize: 18,
    });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { sigmaDocId: "p_original", sigmaDocType: "paragraph" },
        schema.text("本文", [styledText]),
      ),
    ]);
    const oldState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.firstChild!.content.size + 1),
    });
    const splitTransaction = oldState.tr
      .split(oldState.selection.from)
      .setStoredMarks([styledText]);
    const splitState = oldState.apply(splitTransaction);

    const identityTransaction = appendSigmaDocTextIdentityTransaction(
      [splitTransaction],
      oldState,
      splitState,
    );
    expect(identityTransaction).not.toBeNull();

    const nextState = splitState.apply(identityTransaction!);
    expect(nextState.doc.child(0).attrs.sigmaDocId).not.toBe(nextState.doc.child(1).attrs.sigmaDocId);
    expect(nextState.storedMarks?.map((mark) => ({ attrs: mark.attrs, type: mark.type.name }))).toEqual([
      {
        attrs: {
          backgroundColor: null,
          color: "#1d4ed8",
          fontFamily: '"Yu Mincho", serif',
          fontSize: 18,
        },
        type: "styledText",
      },
    ]);
  });

  it("recovers formatting from the pre-Enter caret when splitBlock drops stored marks", () => {
    const schema = getSchema([
      ...createRichTextEngineExtensions(),
      SigmaDocTextAttrs,
    ]);
    const styledText = schema.marks.styledText.create({
      color: "#1d4ed8",
      fontFamily: '"Yu Mincho", serif',
      fontSize: 18,
    });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { sigmaDocId: "p_original", sigmaDocType: "paragraph" },
        schema.text("本文", [styledText]),
      ),
    ]);
    const oldState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.firstChild!.content.size + 1),
    });
    const splitTransaction = oldState.tr.split(oldState.selection.from);
    const splitState = oldState.apply(splitTransaction);
    expect(splitState.storedMarks).toBeNull();

    const identityTransaction = appendSigmaDocTextIdentityTransaction(
      [splitTransaction],
      oldState,
      splitState,
    );
    const nextState = splitState.apply(identityTransaction!);

    expect(nextState.storedMarks?.map((mark) => mark.attrs.fontFamily)).toEqual([
      '"Yu Mincho", serif',
    ]);
  });

  it("assigns ids to quote, code, and divider blocks created by editor commands", () => {
    // PM のコマンド (`toggleQuoteBlock` 等) が作るノードは sigmaDocId を持たない。
    // 段組みのブロック配置は id で引くので、ここで配られないと配置されないまま
    // 「潰れた編集面 root の原点 = 1 ページ目上端」に取り残される。
    const schema = getSchema([
      ...createRichTextEngineExtensions({ bodyBlocks: true }),
      SigmaDocTextAttrs,
    ]);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { sigmaDocId: "p_lead", sigmaDocType: "paragraph" },
        schema.text("前"),
      ),
      schema.nodes.quote.create(null, [
        schema.nodes.paragraph.create(null, schema.text("引用")),
      ]),
      schema.nodes.codeBlock.create(null, schema.text("code")),
      schema.nodes.divider.create(null),
    ]);
    const oldState = EditorState.create({ schema, doc });
    const editTransaction = oldState.tr.insertText("あ", 1);
    const editedState = oldState.apply(editTransaction);

    const identityTransaction = appendSigmaDocTextIdentityTransaction(
      [editTransaction],
      oldState,
      editedState,
    );
    expect(identityTransaction).not.toBeNull();

    const nextState = editedState.apply(identityTransaction!);
    expect(nextState.doc.child(0).attrs.sigmaDocId).toBe("p_lead");
    expect(nextState.doc.child(1).attrs.sigmaDocId).toMatch(/^quote_/);
    expect(nextState.doc.child(1).firstChild!.attrs.sigmaDocId).toMatch(/^p_/);
    expect(nextState.doc.child(2).attrs.sigmaDocId).toMatch(/^code_/);
    expect(nextState.doc.child(3).attrs.sigmaDocId).toMatch(/^divider_/);
  });
});
