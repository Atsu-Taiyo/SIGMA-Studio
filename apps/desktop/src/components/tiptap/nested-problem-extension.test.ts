// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";

import { textFlowToTiptap, tiptapToTextFlow } from "@/components/editor/text-flow/tiptap-document-adapter";
import { nestedProblemLayoutKey } from "@/components/tiptap/nested-problem-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import type { ProblemDisplayFilter } from "@/features/rendering/core";
import type { TextFlowBlock } from "@/features/text-editing";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

const ONLY_PROBLEM: ProblemDisplayFilter = { problem: true, solution: false, hints: false };
const ONLY_SOLUTION: ProblemDisplayFilter = { problem: false, solution: true, hints: false };

function paragraph(id: string, text: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text }] };
}

function boxedProblem(): TextFlowBlock[] {
  return [{
    type: "boxBlock",
    id: "box",
    styleId: "frame",
    blocks: [{
      type: "problem",
      id: "boxed",
      tags: [],
      lead: [],
      prompt: [paragraph("boxed_prompt", "問題文")],
      hints: [],
      solution: [paragraph("boxed_solution", "解答")],
    }],
  }] as unknown as TextFlowBlock[];
}

/** 箱の編集面と同じ構成。`display` は編集面が `getProblemDisplay` で渡す値。 */
function createBoxEditor(display: { current: ProblemDisplayFilter | undefined }) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension.configure({
          getProblemNumbers: () => new Map([["boxed", 3]]),
          getProblemDisplay: () => display.current,
        }),
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
        LayoutSectionExtension,
      ],
      bodyBlocks: true,
      listMarkerTypography: true,
      orderedListMarkerStyles: true,
    }),
    content: textFlowToTiptap(boxedProblem()),
  });
  editors.push(editor);
  return editor;
}

function areaElement(editor: Editor, area: string): HTMLElement {
  const element = editor.view.dom.querySelector<HTMLElement>(`[data-problem-area="${area}"]`);
  if (!element) throw new Error(`area ${area} not rendered`);
  return element;
}

function textRangeOf(doc: ProseMirrorNode, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text?.includes(text)) return !found;
    const from = pos + node.text.indexOf(text);
    found = { from, to: from + text.length };
    return false;
  });
  if (!found) throw new Error(`${text} not found`);
  return found;
}

function solutionText(editor: Editor): string {
  return JSON.stringify(tiptapToTextFlow(editor.getJSON()));
}

describe("problems nested in a box under the display filter (設定 > 表示)", () => {
  it("folds the areas the filter hides and keeps the rest editable", () => {
    const display = { current: ONLY_PROBLEM as ProblemDisplayFilter | undefined };
    const editor = createBoxEditor(display);

    expect(areaElement(editor, "solution").style.display).toBe("none");
    expect(areaElement(editor, "prompt").style.display).toBe("");

    const prompt = textRangeOf(editor.state.doc, "問題文");
    editor.view.dispatch(editor.state.tr.insertText("追記", prompt.to));
    expect(solutionText(editor)).toContain("問題文追記");
  });

  it("refuses an edit that would change a folded area, such as deleting across it", () => {
    const display = { current: ONLY_PROBLEM as ProblemDisplayFilter | undefined };
    const editor = createBoxEditor(display);
    const before = editor.state.doc;
    const prompt = textRangeOf(before, "問題文");
    const solution = textRangeOf(before, "解答");

    editor.view.dispatch(editor.state.tr.delete(prompt.from, solution.to));
    expect(editor.state.doc.eq(before)).toBe(true);

    // 絞り込みを外せば、同じ編集は通る。
    display.current = undefined;
    editor.view.dispatch(editor.state.tr.setMeta(nestedProblemLayoutKey, true));
    editor.view.dispatch(editor.state.tr.delete(solution.from, solution.to));
    expect(editor.state.doc.eq(before)).toBe(false);
  });

  it("moves the problem number to the first area it shows", () => {
    const display = { current: ONLY_SOLUTION as ProblemDisplayFilter | undefined };
    const editor = createBoxEditor(display);

    expect(areaElement(editor, "prompt").style.display).toBe("none");
    expect(areaElement(editor, "solution").style.display).toBe("");
    expect(areaElement(editor, "solution").getAttribute("data-problem-number")).toBe("3");
    expect(areaElement(editor, "lead").getAttribute("data-problem-number")).toBeNull();

    display.current = undefined;
    editor.view.dispatch(editor.state.tr.setMeta(nestedProblemLayoutKey, true));
    expect(areaElement(editor, "lead").getAttribute("data-problem-number")).toBe("3");
    expect(areaElement(editor, "prompt").style.display).toBe("");
  });
});
