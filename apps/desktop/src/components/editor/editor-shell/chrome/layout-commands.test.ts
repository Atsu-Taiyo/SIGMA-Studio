import { describe, expect, it } from "vitest";

import type { ParagraphNode, SigmaDocument } from "@/features/document";

import { resolveColumnCommandState } from "./layout-commands";

const paragraph = (id: string): ParagraphNode => ({
  type: "paragraph",
  id,
  children: [{ type: "text", text: id }],
});

const document: SigmaDocument = {
  version: "2.0",
  docId: "doc_test",
  metadata: { title: "Test" },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  content: [
    paragraph("body_1"),
    {
      type: "layoutSection",
      id: "section_1",
      layout: { columnCount: 2 },
      children: [paragraph("in_section_1")],
    },
    {
      type: "problem",
      id: "problem_1",
      tags: [],
      lead: [],
      prompt: [
        paragraph("prompt_1"),
        {
          type: "layoutSection",
          id: "prompt_section",
          layout: { columnCount: 2 },
          children: [paragraph("in_prompt_section")],
        },
      ],
      solution: [paragraph("solution_1")],
      hints: [],
    },
    // 2段組セクションの中に置かれた枠。枠の中の段落は「枠の外のセクションの段数を
    // 変える」のではなく「枠の中で段組にする」対象になる。
    {
      type: "layoutSection",
      id: "section_with_box",
      layout: { columnCount: 2 },
      children: [
        {
          type: "boxBlock",
          id: "box_1",
          styleId: "fancybox",
          blocks: [paragraph("in_box_in_section")],
        },
      ],
    },
  ],
};

describe("resolveColumnCommandState", () => {
  it("選択が無ければ段組みは使えない", () => {
    expect(resolveColumnCommandState(document, null)).toEqual({
      enabled: false,
      currentColumnCount: 1,
      sectionId: null,
    });
  });

  it("トップレベルの段落は段組みにできる", () => {
    expect(resolveColumnCommandState(document, "body_1")).toEqual({
      enabled: true,
      currentColumnCount: 1,
      sectionId: null,
    });
  });

  it("すでに段組セクションの中なら現在の段数と対象セクションを返す", () => {
    expect(resolveColumnCommandState(document, "in_section_1")).toEqual({
      enabled: true,
      currentColumnCount: 2,
      sectionId: "section_1",
    });
  });

  it("問題文のように段組セクションを作れない位置では使えない", () => {
    // 解答エリア以外は wrapTextFlowBlocksInLayoutSection が再帰しないので、
    // 押せてしまうと無反応のボタンになる。
    expect(resolveColumnCommandState(document, "prompt_1")).toEqual({
      enabled: false,
      currentColumnCount: 1,
      sectionId: null,
    });
    expect(resolveColumnCommandState(document, "problem_1")).toEqual({
      enabled: false,
      currentColumnCount: 1,
      sectionId: null,
    });
    expect(resolveColumnCommandState(document, "missing_id")).toEqual({
      enabled: false,
      currentColumnCount: 1,
      sectionId: null,
    });
  });

  it("解答エリアの段落は段組みにできる", () => {
    expect(resolveColumnCommandState(document, "solution_1")).toEqual({
      enabled: true,
      currentColumnCount: 1,
      sectionId: null,
    });
  });

  it("段組セクションの中の枠にある段落は、外側のセクションではなく枠の中を対象にする", () => {
    // 外側のセクションを書き換えると、ユーザーが選んでいない兄弟ブロックまで
    // 作り変えてしまう。右クリックメニューと同じく枠ローカルの段組だけを見る。
    expect(resolveColumnCommandState(document, "in_box_in_section")).toEqual({
      enabled: true,
      currentColumnCount: 1,
      sectionId: null,
    });
  });

  it("問題文の中の段組セクションは対象にしない", () => {
    expect(resolveColumnCommandState(document, "in_prompt_section")).toEqual({
      enabled: false,
      currentColumnCount: 1,
      sectionId: null,
    });
  });
});
