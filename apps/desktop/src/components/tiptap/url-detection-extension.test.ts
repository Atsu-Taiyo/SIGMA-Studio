import { Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
  applyUrlDecorationsToTransaction,
  createUrlDecorations,
  isOpenLinkClick,
} from "@/components/tiptap/url-detection-extension";

const SigmaDocIdAttrs = Extension.create({
  name: "testSigmaDocIdAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: { sigmaDocId: { default: null } },
      },
    ];
  },
});

const schema = getSchema([StarterKit.configure({ undoRedo: false }), SigmaDocIdAttrs]);

function createDoc(texts: string[]): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    texts.map((text, index) => schema.nodes.paragraph.create(
      { sigmaDocId: `p${index}` },
      text ? schema.text(text) : undefined,
    )),
  );
}

function decorationRanges(set: { find: () => readonly Decoration[] }): Array<[number, number]> {
  return set.find().map((decoration) => [decoration.from, decoration.to] as [number, number]);
}

/** 下線の装飾が持つ URL (ホバーのカードが引く `data-url`)。 */
function decorationUrls(decorations: readonly Decoration[]): string[] {
  return decorations
    .map((decoration) => (decoration as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.["data-url"])
    .filter((url): url is string => typeof url === "string");
}

describe("url detection decorations", () => {
  it("decorates every URL in the document on the first pass", () => {
    const doc = createDoc(["見て https://example.com/a ここ", "ふつうの段落", "https://example.com/b"]);

    const found = createUrlDecorations(doc).find();

    // 1 URL につき下線 (inline) が 1 つ。URL はその要素の data-url が持つ。
    expect(found).toHaveLength(2);
    expect(decorationUrls(found)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("carries the decorations of untouched blocks over untouched", () => {
    // ここが本題。打鍵のたびに全文へ正規表現をかけ直すと、URL が 1 つも無い文書でも
    // 打鍵コストが本文の長さに比例する。触っていない段落の装飾は写像で持ち越すだけでよい。
    const doc = createDoc(["https://example.com/a", "あとで打つ段落", "https://example.com/b"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);
    const untouched = before.find(1, 22);

    // 最後の段落の中で打つ (前の段落の位置は動かない)。
    const transaction = state.tr.insertText("X", state.doc.content.size - 1);
    const after = applyUrlDecorationsToTransaction(before, transaction);

    expect(after.find(1, 22)).toEqual(untouched);
    expect(after.find()).toHaveLength(2);
  });

  it("re-reads only the block the change landed in", () => {
    const doc = createDoc(["まだ URL は無い", "https://example.com/b"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    expect(before.find()).toHaveLength(1);

    // 1 段落目の末尾に URL を打ち切る。
    const transaction = state.tr.insertText(" https://example.com/new", 10);
    const after = applyUrlDecorationsToTransaction(before, transaction);

    expect(decorationUrls(after.find())).toEqual(["https://example.com/new", "https://example.com/b"]);
  });

  it("drops the decorations of a URL that was deleted", () => {
    const doc = createDoc(["https://example.com/a を消す"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    const transaction = state.tr.delete(1, 22);
    const after = applyUrlDecorationsToTransaction(before, transaction);

    expect(after.find()).toEqual([]);
  });

  it("gives the same answer as a full re-read after an edit", () => {
    // 局所的に読み直しても全文走査と同じ結果になること (これが崩れると URL が消える/残る)。
    const doc = createDoc(["https://example.com/a", "テキスト", "末尾 https://example.com/b"]);
    const state = EditorState.create({ doc });
    const transaction = state.tr.insertText("https://example.com/c ", 24);
    const incremental = applyUrlDecorationsToTransaction(createUrlDecorations(doc), transaction);
    const full = createUrlDecorations(transaction.doc);

    expect(decorationRanges(incremental)).toEqual(decorationRanges(full));
    expect(decorationUrls(incremental.find()).sort()).toEqual(decorationUrls(full.find()).sort());
  });

  it("re-reads both halves when a URL is split by Enter", () => {
    // 分割は「前半・後半の両方が変わる」唯一の打鍵。どちらかを読み落とすと、URL の途中で
    // 改行したときに下線が本文と食い違ったまま残る。
    const doc = createDoc(["https://example.com/split-here"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    // "https://example.com/" の直後で段落を分割する。
    const transaction = state.tr.split(21);
    const after = applyUrlDecorationsToTransaction(before, transaction);
    const full = createUrlDecorations(transaction.doc);

    expect(decorationRanges(after)).toEqual(decorationRanges(full));
    expect(decorationUrls(after.find()).sort()).toEqual(decorationUrls(full.find()).sort());
  });

  it("matches a full re-read when several blocks change in one transaction", () => {
    const doc = createDoc(["https://example.com/a", "まんなか", "https://example.com/b"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    const transaction = state.tr;
    transaction.insertText(" https://example.com/c", 22);
    transaction.insertText("X", 1);
    const after = applyUrlDecorationsToTransaction(before, transaction);
    const full = createUrlDecorations(transaction.doc);

    expect(decorationRanges(after)).toEqual(decorationRanges(full));
    expect(decorationUrls(after.find()).sort()).toEqual(decorationUrls(full.find()).sort());
  });

  it("re-reads a block whose marks changed, even though the step moves nothing", () => {
    // マークの step は位置を動かさないので `StepMap` が空。だがマークはテキストノードを割るので、
    // URL の一部を太字にすると検出は外れる。範囲が出ない step を無視すると、消えるはずの
    // 下線が残り続ける (全文再読とのズレ)。
    const doc = createDoc(["https://example.com/marked here"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    expect(before.find()).toHaveLength(1);

    const transaction = state.tr.addMark(10, 15, schema.marks.bold.create());
    const after = applyUrlDecorationsToTransaction(before, transaction);
    const full = createUrlDecorations(transaction.doc);

    expect(decorationRanges(after)).toEqual(decorationRanges(full));
  });

  it("brings a URL back when the mark that split it is removed", () => {
    const doc = createDoc(["https://example.com/marked here"]);
    const state = EditorState.create({ doc });
    const marked = state.tr.addMark(10, 15, schema.marks.bold.create());
    const markedState = state.apply(marked);
    const afterMark = applyUrlDecorationsToTransaction(createUrlDecorations(doc), marked);

    const unmarked = markedState.tr.removeMark(10, 15, schema.marks.bold);
    const after = applyUrlDecorationsToTransaction(afterMark, unmarked);
    const full = createUrlDecorations(unmarked.doc);

    expect(decorationRanges(after)).toEqual(decorationRanges(full));
    expect(after.find()).toHaveLength(1);
  });

  it("does nothing when the transaction did not change the document", () => {
    const doc = createDoc(["https://example.com/a"]);
    const state = EditorState.create({ doc });
    const before = createUrlDecorations(doc);

    const after = applyUrlDecorationsToTransaction(before, state.tr.setMeta("noop", 1));

    expect(after).toBe(before);
  });
});

describe("open-link click", () => {
  const click = (init: Partial<Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>) =>
    ({ button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as MouseEvent;

  it("opens on Cmd+click and Ctrl+click, with or without Shift", () => {
    expect(isOpenLinkClick(click({ metaKey: true }))).toBe(true);
    expect(isOpenLinkClick(click({ ctrlKey: true }))).toBe(true);
    expect(isOpenLinkClick(click({ metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves a plain click, Alt combinations and other buttons alone", () => {
    expect(isOpenLinkClick(click({}))).toBe(false);
    expect(isOpenLinkClick(click({ shiftKey: true }))).toBe(false);
    expect(isOpenLinkClick(click({ metaKey: true, altKey: true }))).toBe(false);
    expect(isOpenLinkClick(click({ metaKey: true, button: 2 }))).toBe(false);
  });
});
