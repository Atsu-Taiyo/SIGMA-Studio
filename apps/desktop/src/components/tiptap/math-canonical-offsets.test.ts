// @vitest-environment happy-dom

import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import type { ParagraphNode } from "@/features/document";
import { toTiptap } from "@/lib/tiptap-adapter";
import { InlineMathExtension } from "./inline-math-extension";
import { resolveEditGuardSpans } from "./edit-guard-ranges";
import {
  EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT,
  ExternalTextRangeHighlightExtension,
  getPlainTextBlockLength,
} from "./external-text-range-highlight-extension";

describe("canonical offsets around formatted math", () => {
  it.each([String.raw`\boldsymbol{x}`, String.raw`\mathit{x}`, String.raw`\boldsymbol{\mathit{x}}`])(
    "keeps comments and edit reservations after %s on the canonical text",
    (tex) => {
      const paragraph: ParagraphNode = { type: "paragraph", id: "p1", children: [
        { type: "text", text: "前" },
        { type: "mathInline", id: "m1", tex, display: "inline" },
        { type: "text", text: "後" },
      ] };
      const projected = toTiptap(paragraph);
      projected.content[0].attrs = { ...projected.content[0].attrs, sigmaDocId: "p1" };
      const editor = new Editor({
        extensions: [StarterKit, InlineMathExtension, ExternalTextRangeHighlightExtension, Extension.create({
          name: "testBlockIds",
          addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { sigmaDocId: { default: null } } }],
        })],
        content: projected,
      });
      try {
        const baselineText = `前$${tex}$後`;
        const from = baselineText.length - 1;
        expect(getPlainTextBlockLength(editor.state.doc.firstChild!)).toBe(baselineText.length);
        window.dispatchEvent(new CustomEvent(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, { detail: { anchors: [{
          type: "textRange", start: { blockId: "p1", offset: from }, end: { blockId: "p1", offset: from + 1 }, quote: "後",
        }] } }));
        expect(editor.view.dom.querySelector(".external-text-range-highlight")?.textContent).toBe("後");
        expect(editor.view.dom.querySelector(".external-text-range-inline-math-highlight")).toBeNull();
        expect(resolveEditGuardSpans(editor.state.doc.firstChild!, 1, [{
          baselineText, ranges: [{ from, to: from + 1 }], inlineMathIds: [],
        }])).toEqual([{ from: 3, to: 4 }]);
      } finally {
        editor.destroy();
      }
    },
  );
});
