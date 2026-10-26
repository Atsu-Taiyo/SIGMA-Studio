import {
  createChainableState,
  getSchema,
  getTextContentFromNodes,
  type ExtendedRegExpMatchArray,
  type InputRule,
  type SingleCommands,
} from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import {
  createParenOrderedListInputRules,
  normalizeNestedOrderedListMarkerStyles,
  ORDERED_LIST_MARKER_INPUT_RULES,
  resolveOrderedListMarkerInput,
} from "@/components/tiptap/paren-ordered-list-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

function createTestSchema(): Schema {
  return getSchema(createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }));
}

const schema = createTestSchema();

function paragraphState(text: string): EditorState {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [{
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    }],
  });
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

/**
 * Replays what `inputRulesPlugin` does on `handleTextInput` without an editor view: the typed
 * character is not in the document yet, so the rule sees `<textblock text> + <typed text>` and
 * deletes the matched prefix itself.
 */
function typeCharacter(state: EditorState, rules: InputRule[], text: string): EditorState | null {
  const { from, to } = state.selection;
  const textBefore = getTextContentFromNodes(state.doc.resolve(from)) + text;

  for (const rule of rules) {
    const match = textBefore.match(rule.find as RegExp);
    if (!match) {
      continue;
    }

    const transaction = state.tr;
    const chainableState = createChainableState({ state, transaction });
    rule.handler({
      state: chainableState,
      range: { from: from - (match[0].length - text.length), to },
      match: match as ExtendedRegExpMatchArray,
      commands: {} as SingleCommands,
      chain: (() => undefined) as never,
      can: (() => undefined) as never,
    });
    if (!transaction.steps.length) {
      continue;
    }
    return state.apply(transaction);
  }

  return null;
}

function firstChild(doc: ProseMirrorNode): ProseMirrorNode {
  return doc.child(0);
}

function orderedListOf(markerStyle: string, count: number): ProseMirrorNode {
  return schema.nodeFromJSON({
    type: "orderedList",
    attrs: { start: 1, markerStyle },
    content: Array.from({ length: count }, (_, index) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: `項目${index + 1}` }] }],
    })),
  });
}

const alphaListOf = (count: number) => orderedListOf("parenLowerAlpha", count);
const romanListOf = (count: number) => orderedListOf("parenLowerRoman", count);

const parenRules = () => createParenOrderedListInputRules(schema.nodes.orderedList);

