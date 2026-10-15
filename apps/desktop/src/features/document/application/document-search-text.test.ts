import { describe, expect, it } from "vitest";

import type { OverlayShape, SigmaBlock, SigmaDocument } from "@/features/document";

import { documentSearchText } from "./document-search-text";

describe("documentSearchText", () => {
  it("reads every block that holds prose, in document order, one block per line", () => {
    const text = documentSearchText(documentWith([
      { type: "section", id: "s", title: "第1章 関数" },
      { type: "heading", id: "h", level: 1, children: [{ type: "text", text: "二次" }, { type: "text", text: "関数" }] },
      {
        type: "paragraph",
        id: "p",
        children: [
          { type: "text", text: "式は" },
          { type: "mathInline", id: "m", tex: "\\sin x", display: "inline" },
          { type: "text", text: "である" },
        ],
      },
      {
        type: "list",
        id: "l",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "li",
          children: [{ type: "text", text: "項目" }],
          continuations: [{ type: "divider", id: "d" }, { type: "paragraph", id: "c", children: [{ type: "text", text: "続き" }] }],
          nested: [{ type: "list", id: "n", listType: "ordered", items: [{ type: "listItem", id: "ni", children: [{ type: "text", text: "入れ子" }] }] }],
        }],
      },
      { type: "quote", id: "q", blocks: [{ type: "paragraph", id: "qp", children: [{ type: "text", text: "引用文" }] }] },
      { type: "codeBlock", id: "code", children: [{ type: "text", text: "print(1)\nprint(2)" }] },
      {
        type: "boxBlock",
        id: "b",
        styleId: "plain",
        title: [{ type: "text", text: "枠の題" }],
        blocks: [{ type: "layoutSection", id: "ls", layout: { columnCount: 2 }, children: [{ type: "paragraph", id: "lp", children: [{ type: "text", text: "段組の中" }] }] }],
      },
      {
        type: "problem",
        id: "pr",
        tags: ["微分", "接線"],
        lead: [{ type: "paragraph", id: "lead", children: [{ type: "text", text: "前文" }] }],
        prompt: [{ type: "paragraph", id: "prompt", children: [{ type: "text", text: "問い" }] }],
        hints: [{ type: "paragraph", id: "hint", children: [{ type: "text", text: "ヒント" }] }],
        solution: [{ type: "paragraph", id: "sol", children: [{ type: "text", text: "解答" }] }],
      },
      { type: "divider", id: "div" },
    ] as SigmaBlock[]));

    expect(text.split("\n")).toEqual([
      "第1章 関数",
      "二次関数",
      "式は \\sin x である",
      "項目",
      "続き",
      "入れ子",
      "引用文",
      "print(1) print(2)",
      "枠の題",
      "段組の中",
      "微分 接線",
      "前文",
      "問い",
      "ヒント",
      "解答",
    ]);
  });

  it("reads text boxes, callouts and tables on the page, and the header and footer", () => {
    const document = documentWith([{ type: "paragraph", id: "p", children: [{ type: "text", text: "本文" }] }]);
    document.pageLayout = {
      preset: "a4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      header: { enabled: true, heightMm: 10, offsetMm: 5, showOnFirstPage: true, blocks: [{ type: "paragraph", id: "hp", children: [{ type: "text", text: "期末考査" }] }] },
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [textShape("t", "図の注記"), tableShape("tb", "表の中身")] } },
    } as unknown as SigmaDocument["pageLayout"];

    expect(documentSearchText(document).split("\n")).toEqual(["本文", "期末考査", "図の注記", "表の中身"]);
  });

  it("does not throw on unvalidated JSON and still reads legacy chapters", () => {
    expect(documentSearchText({} as SigmaDocument)).toBe("");
    expect(documentSearchText({ content: [null, 3, { type: "paragraph", children: "x" }] } as unknown as SigmaDocument)).toBe("");
    expect(documentSearchText({
      chapters: [{ content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "旧形式" }] }] }],
    } as unknown as SigmaDocument)).toBe("旧形式");
  });
});

function documentWith(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc",
    metadata: { title: "題名は含めない" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    comments: [],
  };
}

function textShape(id: string, text: string): OverlayShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    props: { w: 120, h: 16, color: "#111827", size: "m", blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text }] }] },
  } as OverlayShape;
}

function tableShape(id: string, text: string): OverlayShape {
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    props: {
      w: 200,
      h: 100,
      table: {
        version: 1,
        kind: "plain",
        columns: [{ id: "col", width: { mode: "auto", min: 48 } }],
        rows: [{ id: "row", height: { mode: "auto", min: 32 } }],
        cells: [{ id: "cell", rowId: "row", columnId: "col", content: [{ type: "paragraph", id: "cp", children: [{ type: "text", text }] }] }],
        grid: { borderColor: "#111827", borderWidth: 1 },
        defaultCellStyle: {},
      },
    },
  } as OverlayShape;
}