describe("ordered list marker input rules", () => {
  it("lists every supported marker form in one table so近い形式を後から足せる", () => {
    expect(ORDERED_LIST_MARKER_INPUT_RULES.map((rule) => rule.markerStyle)).toEqual([
      "paren", "parenLowerAlpha", "parenUpperAlpha", "parenLowerRoman", "parenUpperRoman",
    ]);
  });

  it.each([
    ["(a)", "parenLowerAlpha", 1],
    ["(c)", "parenLowerAlpha", 3],
    ["(B)", "parenUpperAlpha", 2],
    ["(i)", "parenLowerRoman", 1],
    ["(iv)", "parenLowerRoman", 4],
    ["(I)", "parenUpperRoman", 1],
  ])("wraps a line that starts with %s into a %s list starting at %i", (typed, markerStyle, start) => {
    const list = firstChild(typeCharacter(paragraphState(typed), parenRules(), " ")!.doc);
    expect(list.type.name).toBe("orderedList");
    expect(list.attrs.markerStyle).toBe(markerStyle);
    expect(list.attrs.start).toBe(start);
  });

  it("does not fire on letters that are neither one letter nor a roman numeral", () => {
    expect(typeCharacter(paragraphState("(ab)"), parenRules(), " ")).toBeNull();
    expect(typeCharacter(paragraphState("(Ab)"), parenRules(), " ")).toBeNull();
  });

  it("reads (i) after (h) as the next letter, and (v) after (iv) as the next roman numeral", () => {
    expect(resolveOrderedListMarkerInput("i", alphaListOf(8))).toEqual({ markerStyle: "parenLowerAlpha", start: 9 });
    expect(resolveOrderedListMarkerInput("v", romanListOf(4))).toEqual({ markerStyle: "parenLowerRoman", start: 5 });
    expect(resolveOrderedListMarkerInput("v", null)).toEqual({ markerStyle: "parenLowerAlpha", start: 22 });
    expect(resolveOrderedListMarkerInput("i", null)).toEqual({ markerStyle: "parenLowerRoman", start: 1 });
  });

  it("joins (b) onto the (a) list right before it", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        alphaListOf(1).toJSON(),
        { type: "paragraph", content: [{ type: "text", text: "(b)" }] },
      ],
    });
    const state = EditorState.create({ schema, doc });
    const next = typeCharacter(state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc))), parenRules(), " ");
    expect(next!.doc.childCount).toBe(1);
    expect(firstChild(next!.doc).childCount).toBe(2);
  });

  it("wraps a line that starts with (1) into a paren-marked ordered list", () => {
    const next = typeCharacter(paragraphState("(1)"), parenRules(), " ");

    expect(next).not.toBeNull();
    const list = firstChild(next!.doc);
    expect(list.type.name).toBe("orderedList");
    expect(list.attrs.markerStyle).toBe("paren");
    expect(list.attrs.start).toBe(1);
  });

  it("keeps the typed number as the list start", () => {
    const next = typeCharacter(paragraphState("(3)"), parenRules(), " ");

    expect(firstChild(next!.doc).attrs.start).toBe(3);
  });

  it("drops the marker text from the resulting list item", () => {
    const next = typeCharacter(paragraphState("(1)"), parenRules(), " ");

    expect(next!.doc.textContent).toBe("");
  });

  it("does not fire in the middle of a line", () => {
    expect(typeCharacter(paragraphState("答え (1)"), parenRules(), " ")).toBeNull();
  });

  it("does not fire without the closing parenthesis", () => {
    expect(typeCharacter(paragraphState("(1"), parenRules(), " ")).toBeNull();
  });

  it("leaves the plain decimal form to StarterKit", () => {
    expect(typeCharacter(paragraphState("1."), parenRules(), " ")).toBeNull();
  });
});

describe("nested ordered list marker inheritance", () => {
  function listState(parentMarkerStyle: string | null, childMarkerStyle: string | null): EditorState {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 1, markerStyle: parentMarkerStyle },
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "親" }] },
            {
              type: "orderedList",
              attrs: { start: 1, markerStyle: childMarkerStyle },
              content: [{
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "子" }] }],
              }],
            },
          ],
        }],
      }],
    });
    return EditorState.create({ schema, doc });
  }

  function nestedMarkerStyle(doc: ProseMirrorNode): unknown {
    return doc.child(0).child(0).child(1).attrs.markerStyle;
  }

  it("propagates the parent marker style to a list created by Tab", () => {
    const state = listState("paren", null);
    const transaction = normalizeNestedOrderedListMarkerStyles(state);

    expect(transaction).not.toBeNull();
    expect(nestedMarkerStyle(state.apply(transaction!).doc)).toBe("paren");
  });

  it("does nothing once the nested list already matches", () => {
    expect(normalizeNestedOrderedListMarkerStyles(listState("paren", "paren"))).toBeNull();
  });

  it("leaves a deliberately different nested marker style alone", () => {
    // 貼り付けや AI 提案は `1.` の下に `(1)` を入れ子にできる。書き換えたら黙って文書が変わる。
    expect(normalizeNestedOrderedListMarkerStyles(listState(null, "paren"))).toBeNull();
  });

  it("leaves a plain decimal parent and child untouched", () => {
    expect(normalizeNestedOrderedListMarkerStyles(listState(null, null))).toBeNull();
  });

  it("leaves documents without ordered lists untouched", () => {
    expect(normalizeNestedOrderedListMarkerStyles(paragraphState("ただの本文"))).toBeNull();
  });
});
