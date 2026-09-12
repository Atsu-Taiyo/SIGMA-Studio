import { isOverlayShape, overlayTextBlocksToInlineNodes } from "@/features/document";
import { createGraph3DSpecPreset, DEFAULT_TEXT_SHAPE_WIDTH, getGraph3DPreviewSourceHash } from "@/features/drawing";
import { describe, expect, it } from "vitest";

import {
  applyAiTableCellPatches,
  buildGraph3DSpecFromToolArgs,
  commitSigmaDocMutation,
  createShapeToolMarkdownBlocks,
  createSigmaDocAgentSession,
  createTableSpecFromAiToolArgs,
  executeSigmaDocAgentDraftTool,
  executeSigmaDocAgentReadTool,
  getShapeToolTextBox,
  getSigmaDocAgentSessionDraft,
  normalizeAiShapeGeometryPatch,
  summarizeSessionDraftForToolResult,
  summarizeSigmaDocMutationOps,
} from "@/lib/ai/sigma-doc-agent-tools";
import { estimateBlockRects, getDefaultPageLayout, OVERLAY_ARROWHEADS } from "@/features/document";
import { resolveShapePosition } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";
import type { Graph3DCut, OverlayArrowShape, OverlayCalloutShape, OverlayGeoShape, OverlayGraph3DShape, OverlayGraphShape, OverlayLineShape, OverlayShape, OverlayTableShape, OverlayTextShape, SigmaTableSpec } from "@/features/document";
import type { BoxBlockChildBlock, SigmaDocument, Graph2DSpec } from "@/types/sigma-doc";
import type { MaterialItem } from "@/types/material";

/** A real 1x1 PNG: the AI overlay asset gate decodes the bytes and reads IHDR. */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** A second real PNG (2x2), so a replaced preview can be told apart from the one it replaced. */
const PNG_2X2_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

describe("SigmaDoc draft mutation tools", () => {
  it("copy-with replaces text while preserving the source run formatting", () => {
    const document = createDocument([{
      type: "paragraph",
      id: "p_copy_with",
      children: [
        { type: "text", text: "前半" },
        {
          type: "text",
          text: "変更前",
          marks: ["bold"],
          fontFamily: 'ui-serif, "Yu Mincho", serif',
          fontSize: 14,
        },
        { type: "text", text: "後半" },
      ],
    }]);
    document.metadata.styleUnits = { fontSize: "pt" };
    const session = createSigmaDocAgentSession({ document, selectedId: "p_copy_with" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_replace_inline_text", {
      targetId: "p_copy_with",
      from: 2,
      to: 5,
      quote: "変更前",
      replacement: "変更後",
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[0]).toEqual({
      type: "paragraph",
      id: "p_copy_with",
      children: [
        { type: "text", text: "前半" },
        {
          type: "text",
          text: "変更後",
          marks: ["bold"],
          fontFamily: 'ui-serif, "Yu Mincho", serif',
          fontSize: 14,
        },
        { type: "text", text: "後半" },
      ],
    });
  });

  it("rejects a stale copy-with text patch without changing the draft", () => {
    const document = createDocument([paragraph("p_copy_with_stale", "現在の本文")]);
    const session = createSigmaDocAgentSession({ document, selectedId: "p_copy_with_stale" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_replace_inline_text", {
      targetId: "p_copy_with_stale",
      from: 0,
      to: 3,
      quote: "古い本文",
      replacement: "更新後",
    });

    expect(result.ok).toBe(false);
    expect(session.operations).toHaveLength(0);
    expect(session.draftDocument.content[0]).toEqual(paragraph("p_copy_with_stale", "現在の本文"));
  });

  it("reduces legacy full-text updates to a copy-with patch that preserves formatting", () => {
    const document = createDocument([{
      type: "paragraph",
      id: "p_legacy_update",
      children: [
        { type: "text", text: "前置き" },
        { type: "text", text: "変更前", fontFamily: "serif", fontSize: 14 },
        { type: "text", text: "末尾", marks: ["underline"] },
      ],
    }]);
    document.metadata.styleUnits = { fontSize: "pt" };
    const session = createSigmaDocAgentSession({ document, selectedId: "p_legacy_update" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_rich_content", {
      targetId: "p_legacy_update",
      text: "前置き変更後末尾",
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[0]).toEqual({
      type: "paragraph",
      id: "p_legacy_update",
      children: [
        { type: "text", text: "前置き" },
        { type: "text", text: "変更後", fontFamily: "serif", fontSize: 14 },
        { type: "text", text: "末尾", marks: ["underline"] },
      ],
    });
  });

  it("formats an inline range without changing its text or unrelated marks", () => {
    const document = createDocument();
    document.content[0] = {
      type: "paragraph",
      id: "p_1",
      children: [
        { type: "text", text: "重要", marks: ["bold"] },
        { type: "text", text: "な結論" },
      ],
    };
    const session = createSigmaDocAgentSession({ document, selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_format_inline", {
      targetId: "p_1",
      from: 2,
      to: 5,
      quote: "な結論",
      style: {
        fontFamily: 'ui-serif, "Yu Mincho", serif',
        fontSize: 14,
        boxed: { enabled: true, variant: "double", tone: "blue" },
      },
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[0]).toEqual({
      type: "paragraph",
      id: "p_1",
      children: [
        { type: "text", text: "重要", marks: ["bold"] },
        {
          type: "text",
          text: "な結論",
          marks: ["boxed"],
          fontFamily: 'ui-serif, "Yu Mincho", serif',
          fontSize: 14,
          boxedVariant: "double",
          boxedTone: "blue",
        },
      ],
    });
  });

  it("rejects an inline format operation when its quote is stale", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_format", "現在の本文")]),
      selectedId: "p_format",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_format_inline", {
      targetId: "p_format",
      from: 0,
      to: 3,
      quote: "古い本文",
      style: { fontSize: 16 },
    });

    expect(result.ok).toBe(false);
    expect(session.operations).toHaveLength(0);
    expect(session.draftDocument.content[0]).toEqual(paragraph("p_format", "現在の本文"));
  });

  it("keeps every explicitly typed math run as mathInline when updating rich content", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_math_update", "[1] n=1 のとき")]),
      selectedId: "p_math_update",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_rich_content", {
      targetId: "p_math_update",
      runs: [
        "[1] ",
        { type: "math", id: "math_n_eq_1", tex: "n=1" },
        " のとき、",
        { type: "math", id: "math_base_case", tex: "1^7-1=0" },
        " は 7 の倍数である。",
      ],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[0]).toMatchObject({
      type: "paragraph",
      id: "p_math_update",
      children: [
        { type: "text", text: "[1] " },
        { type: "mathInline", id: "math_n_eq_1", tex: "n=1", display: "inline" },
        { type: "text", text: " のとき、" },
        { type: "mathInline", id: "math_base_case", tex: "1^7-1=0", display: "inline" },
        { type: "text", text: " は 7 の倍数である。" },
      ],
    });
  });

  it("returns SigmaDoc documents mentioned from the desktop composer", () => {
    const mentionedDocument = createDocument([paragraph("mentioned_p", "参照教材の本文")]);
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      mentionedDocuments: [{
        id: "sigma-doc-file_other",
        fileId: "file_other",
        title: "参照教材",
        documentPath: "documents/file_other.sigmadoc.json",
        revision: 3,
        excerpt: "参照教材の本文",
        document: mentionedDocument,
      }],
    });

    const result = executeSigmaDocAgentReadTool(session, "get_mentioned_sigma_docs", {});

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      documents: [{
        fileId: "file_other",
        title: "参照教材",
        revision: 3,
        document: {
          content: [expect.objectContaining({ id: "mentioned_p" })],
        },
      }],
    });
  });

  it("returns semantic material catalog entries and full material content", () => {
    const spring = materialItem("material_spring", "バネ素材");
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      materials: [spring],
    });

    const catalogResult = executeSigmaDocAgentReadTool(session, "get_material_catalog", {
      concepts: ["バネ"],
    });
    const contentResult = executeSigmaDocAgentReadTool(session, "get_material_content", {
      materialId: "material_spring",
    });

    expect(catalogResult.ok).toBe(true);
    expect(catalogResult.data).toMatchObject({
      matchedCount: 1,
      materials: [{
        id: "material_spring",
        description: "力学の台車や小球に接続するコイルばね",
        usage: {
          aliases: ["spring", "coil"],
        },
        visualConcepts: ["バネ", "コイル", "spring"],
      }],
    });
    expect(contentResult.ok).toBe(true);
    expect(contentResult.data).toMatchObject({
      material: {
        id: "material_spring",
        content: {
          blocks: [expect.objectContaining({ id: "material_spring_text" })],
        },
      },
    });
  });

  it("inserts saved material content as cloned blocks and overlay shapes", () => {
    const spring = materialItem("material_spring", "バネ素材");
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      materials: [spring],
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_material", {
      materialId: "material_spring",
      targetId: "p_1",
      x: 40,
      y: 72,
      scaleX: 1.5,
    });
    const draft = getSigmaDocAgentSessionDraft(session, {
      summary: "素材を挿入しました。",
      plan: ["素材挿入"],
      warnings: [],
    });
    const insertedBlock = draft.nextDocument.content[1];
    const overlayShape = draft.nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0];

    expect(result.ok).toBe(true);
    expect(insertedBlock).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "バネ定数 k" }],
    });
    expect(insertedBlock?.id).not.toBe("material_spring_text");
    // 素材本文の新規ブロックはこの時点でまだ計測できないため、アンカーは配置基準に
    // 使った既存ブロック側に付く (x/y は要求どおりの絶対座標のまま)。
    expect(overlayShape).toMatchObject({
      type: "geo",
      x: 40,
      y: 72,
      anchor: { type: "block", blockId: "p_1" },
      props: { w: 120, h: 36 },
    });
    expect(overlayShape?.id).not.toBe("material_spring_shape");
  });

  it("creates a problem and updates its answer in draft only", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const createResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem", {
      targetId: "p_1",
      problem: {
        type: "problem",
        id: "problem_ai",
        tags: [],
        lead: [],
        prompt: [paragraph("prompt_ai", "二次方程式 x^2-1=0 を解け。")],
        answer: { type: "math", expected: "x=\\pm1" },
        solution: [paragraph("solution_ai", "因数分解して解く。")],
        hints: [],
      },
    });
    expect(createResult.ok).toBe(true);

    const answerResult = executeSigmaDocAgentDraftTool(session, "draft_update_problem_answer", {
      targetId: "problem_ai",
      answer: { type: "math", expected: "x=\\pm1" },
      solution: [paragraph("solution_ai_2", "x^2-1=(x-1)(x+1) より、x=\\pm1。")],
    });
    expect(answerResult.ok).toBe(true);

    const draft = getSigmaDocAgentSessionDraft(session, {
      summary: "問題と解答を作成しました。",
      plan: ["問題作成", "解答更新"],
      warnings: [],
      changedIds: ["problem_ai"],
    });

    expect(createDocument().content).toHaveLength(1);
    expect(draft.nextDocument.content).toHaveLength(3);
    expect(draft.nextDocument.content[1]).toMatchObject({
      type: "problem",
      id: "problem_ai",
      answer: { expected: "x=\\pm1" },
    });
    expect(draft.nextDocument.content[2]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
    expect(draft.draft.operations).toHaveLength(2);
  });

  it("inserts body content and problem content from AI-friendly arguments", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks: [
        {
          type: "heading",
          id: "ai_heading",
          level: 2,
          text: "平方完成",
          pagination: { break: true, keepWithNext: true },
        },
        {
          type: "paragraph",
          id: "ai_body_math",
          runs: [
            "次の式を平方完成すると ",
            { type: "math", id: "ai_math_square", tex: "x^2+4x+1=(x+2)^2-3" },
            " となる。",
          ],
        },
      ],
    }).ok).toBe(true);

    const createProblem = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "ai_body_math",
      id: "problem_ai_content",
      lead: { type: "heading", id: "lead_ai_content", level: 3, text: "確認問題" },
      prompt: [{
        id: "prompt_ai_content",
        runs: ["方程式 ", { type: "math", id: "prompt_math", tex: "x^2-4=0" }, " を解け。"],
      }],
      answerTex: "x=\\pm2",
      solution: { id: "solution_ai_content", text: "因数分解を使う。" },
      pagination: { keepTogether: true },
    });
    expect(createProblem.ok).toBe(true);

    expect(executeSigmaDocAgentDraftTool(session, "draft_update_problem_content", {
      targetId: "problem_ai_content",
      answerTex: "x=\\pm2",
      solution: [{
        id: "solution_ai_updated",
        runs: [
          { type: "math", id: "solution_math", tex: "x^2-4=(x-2)(x+2)" },
          " より、",
          { type: "math", id: "solution_answer_math", tex: "x=\\pm2" },
          "。",
        ],
      }],
      pagination: { break: true, keepTogether: true },
    }).ok).toBe(true);

    expect(session.draftDocument.content).toHaveLength(5);
    expect(session.draftDocument.content[1]).toMatchObject({
      type: "heading",
      id: "ai_heading",
      pagination: { break: true, keepWithNext: true },
    });
    expect(session.draftDocument.content[2]).toMatchObject({
      type: "paragraph",
      id: "ai_body_math",
    });
    expect(session.draftDocument.content[2]).toHaveProperty(
      "children",
      expect.arrayContaining([expect.objectContaining({ type: "mathInline", tex: "x^2+4x+1=(x+2)^2-3" })]),
    );
    expect(session.draftDocument.content[3]).toMatchObject({
      type: "problem",
      id: "problem_ai_content",
      lead: [{ type: "heading", children: [{ text: "確認問題" }] }],
      answer: { type: "math", expected: "x=\\pm2" },
      pagination: { break: true, keepTogether: true },
    });
    expect(session.draftDocument.content[3]).toHaveProperty(
      "solution",
      [expect.objectContaining({
        id: "solution_ai_updated",
        children: expect.arrayContaining([expect.objectContaining({ type: "mathInline", tex: "x=\\pm2" })]),
      })],
    );
    expect(executeSigmaDocAgentDraftTool(session, "draft_update_problem_content", {
      targetId: "problem_ai_content",
      pagination: null,
    }).ok).toBe(true);
    expect(session.draftDocument.content[3]).not.toHaveProperty("pagination");
    expect(session.draftDocument.content[4]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
  });

  it("updates and clears pagination without rewriting paragraph content", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_1", "本文")]),
      selectedId: "p_1",
    });

    expect(executeSigmaDocAgentDraftTool(session, "draft_update_rich_content", {
      targetId: "p_1",
      pagination: { keepTogether: true, keepWithNext: true },
    }).ok).toBe(true);
    expect(session.draftDocument.content[0]).toMatchObject({
      id: "p_1",
      children: [{ type: "text", text: "本文" }],
      pagination: { keepTogether: true, keepWithNext: true },
    });

    expect(executeSigmaDocAgentDraftTool(session, "draft_update_rich_content", {
      targetId: "p_1",
      pagination: null,
    }).ok).toBe(true);
    expect(session.draftDocument.content[0]).not.toHaveProperty("pagination");
  });

  it("draft_replace_block replaces an existing block in place via the replace op", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_1", "元の本文"), paragraph("p_2", "残す本文")]),
      selectedId: "p_1",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_replace_block", {
      targetId: "p_1",
      block: { type: "paragraph", id: "p_1", children: [{ type: "text", text: "更新後の本文" }] },
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[0]).toMatchObject({
      type: "paragraph",
      id: "p_1",
      children: [{ type: "text", text: "更新後の本文" }],
    });
    expect(session.draftDocument.content[1]).toEqual(session.baseDocument.content[1]);
    expect(session.operations).toHaveLength(1);
    expect(session.operations[0]).toMatchObject({ targetId: "p_1" });
  });

  it("draft_replace_block rejects a block-type change and an unknown target", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_1", "本文")]),
      selectedId: "p_1",
    });

    const typeChangeResult = executeSigmaDocAgentDraftTool(session, "draft_replace_block", {
      targetId: "p_1",
      block: { type: "heading", id: "p_1", level: 2, children: [{ type: "text", text: "見出し化" }] },
    });
    expect(typeChangeResult.ok).toBe(false);

    const missingTargetResult = executeSigmaDocAgentDraftTool(session, "draft_replace_block", {
      targetId: "p_missing",
      block: { type: "paragraph", id: "p_missing", children: [{ type: "text", text: "本文" }] },
    });
    expect(missingTargetResult.ok).toBe(false);
  });

  it("accepts problem solution arrays longer than eight blocks", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const longSolution = Array.from({ length: 12 }, (_, index) => ({
      id: `solution_long_${index + 1}`,
      text: `解説 ${index + 1}`,
    }));

    const createResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "p_1",
      id: "problem_long_solution",
      prompt: { id: "prompt_long_solution", text: "長い解説を持つ問題" },
    });
    expect(createResult.ok).toBe(true);

    const updateResult = executeSigmaDocAgentDraftTool(session, "draft_update_problem_content", {
      targetId: "problem_long_solution",
      solution: longSolution,
    });
    expect(updateResult.ok).toBe(true);

    const problem = session.draftDocument.content[1];
    const solution = problem.type === "problem" ? problem.solution : [];
    expect(solution).toHaveLength(longSolution.length);
    expect(solution[11]).toMatchObject({
      id: "solution_long_12",
      children: [{ text: "解説 12" }],
    });
  });

  it("draft_update_problem_content can clear optional problem areas and the answer", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "p_1",
      id: "problem_clearable",
      lead: { id: "lead_clearable", text: "導入" },
      prompt: { id: "prompt_clearable", text: "問題文" },
      answerText: "答え",
      solution: { id: "solution_clearable", text: "解説" },
      hints: { id: "hint_clearable", text: "ヒント" },
    }).ok).toBe(true);

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_problem_content", {
      targetId: "problem_clearable",
      lead: [],
      answer: null,
      solution: [],
      hints: [],
    });
    expect(result.ok).toBe(true);
    const problem = session.draftDocument.content.find((block) => block.id === "problem_clearable");
    expect(problem).toMatchObject({ type: "problem", lead: [], solution: [], hints: [] });
    expect(problem).not.toHaveProperty("answer");
  });

  it("accepts body content arrays longer than five blocks", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const blocks = Array.from({ length: 7 }, (_, index) => ({
      id: `body_long_${index + 1}`,
      text: `本文 ${index + 1}`,
    }));

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks,
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content).toHaveLength(1 + blocks.length);
    expect(session.draftDocument.content.at(-1)).toMatchObject({
      id: "body_long_7",
      children: [{ text: "本文 7" }],
    });
  });

  it("re-assigns colliding IDs in AI-friendly body and problem content", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const bodyResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks: [{
        id: "p_1",
        runs: [{ type: "math", id: "p_1", tex: "x^2" }],
      }],
    });
    expect(bodyResult.ok).toBe(true);

    const body = session.draftDocument.content[1];
    expect(body).toMatchObject({ type: "paragraph" });
    expect(body?.id).not.toBe("p_1");
    if (body?.type === "paragraph") {
      const math = body.children.find((child) => child.type === "mathInline");
      expect(math?.id).not.toBe("p_1");
      expect(math?.id).not.toBe(body.id);
    }

    const problemResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: body?.id,
      id: "p_1",
      prompt: { id: "p_1", text: "同じIDをAIが再利用しても挿入する。" },
    });
    expect(problemResult.ok).toBe(true);

    const problem = session.draftDocument.content[2];
    expect(problem).toMatchObject({ type: "problem" });
    expect(problem?.id).not.toBe("p_1");
    expect(problem?.type === "problem" ? problem.prompt[0]?.id : null).not.toBe("p_1");
  });

  it("supports replacing and creating problem lead with multiple canonical blocks", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const createResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "p_1",
      id: "problem_single_lead",
      title: "古いtitle入力",
      lead: { id: "lead_single", text: "確認問題" },
      prompt: [
        { id: "prompt_single", text: "方程式を解け。" },
        { id: "prompt_existing_tail", text: "末尾の補足。" },
      ],
    });
    expect(createResult.ok).toBe(true);

    const problem = session.draftDocument.content[1];
    expect(problem).toMatchObject({
      type: "problem",
      lead: [{ id: "lead_single", type: "paragraph", children: [{ text: "確認問題" }] }],
    });
    expect(problem.type === "problem" ? problem.lead : []).toHaveLength(1);

    const replaceLeadResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "problem_single_lead",
      area: "lead",
      blocks: [{ id: "lead_replaced", text: "更新した導入文" }],
    });
    expect(replaceLeadResult.ok).toBe(true);
    const replacedProblem = session.draftDocument.content[1];
    expect(replacedProblem).toMatchObject({
      type: "problem",
      lead: [
        { id: "lead_single", children: [{ text: "確認問題" }] },
        { id: "lead_replaced", children: [{ text: "更新した導入文" }] },
      ],
    });
    expect(replacedProblem.type === "problem" ? replacedProblem.lead : []).toHaveLength(2);

    const insertPromptResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "prompt_single",
      area: "prompt",
      blocks: [{ id: "prompt_inserted_near_target", text: "指定した問題文の直後" }],
    });
    expect(insertPromptResult.ok).toBe(true);
    const promptUpdatedProblem = session.draftDocument.content[1];
    expect(promptUpdatedProblem.type === "problem" ? promptUpdatedProblem.prompt.map((block) => block.id) : []).toEqual([
      "prompt_single",
      "prompt_inserted_near_target",
      "prompt_existing_tail",
    ]);
    expect(session.operations.at(-1)).toMatchObject({
      operation: "insertAfter",
      targetId: "prompt_single",
      insertedBlock: { id: "prompt_inserted_near_target" },
    });

    const multiLeadInsertResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "problem_single_lead",
      area: "lead",
      blocks: [
        { id: "lead_insert_many_1", text: "導入1" },
        { id: "lead_insert_many_2", text: "導入2" },
      ],
    });
    expect(multiLeadInsertResult.ok).toBe(true);
    const multiLeadProblem = session.draftDocument.content[1];
    expect(multiLeadProblem.type === "problem" ? multiLeadProblem.lead.map((block) => block.id) : [])
      .toEqual(["lead_single", "lead_replaced", "lead_insert_many_1", "lead_insert_many_2"]);

    const multiLeadCreateResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "problem_single_lead",
      id: "problem_too_many_leads",
      lead: [
        { id: "lead_many_1", text: "導入1" },
        { id: "lead_many_2", text: "導入2" },
      ],
      prompt: { id: "prompt_many", text: "問題文" },
    });
    expect(multiLeadCreateResult.ok).toBe(true);
    const createdProblem = session.draftDocument.content.find((block) => block.id === "problem_too_many_leads");
    expect(createdProblem?.type === "problem" ? createdProblem.lead.map((block) => block.id) : [])
      .toEqual(["lead_many_1", "lead_many_2"]);
  });

  it("keeps additions to an existing problem area as additive insertAfter operations", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([{
        type: "problem",
        id: "problem_solution_insert",
        tags: [],
        lead: [],
        prompt: [paragraph("prompt_solution_insert", "問題文")],
        solution: [
          paragraph("solution_first", "最初の解答"),
          paragraph("solution_tail", "後続の解答"),
        ],
        hints: [],
      }]),
      selectedId: "solution_first",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "solution_first",
      area: "solution",
      blocks: [
        { id: "solution_reason_1", text: "理由1" },
        { id: "solution_reason_2", text: "理由2" },
      ],
    });

    expect(result.ok).toBe(true);
    const problem = session.draftDocument.content[0];
    expect(problem.type === "problem" ? problem.solution.map((block) => block.id) : []).toEqual([
      "solution_first",
      "solution_reason_1",
      "solution_reason_2",
      "solution_tail",
    ]);
    expect(session.operations).toMatchObject([
      { operation: "insertAfter", targetId: "solution_first", insertedBlock: { id: "solution_reason_1" } },
      { operation: "insertAfter", targetId: "solution_reason_1", insertedBlock: { id: "solution_reason_2" } },
    ]);
  });

  it("converts LaTeX delimiters in AI-friendly text into inline math nodes", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks: [
        {
          id: "ai_math_formula",
          text: "\\(x^2+1\\) を展開せずに扱う。必要なら \\(a+b\\) と \\(a-b\\) を別々に確認する。",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[1]).toMatchObject({
      type: "paragraph",
      id: "ai_math_formula",
      children: [
        { type: "mathInline", tex: "x^2+1" },
        { type: "text", text: " を展開せずに扱う。必要なら " },
        { type: "mathInline", tex: "a+b" },
        { type: "text", text: " と " },
        { type: "mathInline", tex: "a-b" },
        { type: "text", text: " を別々に確認する。" },
      ],
    });
  });

  it("uses the document end as the insertion target when nothing is selected", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "最初の本文" }],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "末尾の本文" }],
      },
    ]);
    const session = createSigmaDocAgentSession({ document, selectedId: null });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      blocks: [{ id: "ai_unselected_note", text: "選択なしで末尾に追加する本文" }],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content.map((block) => block.id)).toEqual([
      "p_1",
      "p_2",
      "ai_unselected_note",
    ]);
    expect(session.operations[0]).toMatchObject({
      operation: "insertAfter",
      targetId: "p_2",
    });
  });

  it("treats strict-schema null placeholders as omitted top-level tool args", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const bodyResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: null,
      area: null,
      blocks: [{ id: "ai_null_placeholder_note", text: "nullは未指定として扱う。" }],
    });

    expect(bodyResult.ok).toBe(true);
    expect(session.operations[0]).toMatchObject({
      operation: "insertAfter",
      targetId: "p_1",
      insertedBlock: { id: "ai_null_placeholder_note" },
    });

    const shapeResult = executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: null,
      shape: {
        id: "image_null_asset_shape",
        type: "image",
        x: 0,
        y: 44,
        rotation: 0,
        props: { assetId: "asset_null_mime", w: 120, h: 80 },
      },
      assets: {
        asset_null_mime: {
          id: "asset_null_mime",
          type: "image",
          props: {
            w: 120,
            h: 80,
            name: "asset.png",
            isAnimated: false,
            mimeType: null,
            src: "data:image/png;base64,AAAA",
            fileSize: 4,
          },
        },
      },
    });

    expect(shapeResult.ok).toBe(true);
    const asset = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.assets.asset_null_mime;
    expect(asset?.props.mimeType).toBeNull();
  });

  it("anchors overlay drafts to the document end when nothing is selected", () => {
    const document = createDocument([
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "最初の本文" }],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: "末尾の本文" }],
      },
    ]);
    const session = createSigmaDocAgentSession({ document, selectedId: null });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      id: "table_ai_unselected",
      kind: "variation",
    });

    expect(result.ok).toBe(true);
    const shape = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
    expect(shape).toMatchObject({
      id: "table_ai_unselected",
      anchor: { type: "block", blockId: "p_2" },
    });
    expect(session.operations[0]).toMatchObject({
      operation: "insertTableShape",
      targetId: "p_2",
    });
  });

  it("rejects variation tables inserted as body array formulas", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const before = session.draftDocument;

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks: [{
        id: "ai_bad_variation_table",
        tex: String.raw`\begin{array}{c|ccc}x&-\infty&0&\infty\\f'(x)&+&0&-\\f(x)&\nearrow&&\searrow\end{array}`,
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("draft_insert_table");
    expect(session.draftDocument).toBe(before);
    expect(session.operations).toHaveLength(0);
  });

  it("inserts shape, table, graph, and attached image overlay drafts", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      attachments: [{
        id: "media_1",
        name: "figure.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        width: 800,
        height: 400,
        fileSize: 123,
      }],
    });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: rectangleShape("shape_ai"),
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_table_shape", {
      targetId: "p_1",
      shape: tableShape("table_ai"),
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_graph_shape", {
      targetId: "p_1",
      spec: {
        kind: "cartesian",
        title: "二次関数",
        width: 560,
        height: 320,
        viewBox: { xMin: "-1", xMax: "5", yMin: "-2", yMax: "8" },
        axes: { grid: true, showX: true, showY: true, showTicks: true },
        curves: [{ id: "curve_ai", expr: "x^2 - 5*x + 6", color: "#2563eb" }],
      },
      id: "graph_ai",
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_attach_image_asset", {
      targetId: "p_1",
      id: "image_ai",
      attachmentId: "media_1",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    expect(snapshot?.shapes.map((shape) => shape.id)).toEqual(["shape_ai", "table_ai", "graph_ai", "image_ai"]);
    expect(Object.keys(snapshot?.assets ?? {})).toHaveLength(1);
    expect(session.operations).toHaveLength(4);
  });

  it("inserts absolute shapes, tables, and graphs on a whiteboard CANVAS without anchors", () => {
    const session = createSigmaDocAgentSession({
      document: createWhiteboardDocument(),
      selectedId: null,
    });

    const shapeResult = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "CANVAS",
      id: "whiteboard_shape",
      kind: "rectangle",
      start: { x: 120, y: 80 },
      end: { x: 280, y: 180 },
    });
    const tableResult = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "CANVAS",
      id: "whiteboard_table",
      x: 360,
      y: 220,
      cells: Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => "")),
    });
    const graphResult = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "CANVAS",
      id: "whiteboard_graph",
      x: 720,
      y: 440,
      axes: { showX: true, showY: true },
      curves: [{ id: "whiteboard_curve", expr: "x^2" }],
    });

    expect(shapeResult.ok).toBe(true);
    expect(tableResult.ok).toBe(true);
    expect(graphResult.ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes.find((shape) => shape.id === "whiteboard_shape")).toMatchObject({
      x: 120,
      y: 80,
    });
    expect(shapes.find((shape) => shape.id === "whiteboard_shape")).not.toHaveProperty("anchor");
    expect(shapes.find((shape) => shape.id === "whiteboard_table")).toMatchObject({
      x: 360,
      y: 220,
    });
    const whiteboardTable = shapes.find((shape): shape is OverlayTableShape => shape.id === "whiteboard_table" && shape.type === "tableShape");
    expect(whiteboardTable?.props.table.rows).toHaveLength(4);
    expect(whiteboardTable?.props.table.columns).toHaveLength(5);
    expect(shapes.find((shape) => shape.id === "whiteboard_table")).not.toHaveProperty("anchor");
    expect(shapes.find((shape) => shape.id === "whiteboard_graph")).toMatchObject({
      x: 720,
      y: 440,
    });
    expect(shapes.find((shape) => shape.id === "whiteboard_graph")).not.toHaveProperty("anchor");
    expect(session.operations.map((operation) => operation.targetId)).toEqual([
      "CANVAS",
      "CANVAS",
      "CANVAS",
      "CANVAS",
      "CANVAS",
    ]);
  });

  it("rejects body and problem insertion in whiteboard mode", () => {
    const session = createSigmaDocAgentSession({
      document: createWhiteboardDocument(),
      selectedId: null,
    });
    const expectedMessage =
      "この教材は無限キャンバス(ホワイトボード)モードのため本文は挿入できません。\n" +
      "insert_shape/insert_table/insert_graphで図形として表現してください。";

    const bodyResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "CANVAS",
      blocks: ["本文"],
    });
    const problemResult = executeSigmaDocAgentDraftTool(session, "draft_create_problem_content", {
      targetId: "CANVAS",
      prompt: "問題文",
    });

    expect(bodyResult).toMatchObject({ ok: false, message: expectedMessage });
    expect(problemResult).toMatchObject({ ok: false, message: expectedMessage });
    expect(session.draftDocument.content).toEqual([]);
    expect(session.operations).toEqual([]);
  });

  it("requires the explicit CANVAS target for whiteboard overlay insertion", () => {
    const session = createSigmaDocAgentSession({
      document: createWhiteboardDocument(),
      selectedId: null,
    });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      id: "missing_canvas_target",
      kind: "rectangle",
      start: { x: 10, y: 20 },
      end: { x: 110, y: 80 },
    })).toMatchObject({
      ok: false,
      message: expect.stringContaining('targetId: "CANVAS"'),
    });
    expect(session.operations).toEqual([]);
  });

  it("re-assigns a unique id when an overlay shape id collides with an existing shape", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: rectangleShape("dup_shape"),
    }).ok).toBe(true);

    // 同じIDで再挿入しても「AI図形IDが既存のオーバーレイ図形と重複しています。」で失敗せず、
    // 新しい一意IDが採番されること。
    const second = executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: rectangleShape("dup_shape"),
    });
    expect(second.ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes).toHaveLength(2);
    const ids = shapes.map((shape) => shape.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("dup_shape");
    expect(ids[1]).not.toBe("dup_shape");
  });

  it("re-assigns a unique id when a table shape id collides with an existing block", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    // 既存本文ブロックID "p_1" と重複する図形IDでも失敗しない。
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table_shape", {
      targetId: "p_1",
      shape: tableShape("p_1"),
    });
    expect(result.ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.id).not.toBe("p_1");
  });

  it("re-assigns colliding high-level overlay IDs while preserving internal references", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      attachments: [{
        id: "media_1",
        name: "figure.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        width: 800,
        height: 400,
        fileSize: 123,
      }],
    });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "p_1",
      cells: [["表"]],
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "p_1",
      axes: { xLabel: "x" },
      curves: [{ id: "curve_collision", expr: "x" }],
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_attach_image_asset", {
      targetId: "p_1",
      id: "p_1",
      assetId: "p_1",
      attachmentId: "media_1",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const ids = [
      ...(snapshot?.shapes.map((shape) => shape.id) ?? []),
      ...Object.keys(snapshot?.assets ?? {}),
    ];
    expect(ids).not.toContain("p_1");
    expect(new Set(ids).size).toBe(ids.length);

    const graph = snapshot?.shapes.find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    const xLabelId = graph?.props.axisLabelTextShapeIds?.x;
    const xLabel = snapshot?.shapes.find((shape): shape is OverlayTextShape => shape.type === "text" && shape.id === xLabelId);
    expect(xLabel?.anchor).toEqual(expect.objectContaining({ type: "shape", shapeId: graph?.id }));
  });

  it("anchors overlay drafts to requested problem areas", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([{
        type: "problem",
        id: "problem_area",
        tags: [],
        lead: [],
        prompt: [paragraph("prompt_area", "図を見て答えよ。")],
        solution: [],
        hints: [],
      }]),
      selectedId: "problem_area",
    });

    const tableResult = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "problem_area",
      area: "solution",
      id: "table_solution_area",
      cells: [["解答用の表"]],
    });

    expect(tableResult.ok).toBe(true);
    const problemAfterTable = session.draftDocument.content[0];
    expect(problemAfterTable.type === "problem" ? problemAfterTable.solution : null).toEqual([]);
    expect(session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0]).toMatchObject({
      id: "table_solution_area",
      anchor: { type: "block", blockId: "problem_area" },
    });
    expect(session.operations[0]).toMatchObject({
      operation: "insertTableShape",
      targetId: "problem_area",
    });
    expect(session.operations).toHaveLength(1);

    const graphResult = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "problem_area",
      area: "prompt",
      id: "graph_prompt_area",
      title: "一次関数",
      width: 320,
      height: 180,
      viewBox: { xMin: "-1", xMax: "4", yMin: "-1", yMax: "4" },
      axes: { grid: false, showX: true, showY: true },
      curves: [{ id: "curve_prompt_area", expr: "x", color: "#2563eb" }],
    });

    expect(graphResult.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape" && shape.id === "graph_prompt_area");
    expect(graph?.anchor).toMatchObject({ type: "block", blockId: "prompt_area" });
  });

  it("inserts ordinary shapes from high-level AI tool arguments", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_ai_triangle",
      kind: "triangle",
      start: { x: 10, y: 20 },
      end: { x: 130, y: 110 },
      label: "ABC",
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_ai_arrow",
      kind: "arrow",
      start: { x: 30, y: 140 },
      end: { x: 180, y: 140 },
      label: "移動",
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_ai_arc",
      kind: "arc",
      points: [
        { x: 40, y: 210 },
        { x: 90, y: 170 },
        { x: 150, y: 210 },
      ],
      arrowheadStart: "dot",
      arrowheadEnd: "arrow",
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_ai_label",
      kind: "text",
      x: 200,
      y: 20,
      tex: "x^2+1",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const triangle = snapshot?.shapes.find((shape): shape is OverlayGeoShape => shape.type === "geo" && shape.id === "shape_ai_triangle");
    const arrow = snapshot?.shapes.find((shape): shape is OverlayArrowShape => shape.type === "arrow" && shape.id === "shape_ai_arrow");
    const arc = snapshot?.shapes.find((shape) => shape.type === "arc" && shape.id === "shape_ai_arc");
    const label = snapshot?.shapes.find((shape): shape is OverlayTextShape => shape.type === "text" && shape.id === "shape_ai_label");

    expect(snapshot?.shapes.some((shape) => shape.type === "graph2dShape")).toBe(false);
    expect(triangle).toMatchObject({
      anchor: { type: "block", blockId: "p_1" },
      props: {
        geo: "triangle",
        w: 120,
        h: 90,
        label: "ABC",
        apexX: 60,
      },
    });
    expect(arrow).toMatchObject({
      anchor: { type: "block", blockId: "p_1" },
      props: {
        end: { x: 150, y: 0 },
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        label: "移動",
      },
    });
    expect(arc).toMatchObject({
      anchor: { type: "block", blockId: "p_1" },
      props: {
        arrowheadStart: "dot",
        arrowheadEnd: "arrow",
      },
    });
    expect(getTextShapeMathTex(label)).toBe("x^2+1");
    expect(session.operations).toHaveLength(4);
  });

  it.each(OVERLAY_ARROWHEADS)("accepts %s as an endpoint decoration", (head) => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: `shape_ai_head_${head}`,
      kind: "arrow",
      start: { x: 0, y: 0 },
      end: { x: 120, y: 0 },
      arrowheadStart: head,
      arrowheadEnd: head,
    }).ok).toBe(true);
    expect(session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0]).toMatchObject({
      props: { arrowheadStart: head, arrowheadEnd: head },
    });
  });

  it("rejects an endpoint decoration the schema does not define", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_ai_head_unknown",
      kind: "arrow",
      start: { x: 0, y: 0 },
      end: { x: 120, y: 0 },
      arrowheadEnd: "spiral",
    }).ok).toBe(false);
  });

  /**
   * The shapes these tools build are persisted as-is, so they have to satisfy the same validator
   * the file format does. A tool that produced a shape the schema rejects would fail at save time,
   * long after the AI turn that made it.
   */
  /**
   * The height a tool stores is a floor, not a layout: the lines the content already carries, so
   * the box is never shorter than its own line breaks while it waits to be measured. A list is the
   * case that used to be counted wrong — a list item's line, the blocks continuing it and the
   * sub-lists under it are all lines, and treating the whole list as one leaves the box a third of
   * the height it needs.
   */
  it("counts every line of a list when it derives a text box height", () => {
    const line = (id: string, text: string) => ({
      type: "listItem" as const,
      id,
      children: [{ type: "text" as const, text }],
    });
    const blocks = [{
      type: "list" as const,
      id: "list_1",
      listType: "bullet" as const,
      items: [
        { ...line("li_1", "一つ目"), continuations: [{ type: "paragraph" as const, id: "li_1_c", children: [{ type: "text" as const, text: "続き" }] }] },
        { ...line("li_2", "二つ目"), nested: [{ type: "list" as const, id: "list_2", listType: "bullet" as const, items: [line("li_3", "入れ子")] }] },
      ],
    }];

    // Four lines: two items, one continuation, one nested item — at the 16px line box of size "m".
    expect(getShapeToolTextBox(blocks, "m")).toEqual({ w: DEFAULT_TEXT_SHAPE_WIDTH, h: 64 });
  });

  it("converts text-shape Markdown into heading, paragraph math, and list blocks", () => {
    const blocks = createShapeToolMarkdownBlocks("## 見出し\n\n式 $x^2$ を考える。\n\n- 一つ\n- 二つ");

    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    const paragraph = blocks[1];
    expect(paragraph?.type === "paragraph" ? paragraph.children : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mathInline", tex: "x^2" }),
    ]));
    expect(blocks[2]).toMatchObject({
      type: "list",
      items: [{ children: [{ type: "text", text: "一つ" }] }, { children: [{ type: "text", text: "二つ" }] }],
    });
    expect(() => createShapeToolMarkdownBlocks("")).toThrow();
  });

  it("builds text and callout shapes the overlay validator accepts", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_valid_text",
      kind: "text",
      text: "本文",
      tex: undefined,
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_valid_callout",
      kind: "callout",
      text: "注意",
    }).ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const built = shapes.filter((shape) => shape.id === "shape_valid_text" || shape.id === "shape_valid_callout");

    expect(built).toHaveLength(2);
    for (const shape of built) {
      expect(isOverlayShape(shape)).toBe(true);
    }
  });

  it("gives an inserted text shape the default width when the AI names none", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_auto_text",
      kind: "text",
      x: 20,
      y: 30,
      text: "あいうえおかきくけこ",
    }).ok).toBe(true);
    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const autoText = snapshot?.shapes.find((shape): shape is OverlayTextShape => shape.type === "text" && shape.id === "shape_auto_text");

    // The same default every other creation path takes — a text box's width is chosen, and a tool
    // that chose nothing gets the choice everyone else gets.
    expect(autoText?.props.w).toBe(DEFAULT_TEXT_SHAPE_WIDTH);
    // One line of content, so one line of height. The editor writes the measured height back the
    // first time it draws the shape; this is only the floor it cannot be shorter than.
    expect(autoText?.props.h).toBe(16);
  });

  it("uses radius arguments as the rendered size for circles and ellipses", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_radius_circle",
      kind: "circle",
      x: 24,
      y: 36,
      r: 42,
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_radius_ellipse",
      kind: "ellipse",
      x: 147.4,
      y: 600.1,
      rx: 111,
      ry: 48,
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_radius_ellipse_rx_only",
      kind: "ellipse",
      rx: 40,
      label: "あいうえおかきくけこさしすせそたちつてと",
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_radius_ellipse_ry_only",
      kind: "ellipse",
      ry: 30,
      label: "あいうえおかきくけこさしすせそたちつてと",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const circle = snapshot?.shapes.find((shape): shape is OverlayGeoShape => shape.type === "geo" && shape.id === "shape_radius_circle");
    const ellipse = snapshot?.shapes.find((shape): shape is OverlayGeoShape => shape.type === "geo" && shape.id === "shape_radius_ellipse");
    const ellipseRxOnly = snapshot?.shapes.find((shape): shape is OverlayGeoShape => shape.type === "geo" && shape.id === "shape_radius_ellipse_rx_only");
    const ellipseRyOnly = snapshot?.shapes.find((shape): shape is OverlayGeoShape => shape.type === "geo" && shape.id === "shape_radius_ellipse_ry_only");

    expect(circle).toMatchObject({
      x: 24,
      y: 36,
      props: { geo: "ellipse", w: 84, h: 84 },
    });
    expect(ellipse).toMatchObject({
      x: 147.4,
      y: 600.1,
      props: { geo: "ellipse", w: 222, h: 96 },
    });
    expect(ellipseRxOnly?.props).toMatchObject({ w: 80, h: 96 });
    expect(ellipseRyOnly?.props).toMatchObject({ w: 352, h: 60 });
  });

  it("takes the width the AI asked for and derives the height from the content", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_fixed_text",
      kind: "text",
      text: "一行目\n二行目",
      w: 120,
    }).ok).toBe(true);
    const fixedText = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayTextShape => shape.type === "text" && shape.id === "shape_fixed_text");

    expect(fixedText?.props).toMatchObject({ w: 120, h: 32 });
  });

  /**
   * A text shape's height is its content's, and the editor overwrites the stored value with the
   * measured one the first time it draws the shape. A tool that asked for a height would be asking
   * for something that cannot be honoured, so it is refused rather than accepted and dropped.
   */
  it("refuses a height on an inserted text shape", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_height_text",
      kind: "text",
      text: "固定サイズ",
      w: 120,
      h: 48,
    });

    expect(result.ok).toBe(false);
    expect(session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
      .not.toContainEqual(expect.objectContaining({ id: "shape_height_text" }));
  });

  it("refuses the removed auto-wrapping argument outright", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_wrapped_text",
      kind: "text",
      text: "あいうえおかきくけこ",
      maxWidth: 64,
    }).ok).toBe(false);
  });

  it("expands labeled ordinary shapes when AI omits width and height", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_auto_label",
      kind: "rectangle",
      x: 20,
      y: 30,
      label: "あいうえおかきくけこさしすせそたちつてと",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const shape = snapshot?.shapes.find((item): item is OverlayGeoShape => item.type === "geo" && item.id === "shape_auto_label");

    expect(shape?.props.w).toBe(352);
    expect(shape?.props.h).toBe(96);
    expect(shape?.props.label).toBe("あいうえおかきくけこさしすせそたちつてと");
  });

  it("rejects text-only sizing arguments for non-text shape insertion", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_old_size_args",
      kind: "rectangle",
      w: 120,
      h: 80,
      label: "旧サイズ指定",
    });

    expect(result.ok).toBe(false);
    expect(session.operations).toHaveLength(0);
  });

  it("inserts an empty callout as one rich-text-capable shape", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_simple",
      kind: "callout",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_simple");

    expect(callout).toMatchObject({
      type: "callout",
      anchor: { type: "block", blockId: "p_1" },
      props: {
        w: 180,
        h: 68,
        radius: 18,
        color: "black",
        size: "m",
      },
    });
    expect(callout?.props.tail.baseStart.x).toBeCloseTo(39.6);
    expect(callout?.props.tail.baseStart.y).toBe(68);
    expect(callout?.props.tail.baseEnd.x).toBeCloseTo(75.6);
    expect(callout?.props.tail.baseEnd.y).toBe(68);
    expect(callout?.props.tail.tip.x).toBeCloseTo(25.2);
    expect(callout?.props.tail.tip.y).toBe(96);
    expect(callout?.props.blocks[0]?.type).toBe("paragraph");
    expect(snapshot?.shapes).toHaveLength(1);
    expect(session.operations).toHaveLength(1);
  });

  it("inserts callout with text and auto-sizes based on text", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_with_text",
      kind: "callout",
      text: "短い文字",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_with_text");

    expect(callout).toBeDefined();
    expect(callout?.props.w).toBeGreaterThan(40); // Minimum plus padding
    expect(callout?.props.h).toBeGreaterThan(30);
    expect(JSON.stringify(callout?.props.blocks)).toContain("短い文字");
    expect(callout?.parentId).toBeUndefined();
    expect(snapshot?.shapes).toHaveLength(1);
    expect(session.operations).toHaveLength(1);
  });

  it("inserts callout with long text and groups them properly", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_long_text",
      kind: "callout",
      text: "これは非常に長いテキストです。複数行に渡って、吹き出しの枠内に収まる必要があります。このテキストは充分に長いので、検証するのに適しています。",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_long_text");

    expect(callout).toBeDefined();
    expect(callout?.props.w).toBeGreaterThan(120);
    expect(JSON.stringify(callout?.props.blocks)).toContain("これは非常に長いテキストです");
    expect((snapshot?.shapes ?? []).filter((shape) => shape.type === "text")).toHaveLength(0);
    expect(session.operations).toHaveLength(1);
  });

  it("respects explicit w/h for callout with text", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_fixed_size",
      kind: "callout",
      text: "固定サイズ",
      w: 200,
      h: 100,
      cornerRadius: 26,
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_fixed_size");

    expect(callout?.props.w).toBe(200);
    expect(callout?.props.h).toBe(100);
    expect(callout?.props.radius).toBe(26);
    expect(JSON.stringify(callout?.props.blocks)).toContain("固定サイズ");
    expect(session.operations).toHaveLength(1);
  });

  it("allows w/h for callout (not just text)", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    // Callout without text should allow w/h
    const result1 = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_with_wh",
      kind: "callout",
      w: 150,
      h: 80,
    });

    expect(result1.ok).toBe(true);
    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_with_wh");
    expect(callout?.props.w).toBe(150);
    expect(callout?.props.h).toBe(80);
  });

  it("rejects the removed wrap-width argument on a callout too", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_bad_maxwidth",
      kind: "callout",
      text: "テキスト",
      maxWidth: 100,
    });

    expect(result.ok).toBe(false);
    expect(session.operations).toHaveLength(0);
  });

  it("keeps the block anchor on the single callout object", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "callout_anchor_test",
      kind: "callout",
      text: "テスト",
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const callout = snapshot?.shapes.find((shape): shape is OverlayCalloutShape => shape.type === "callout" && shape.id === "callout_anchor_test");

    expect(callout).toBeDefined();
    expect(callout?.anchor).toMatchObject({ type: "block", blockId: "p_1" });
    expect(JSON.stringify(callout?.props.blocks)).toContain("テスト");
    expect(snapshot?.shapes).toHaveLength(1);
  });


  it("inserts table and graph from high-level AI tool arguments", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_ai_high",
      kind: "variation",
      cells: [
        ["x", "", "0", ""],
        ["f'(x)", "+", "0", "-"],
        ["f(x)", { type: "trend", direction: "up" }, "", { type: "trend", direction: "down" }],
      ],
    }).ok).toBe(true);

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_high",
      title: "放物線",
      width: 560,
      height: 320,
      viewBox: { xMin: "-3", xMax: "3", yMin: "-1", yMax: "5" },
      axes: { grid: true, showX: true, showY: true, showTicks: true, xLabel: "s", yLabel: "t" },
      curves: [{ id: "curve_ai_high", expr: "x^2", label: "y=x^2" }],
      points: [{ id: "point_origin", x: "0", y: "0", label: "O" }],
      showFormulaLabels: true,
    }).ok).toBe(true);

    const snapshot = session.draftDocument.pageLayout?.overlay?.overlaySnapshot;
    const table = snapshot?.shapes.find((shape): shape is OverlayTableShape => shape.type === "tableShape");
    const graph = snapshot?.shapes.find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    const textShapesById = new Map((snapshot?.shapes ?? [])
      .filter((shape): shape is OverlayTextShape => shape.type === "text")
      .map((shape) => [shape.id, shape]));

    expect(table?.props.table.kind).toBe("variation");
    expect(table?.props.table.cells.some((cell) => cell.content.some((content) => content.type === "trend"))).toBe(false);
    expect(table ? tableCellTexValues(table.props.table) : []).toEqual(expect.arrayContaining(["\\nearrow", "\\searrow"]));
    expect(graph?.props.boundsMode).toBe("plot");
    expect(graph?.props.w).toBe(496);
    expect(graph?.props.spec.width).toBe(560);
    expect(graph?.props.spec.axes.xLabel).toBe("");
    expect(graph?.props.spec.axes.yLabel).toBe("");
    expect(graph?.props.axisLabelTextShapeIds?.x).toBeDefined();
    expect(graph?.props.axisLabelTextShapeIds?.y).toBeDefined();
    expect(getTextShapeMathTex(textShapesById.get(graph?.props.axisLabelTextShapeIds?.x ?? ""))).toBe("s");
    expect(getTextShapeMathTex(textShapesById.get(graph?.props.axisLabelTextShapeIds?.y ?? ""))).toBe("t");
    expect(getTextShapeMathTex(textShapesById.get(graph?.props.pointLabelTextShapeIdsByPointId?.point_origin ?? ""))).toBe("O");
    expect(getTextShapeMathTex(textShapesById.get(graph?.props.labelTextShapeIdsByCurveId?.curve_ai_high ?? ""))).toBe("y=x^2");
    expect(textShapesById.get(graph?.props.axisLabelTextShapeIds?.x ?? "")?.anchor).toEqual(
      expect.objectContaining({ type: "shape", shapeId: graph?.id }),
    );
    expect(graph?.props.spec.curves[0]).toMatchObject({
      id: "curve_ai_high",
      mode: "yOfX",
      dash: "solid",
      strokeWidth: 2.4,
    });
    expect(graph?.props.spec.showFormulaLabels).toBe(true);
  });

  it("keeps graph grid and ticks off by default for AI graph insertions", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_default_axes",
      curves: [{ id: "curve_ai_default_axes", expr: "x^2" }],
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    expect(graph?.props.spec.axes.grid).toBe(false);
    expect(graph?.props.spec.axes.showTicks).toBe(false);
  });

  it("keeps implicit graph curve mode for AI graph insertions", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_implicit",
      viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
      curves: [
        {
          id: "curve_ai_implicit",
          expr: "x^2 - 4*x + y^2 - 22",
          label: "x^2 - 4x + y^2 = 22",
          mode: "implicit",
        },
      ],
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    expect(graph?.props.spec.curves[0]).toMatchObject({
      id: "curve_ai_implicit",
      expr: "x^2 - 4*x + y^2 - 22",
      label: "x^2 - 4x + y^2 = 22",
      mode: "implicit",
    });
  });

  it("defaults AI-inserted graphs to a monochrome palette and dash-differentiated curves", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_monochrome",
      curves: [
        { id: "curve_ai_mono_main", expr: "x^2" },
        { id: "curve_ai_mono_second", expr: "x" },
      ],
      points: [
        { id: "point_ai_mono_default", x: "1", y: "1", label: "P" },
      ],
      // y=x^2 と y=x で 0<x<1 に囲まれる領域 (0.5, 0.4) が内部点。
      fills: [
        { id: "fill_ai_mono_default", x: "0.5", y: "0.4" },
      ],
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");

    // 主曲線は黒の実線のまま。
    expect(graph?.props.spec.curves[0]).toMatchObject({ color: "#0d0d0d", dash: "solid" });
    // 色を指定しなかった第2曲線は、白黒でも区別できるよう破線になり、色も赤/青/緑等に飛ばない。
    expect(graph?.props.spec.curves[1].dash).toBe("dashed");
    expect(graph?.props.spec.curves[1].color).not.toBe("#dc2626");
    expect(graph?.props.spec.curves[1].color).not.toBe("#2563eb");
    expect(graph?.props.spec.curves[1].color).not.toBe("#16a34a");
    expect(graph?.props.spec.curves[1].color).not.toBe("#9333ea");

    // 色未指定の点は黒、塗り領域は薄いグレーになる。
    expect(graph?.props.spec.points?.[0].color).toBe("#0d0d0d");
    expect(graph?.props.spec.fills?.[0].color).toBe("#d1d5db");
  });

  it("keeps an explicitly requested curve color and does not force it to dash", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_explicit_color",
      curves: [
        { id: "curve_ai_explicit_main", expr: "x^2" },
        { id: "curve_ai_explicit_second", expr: "x", color: "#2563eb" },
      ],
      points: [
        { id: "point_ai_explicit_color", x: "1", y: "1", label: "Q", color: "#dc2626" },
      ],
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");

    expect(graph?.props.spec.curves[1]).toMatchObject({ color: "#2563eb", dash: "solid" });
    expect(graph?.props.spec.points?.[0].color).toBe("#dc2626");
  });

  it("normalizes points[].labelPlacement to one of the 8 compass directions", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_ai_label_placement",
      curves: [{ id: "curve_ai_label_placement", expr: "x^2" }],
      points: [
        { id: "point_ai_placement_explicit", x: "1", y: "1", label: "A", labelPlacement: "sw" },
        { id: "point_ai_placement_invalid", x: "2", y: "2", label: "B", labelPlacement: "north" },
        { id: "point_ai_placement_absent", x: "3", y: "3", label: "C" },
      ],
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    const points = graph?.props.spec.points ?? [];

    expect(points.find((point) => point.id === "point_ai_placement_explicit")?.labelPlacement).toBe("sw");
    expect(points.find((point) => point.id === "point_ai_placement_invalid")?.labelPlacement).toBeUndefined();
    expect(points.find((point) => point.id === "point_ai_placement_absent")?.labelPlacement).toBeUndefined();
  });

  it("creates a multi-critical-point variation table from the prompt example", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_ai_variation_complex",
      kind: "variation",
      cells: [
        ["x", "-\\infty", "", "-1", "", "2", "", "\\infty"],
        ["f'(x)", "", "+", "0", "-", "0", "+", ""],
        ["f(x)", "", { type: "trend", direction: "up" }, "3", { type: "trend", direction: "down" }, "-1", { type: "trend", direction: "up" }, ""],
      ],
    });

    expect(result.ok).toBe(true);
    const table = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayTableShape => shape.type === "tableShape" && shape.id === "table_ai_variation_complex")
      ?.props.table;
    expect(table?.kind).toBe("variation");
    expect(table?.columns).toHaveLength(8);
    expect(table?.cells.filter((cell) => cell.content.some((content) => content.type === "trend"))).toHaveLength(0);
    expect(table ? tableCellTexValues(table) : []).toEqual(expect.arrayContaining([
      "\\infty",
      "-1",
      "2",
      "+",
      "-",
      "0",
      "\\nearrow",
      "\\searrow",
    ]));
  });

  it("creates a variation table from semantic AI arguments", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_ai_variation_semantic",
      kind: "variation",
      criticalPoints: ["-1", "2"],
      derivativeSigns: ["f'(x)", "", "+", "0", "-", "0", "+", ""],
      trends: ["up", "down", "up"],
      criticalValues: ["3", "-1"],
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("増減表");
    const shape = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item): item is OverlayTableShape => item.type === "tableShape" && item.id === "table_ai_variation_semantic");
    const table = shape?.props.table;
    expect(table?.kind).toBe("variation");
    expect(shape?.props.w).toBeLessThanOrEqual(500);
    expect(table?.columns).toHaveLength(8);
    expect(table?.cells.filter((cell) => cell.content.some((content) => content.type === "trend"))).toHaveLength(0);
    expect(table ? tableCellTexValues(table) : []).toEqual(expect.arrayContaining([
      "-\\infty",
      "\\infty",
      "-1",
      "2",
      "+",
      "-",
      "0",
      "3",
      "\\nearrow",
      "\\searrow",
    ]));
  });

  it("creates a variation table template when only kind is specified", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_ai_variation_template",
      kind: "variation",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("増減表");
    const table = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item): item is OverlayTableShape => item.type === "tableShape" && item.id === "table_ai_variation_template")
      ?.props.table;

    expect(table?.kind).toBe("variation");
    expect(table?.rows).toHaveLength(3);
    expect(table?.columns.length).toBeGreaterThan(1);
    expect(table ? tableCellTexValues(table) : []).toEqual(expect.arrayContaining([
      "-\\infty",
      "\\infty",
      "\\rightarrow",
    ]));
  });

  it("normalizes variation table convexity cells into mathInline symbols", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_ai_variation_convexity",
      kind: "variation",
      cells: [
        ["x", "-\\infty", "", "0", "", "\\infty"],
        ["f''(x)", "", "-", "0", "+", ""],
        ["凹凸", "", { type: "convexity", convexity: "上に凸" }, "", "下に凸", ""],
      ],
    });

    expect(result.ok).toBe(true);
    const table = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item): item is OverlayTableShape => item.type === "tableShape" && item.id === "table_ai_variation_convexity")
      ?.props.table;

    expect(table?.cells.filter((cell) => cell.content.some((content) => content.type === "trend"))).toHaveLength(0);
    expect(table ? tableCellTexValues(table) : []).toEqual(expect.arrayContaining(["\\cap", "\\cup"]));
  });

  it("creates a sample-document-level range graph from Graph2DSpec", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "ai_complex_range_graph",
      w: COMPLEX_RANGE_GRAPH_SPEC.width,
      h: COMPLEX_RANGE_GRAPH_SPEC.height,
      spec: COMPLEX_RANGE_GRAPH_SPEC,
    });

    expect(result.ok).toBe(true);
    const graph = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape");
    expect(graph?.props.spec.curves).toHaveLength(8);
    expect(graph?.props.spec.fills).toHaveLength(4);
    expect(graph?.props.spec.annotations).toEqual([]);
    expect(graph?.props.spec.points?.every((point) => point.label === undefined)).toBe(true);
    expect(graph?.props.spec.curves.some((curve) => curve.mode === "xOfY")).toBe(true);
  });

  it("does not mutate draft when a tool fails validation", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const before = session.draftDocument;

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph_shape", {
      targetId: "missing",
      spec: {
        kind: "cartesian",
        title: "",
        width: 560,
        height: 320,
        viewBox: { xMin: "-5", xMax: "5", yMin: "-5", yMax: "5" },
        axes: { grid: false },
        curves: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(session.draftDocument).toBe(before);
    expect(session.operations).toHaveLength(0);
  });

  it("rejects non-SigmaDoc shorthand tool arguments", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const before = session.draftDocument;

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_text_block", {
      targetId: "p_1",
      text: "これはSigmaDoc RichBlockではない本文",
      kind: "paragraph",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("SigmaDoc形式に沿っていません");
    expect(session.draftDocument).toBe(before);
    expect(session.operations).toHaveLength(0);
  });

  it("includes body-content blocks in get_document_outline for AI addressing", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([
        paragraph("p_1", "本文パラグラフ"),
        {
          type: "problem",
          id: "problem_1",
          tags: [],
          lead: [],
          prompt: [paragraph("prompt_1", "問題文")],
          solution: [],
          hints: [],
        },
      ]),
      selectedId: "p_1",
    });

    const result = executeSigmaDocAgentReadTool(session, "get_document_outline", {});

    expect(result.ok).toBe(true);
    const outline = (result.data as { outline: Array<{ id: string; type: string; parentId?: string }> }).outline;
    expect(outline.find((entry) => entry.id === "p_1")).toMatchObject({ type: "paragraph" });
    expect(outline.find((entry) => entry.id === "prompt_1")).toMatchObject({ type: "paragraph", parentId: "problem_1" });
  });
});

describe("commitSigmaDocMutation", () => {
  it("applies deleteBlocks to the session draft document and tracks it separately from AiEditDraft operations", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_1", "keep"), paragraph("p_2", "drop")]),
      selectedId: "p_1",
    });

    const result = commitSigmaDocMutation(session, {
      operation: "deleteBlocks",
      summary: "不要な段落を削除しました。",
      blockIds: ["p_2"],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content.map((block) => block.id)).toEqual(["p_1"]);
    expect(session.mutationOperations).toHaveLength(1);
    expect(session.operations).toHaveLength(0);
    expect(session.changedIds).toEqual(["p_2"]);
  });

  it("applies updateOverlayShape/alignOverlayShapes/deleteOverlayShapes on shapes inserted earlier in the same session", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: rectangleShape("shape_a"),
    }).ok).toBe(true);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: { ...rectangleShape("shape_b"), x: 40 },
    }).ok).toBe(true);

    const updateResult = commitSigmaDocMutation(session, {
      operation: "updateOverlayShape",
      summary: "図形の色を更新しました。",
      shapeId: "shape_a",
      patch: { props: { color: "#ff0000" } },
    });
    expect(updateResult.ok).toBe(true);

    const alignResult = commitSigmaDocMutation(session, {
      operation: "alignOverlayShapes",
      summary: "左端で揃えました。",
      shapeIds: ["shape_a", "shape_b"],
      mode: "left",
    });
    expect(alignResult.ok).toBe(true);

    let shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes.find((shape) => shape.id === "shape_a")).toMatchObject({ props: { color: "#ff0000" } });
    expect(shapes.find((shape) => shape.id === "shape_b")?.x).toBe(
      shapes.find((shape) => shape.id === "shape_a")?.x,
    );

    const deleteResult = commitSigmaDocMutation(session, {
      operation: "deleteOverlayShapes",
      summary: "図形bを削除しました。",
      shapeIds: ["shape_b"],
    });
    expect(deleteResult.ok).toBe(true);

    shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes.map((shape) => shape.id)).toEqual(["shape_a"]);
    expect(session.mutationOperations.map((op) => op.operation)).toEqual([
      "updateOverlayShape",
      "alignOverlayShapes",
      "deleteOverlayShapes",
    ]);
  });

  it("reports a failed tool result and leaves the session untouched when a mutation op is invalid", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const before = session.draftDocument;

    const result = commitSigmaDocMutation(session, {
      operation: "deleteBlocks",
      summary: "存在しないブロックです。",
      blockIds: ["missing"],
    });

    expect(result.ok).toBe(false);
    expect(session.draftDocument).toBe(before);
    expect(session.mutationOperations).toHaveLength(0);
  });
});

describe("getSigmaDocAgentSessionDraft mutationOperations", () => {
  it("includes committed mutation ops in the returned draft so a proposal built from it can carry them", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p_1", "keep"), paragraph("p_2", "drop")]),
      selectedId: "p_1",
    });

    const result = commitSigmaDocMutation(session, {
      operation: "deleteBlocks",
      summary: "不要な段落を削除しました。",
      blockIds: ["p_2"],
    });
    expect(result.ok).toBe(true);

    const draft = getSigmaDocAgentSessionDraft(session, { summary: result.message, changedIds: result.changedIds });

    expect(draft.draft.operations).toHaveLength(0);
    expect(draft.draft.mutationOperations).toHaveLength(1);
    expect(draft.draft.mutationOperations?.[0]).toMatchObject({ operation: "deleteBlocks", blockIds: ["p_2"] });
    expect(draft.nextDocument.content.map((block) => block.id)).toEqual(["p_1"]);
  });
});

describe("summarizeSessionDraftForToolResult / summarizeSigmaDocMutationOps", () => {
  it("summarizes an AiEditDraft session without embedding full blocks or nextDocument", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_1",
      blocks: [{ type: "paragraph", id: "ai_body_added", runs: ["追加した本文"] }],
    }).ok).toBe(true);

    const draft = getSigmaDocAgentSessionDraft(session, {});
    const summary = summarizeSessionDraftForToolResult(draft);

    expect(summary).not.toHaveProperty("nextDocument");
    expect(summary.blockCount).toBe(session.draftDocument.content.length);
    expect(summary.operationSummaries).toHaveLength(1);
    expect(summary.operationSummaries[0]).toMatchObject({ type: "insertAfter", targetId: "p_1" });
    expect(summary.operationSummaries[0].insertedBlockIds).toHaveLength(1);
    expect(summary.revisionInfo.changedIds).toEqual(draft.changedIds);
  });

  it("summarizes deleteBlocks/moveBlocks/overlay-shape mutation ops with blockIds/shapeIds", () => {
    const summaries = summarizeSigmaDocMutationOps([
      { operation: "deleteBlocks", summary: "削除しました。", blockIds: ["a", "b"] },
      { operation: "moveBlocks", summary: "移動しました。", blockIds: ["a"], targetId: "c", position: "after" },
      { operation: "updateOverlayShape", summary: "更新しました。", shapeId: "shape_1", patch: {} },
      { operation: "alignOverlayShapes", summary: "整列しました。", shapeIds: ["shape_1", "shape_2"], mode: "left" },
      { operation: "deleteOverlayShapes", summary: "図形を削除しました。", shapeIds: ["shape_1"] },
    ]);

    expect(summaries).toEqual([
      { type: "deleteBlocks", blockIds: ["a", "b"], summaryText: "削除しました。" },
      { type: "moveBlocks", targetId: "c", blockIds: ["a"], summaryText: "移動しました。" },
      { type: "updateOverlayShape", shapeIds: ["shape_1"], summaryText: "更新しました。" },
      { type: "alignOverlayShapes", shapeIds: ["shape_1", "shape_2"], summaryText: "整列しました。" },
      { type: "deleteOverlayShapes", shapeIds: ["shape_1"], summaryText: "図形を削除しました。" },
    ]);
  });
});

const COMPLEX_RANGE_GRAPH_SPEC: Graph2DSpec = {
  kind: "cartesian",
  title: "正方形積の範囲",
  width: 560,
  height: 320,
  viewBox: { xMin: "-1.2", xMax: "1.2", yMin: "-1.2", yMax: "1.2" },
  axes: { grid: false, showX: true, showY: true, showTicks: false },
  curves: [
    { id: "range_edge_top_left", expr: "x + 1", mode: "yOfX", domain: { min: "-1", max: "0" }, color: "#0d0d0d" },
    { id: "range_edge_top_right", expr: "1 - x", mode: "yOfX", domain: { min: "0", max: "1" }, color: "#0d0d0d" },
    { id: "range_edge_bottom_left", expr: "-x - 1", mode: "yOfX", domain: { min: "-1", max: "0" }, color: "#0d0d0d" },
    { id: "range_edge_bottom_right", expr: "x - 1", mode: "yOfX", domain: { min: "0", max: "1" }, color: "#0d0d0d" },
    { id: "range_parabola_top", expr: "(1 - x^2)/2", mode: "yOfX", domain: { min: "-1", max: "1" }, color: "#2563eb" },
    { id: "range_parabola_bottom", expr: "(x^2 - 1)/2", mode: "yOfX", domain: { min: "-1", max: "1" }, color: "#2563eb" },
    { id: "range_parabola_left", expr: "(y^2 - 1)/2", mode: "xOfY", domain: { min: "-1", max: "1" }, color: "#2563eb" },
    { id: "range_parabola_right", expr: "(1 - y^2)/2", mode: "xOfY", domain: { min: "-1", max: "1" }, color: "#2563eb" },
  ],
  points: [
    { id: "range_point_right", x: "1", y: "0", color: "#0d0d0d" },
    { id: "range_point_top", x: "0", y: "1", color: "#0d0d0d" },
    { id: "range_point_left", x: "-1", y: "0", color: "#0d0d0d" },
    { id: "range_point_bottom", x: "0", y: "-1", color: "#0d0d0d" },
  ],
  annotations: [],
  fills: [
    { id: "range_fill_top", x: "0", y: "0.56", color: "#d1d5db", opacity: 0.5 },
    { id: "range_fill_right", x: "0.56", y: "0", color: "#d1d5db", opacity: 0.5 },
    { id: "range_fill_bottom", x: "0", y: "-0.56", color: "#d1d5db", opacity: 0.5 },
    { id: "range_fill_left", x: "-0.56", y: "0", color: "#d1d5db", opacity: 0.5 },
  ],
};

function createDocument(content?: SigmaDocument["content"]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_agent_tools",
    metadata: { title: "Agent Tools" },
    content: content ?? [
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "基準本文" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}

function createWhiteboardDocument(): SigmaDocument {
  return {
    ...createDocument([]),
    pageLayout: getDefaultPageLayout("whiteboard"),
  };
}

function paragraph(id: string, text: string) {
  return {
    type: "paragraph" as const,
    id,
    children: [{ type: "text" as const, text }],
  };
}

function materialItem(id: string, name: string): MaterialItem {
  const shape: OverlayGeoShape = {
    id: "material_spring_shape",
    type: "geo",
    x: 0,
    y: 0,
    anchor: { type: "page" },
    props: {
      w: 80,
      h: 24,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
  return {
    version: 1,
    id,
    name,
    source: "user",
    description: "力学の台車や小球に接続するコイルばね",
    tags: ["力学"],
    usage: {
      useCases: ["小球や台車につながるバネを描くとき"],
      aliases: ["spring", "coil"],
    },
    visualConcepts: ["バネ", "コイル", "spring"],
    transformPolicy: { scale: true, rotate: false },
    ports: [
      { id: "leftEnd", label: "左端", x: 0, y: 12, kind: "leftEnd" },
      { id: "rightEnd", label: "右端", x: 80, y: 12, kind: "rightEnd" },
    ],
    content: {
      blocks: [paragraph("material_spring_text", "バネ定数 k")],
      overlaySnapshot: {
        version: 1,
        shapes: [shape],
        assets: {},
      },
    },
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

function tableCellTexValues(table: OverlayTableShape["props"]["table"]): string[] {
  const values: string[] = [];

  for (const cell of table.cells) {
    for (const content of cell.content) {
      if (content.type === "trend") {
        for (const node of content.label ?? []) {
          if (node.type === "mathInline") {
            values.push(node.tex);
          }
        }
        continue;
      }

      for (const node of content.children) {
        if (node.type === "mathInline") {
          values.push(node.tex);
        }
      }
    }
  }

  return values;
}

function rectangleShape(id: string) {
  return {
    id,
    type: "geo" as const,
    x: 0,
    y: 44,
    rotation: 0,
    props: {
      w: 180,
      h: 96,
      geo: "rectangle" as const,
      fill: "none" as const,
      color: "black",
      fillColor: "#ffffff",
      labelColor: "black",
      dash: "solid" as const,
      size: "m" as const,
      label: "補助線",
    },
  };
}

function tableShape(id: string) {
  const columns = [
    { id: "col_1", width: { mode: "auto" as const, min: 48 }, role: "label" as const },
    { id: "col_2", width: { mode: "fr" as const, value: 1, min: 56 }, role: "value" as const },
  ];
  const rows = [
    { id: "row_1", height: { mode: "auto" as const, min: 32 }, role: "header" as const },
    { id: "row_2", height: { mode: "auto" as const, min: 32 }, role: "body" as const },
  ];

  return {
    id,
    type: "tableShape" as const,
    x: 0,
    y: 44,
    rotation: 0,
    props: {
      w: 320,
      h: 96,
      table: {
        version: 1 as const,
        kind: "plain" as const,
        columns,
        rows,
        cells: rows.flatMap((row, rowIndex) =>
          columns.map((column, columnIndex) => ({
            id: `cell_${rowIndex}_${columnIndex}`,
            rowId: row.id,
            columnId: column.id,
            content: [{
              type: "paragraph" as const,
              id: `cell_p_${rowIndex}_${columnIndex}`,
              children: [{ type: "text" as const, text: rowIndex === 0 ? ["項目", "値"][columnIndex] : "" }],
              align: "center" as const,
            }],
          })),
        ),
        grid: {
          borderColor: "#111827",
          borderWidth: 1,
          borderStyle: "solid" as const,
          showOuterBorder: true,
          showInnerBorders: true,
        },
        defaultCellStyle: {
          align: "center" as const,
          verticalAlign: "middle" as const,
          paddingX: 8,
          paddingY: 5,
          color: "#111827",
          fontSize: 15,
          fontWeight: "normal" as const,
        },
      },
    },
  };
}

function getTextShapeMathTex(shape: OverlayTextShape | undefined): string | undefined {
  const node = overlayTextBlocksToInlineNodes(shape?.props.blocks ?? [])[0];
  return node?.type === "mathInline" ? node.tex : undefined;
}

describe("createTableSpecFromAiToolArgs: baseTable inheritance (update_table content-mode rebuild)", () => {
  it("inherits column width/row height/grid/defaultCellStyle from baseTable when the caller doesn't specify them", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;
    baseTable.columns[0]!.width = { mode: "fixed", value: 111 };
    baseTable.rows[1]!.height = { mode: "fixed", value: 77 };
    baseTable.grid.borderColor = "#ff00ff";
    baseTable.grid.borderWidth = 4;
    baseTable.defaultCellStyle.backgroundColor = "#eeeeee";
    baseTable.defaultCellStyle.color = "#654321";

    const rebuilt = createTableSpecFromAiToolArgs({ cells: [["A", "B"], ["C", "D"]] }, baseTable);

    expect(rebuilt.columns[0]!.width).toEqual({ mode: "fixed", value: 111 });
    expect(rebuilt.rows[1]!.height).toEqual({ mode: "fixed", value: 77 });
    expect(rebuilt.grid.borderColor).toBe("#ff00ff");
    expect(rebuilt.grid.borderWidth).toBe(4);
    expect(rebuilt.defaultCellStyle.backgroundColor).toBe("#eeeeee");
    expect(rebuilt.defaultCellStyle.color).toBe("#654321");
    // Content itself was rebuilt from the new `cells`.
    const firstCellText = rebuilt.cells[0]?.content[0];
    expect(firstCellText?.type).toBe("paragraph");
  });

  it("still applies explicit width/height/grid/defaultCellStyle overrides even when a baseTable is supplied", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;
    baseTable.columns[0]!.width = { mode: "fixed", value: 111 };

    const rebuilt = createTableSpecFromAiToolArgs({
      cells: [["A", "B"], ["C", "D"]],
      columns: [{ width: { mode: "fixed", value: 999 } }],
    }, baseTable);

    expect(rebuilt.columns[0]!.width).toEqual({ mode: "fixed", value: 999 });
  });

  it("insert_table's own path (no baseTable) is unaffected and still uses hard-coded defaults", () => {
    const inserted = createTableSpecFromAiToolArgs({ cells: [["A", "B"], ["C", "D"]] });
    expect(inserted.columns[0]!.width).toMatchObject({ mode: "auto" });
    expect(inserted.grid.borderColor).toBe("#111827");
    expect(inserted.defaultCellStyle.color).toBe("#111827");
  });
});

describe("applyAiTableCellPatches", () => {
  it("replaces exactly the targeted cell's content and leaves everything else identical", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;

    const patched = applyAiTableCellPatches(baseTable, [{ row: 1, col: 0, content: "変更後" }]);

    expect(patched.columns).toEqual(baseTable.columns);
    expect(patched.rows).toEqual(baseTable.rows);
    expect(patched.grid).toEqual(baseTable.grid);
    expect(patched.defaultCellStyle).toEqual(baseTable.defaultCellStyle);

    const targetRowId = baseTable.rows[1]!.id;
    const targetColumnId = baseTable.columns[0]!.id;
    for (const cell of patched.cells) {
      const original = baseTable.cells.find((item) => item.id === cell.id)!;
      if (cell.rowId === targetRowId && cell.columnId === targetColumnId) {
        expect(cell.content).not.toEqual(original.content);
        const paragraph = cell.content[0] as { type: string; children: Array<{ text?: string }> };
        expect(paragraph.type).toBe("paragraph");
        expect(paragraph.children.some((child) => child.text === "変更後")).toBe(true);
      } else {
        expect(cell.content).toEqual(original.content);
      }
    }
  });

  it("throws a Japanese error for an out-of-range row/col", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;
    expect(() => applyAiTableCellPatches(baseTable, [{ row: 99, col: 0, content: "x" }])).toThrow(/範囲外/);
    expect(() => applyAiTableCellPatches(baseTable, [{ row: 0, col: 99, content: "x" }])).toThrow(/範囲外/);
  });

  it("throws a Japanese error when a patch omits content (avoids silent cell wipe)", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;
    expect(() => applyAiTableCellPatches(baseTable, [{ row: 0, col: 0 }])).toThrow(/contentが指定されていません/);
  });

  it("throws a clear merged-cell error when the target position is covered by another cell's span", () => {
    const baseTable: SigmaTableSpec = tableShape("base").props.table;
    // Remove the (0,1) cell and make (0,0) span 2 columns → (0,1) is now covered by the merge.
    const col1Id = baseTable.columns[1]!.id;
    const row0Id = baseTable.rows[0]!.id;
    const merged: SigmaTableSpec = {
      ...baseTable,
      cells: baseTable.cells
        .filter((cell) => !(cell.rowId === row0Id && cell.columnId === col1Id))
        .map((cell) => (cell.rowId === row0Id && cell.columnId === baseTable.columns[0]!.id ? { ...cell, colSpan: 2 } : cell)),
    };
    expect(() => applyAiTableCellPatches(merged, [{ row: 0, col: 1, content: "x" }])).toThrow(/結合セル/);
  });
});

describe("AI挿入の座標系: shape.x/y は絶対、anchor.dx/dy はブロック相対デルタ", () => {
  // 提案プレビューと承認適用はどちらも resolveShapePosition しか通らないので、
  // 「resolveShapePosition が入力の絶対座標を再現する」が『提案位置=適用後位置』の
  // 実行可能な定義になる。
  function expectAnchorInvariant(document: SigmaDocument, shape: { x: number; y: number; anchor?: unknown }): void {
    const rects = estimateBlockRects(document);
    const resolved = resolveShapePosition(
      shape as Pick<OverlayShape, "x" | "y" | "anchor">,
      rects,
    );
    expect(resolved.x).toBeCloseTo(shape.x, 6);
    expect(resolved.y).toBeCloseTo(shape.y, 6);
  }

  function expectAnchorDelta(anchor: unknown, expected: { dx: number; dy: number }): void {
    const blockAnchor = anchor as { type: string; dx: number; dy: number };
    expect(blockAnchor.type).toBe("block");
    expect(blockAnchor.dx).toBeCloseTo(expected.dx, 6);
    expect(blockAnchor.dy).toBeCloseTo(expected.dy, 6);
  }

  function anchorRect(document: SigmaDocument, blockId: string) {
    const rect = estimateBlockRects(document).get(blockId);
    expect(rect).toBeDefined();
    return rect!;
  }

  it("converts insert_table absolute coordinates into a block-relative anchor", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "p_1",
      id: "table_abs_coords",
      kind: "variation",
      x: rect.left + 40,
      y: rect.top + 260,
    }).ok).toBe(true);

    const table = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayTableShape => shape.id === "table_abs_coords" && shape.type === "tableShape");
    expect(table?.x).toBeCloseTo(rect.left + 40, 6);
    expect(table?.y).toBeCloseTo(rect.top + 260, 6);
    expectAnchorDelta(table?.anchor, { dx: 40, dy: 260 });
    expectAnchorInvariant(session.draftDocument, table!);
  });

  it("keeps a negative anchor dy when insert_shape places a figure above its anchor block", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_above_block",
      kind: "circle",
      x: rect.left + 10,
      y: rect.top - 60,
      r: 40,
    }).ok).toBe(true);

    const circle = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGeoShape => shape.id === "shape_above_block" && shape.type === "geo");
    expect(circle?.anchor).toMatchObject({ type: "block", blockId: "p_1" });
    expectAnchorDelta(circle?.anchor, { dx: 10, dy: -60 });
    expectAnchorInvariant(session.draftDocument, circle!);
  });

  it("derives the placement anchor without clamping the requested offset", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_placed_above",
      kind: "rectangle",
      placement: { anchorBlockId: "p_1", position: "above", offsetY: 40 },
    }).ok).toBe(true);

    const rectangle = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGeoShape => shape.id === "shape_placed_above" && shape.type === "geo");
    expect(rectangle?.anchor).toMatchObject({ type: "block", blockId: "p_1", dx: 0, dy: -40 });
    expectAnchorInvariant(session.draftDocument, rectangle!);
  });

  it("defaults an omitted position to 24px below the anchor block origin", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "p_1",
      id: "shape_default_pos",
      kind: "rectangle",
    }).ok).toBe(true);

    const rectangle = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGeoShape => shape.id === "shape_default_pos" && shape.type === "geo");
    expect(rectangle?.x).toBeCloseTo(rect.left, 6);
    expect(rectangle?.y).toBeCloseTo(rect.top + 24, 6);
    expectAnchorDelta(rectangle?.anchor, { dx: 0, dy: 24 });
  });

  it("anchors an inserted graph and keeps its owned labels on shape anchors", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph_abs_coords",
      x: rect.left + 24,
      y: rect.top + 120,
      axes: { xLabel: "x", yLabel: "y" },
      curves: [{ id: "curve_abs_coords", expr: "x^2" }],
    }).ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const graph = shapes.find((shape): shape is OverlayGraphShape => shape.id === "graph_abs_coords" && shape.type === "graph2dShape");
    expect(graph?.x).toBeCloseTo(rect.left + 24, 6);
    expect(graph?.y).toBeCloseTo(rect.top + 120, 6);
    expectAnchorDelta(graph?.anchor, { dx: 24, dy: 120 });
    expectAnchorInvariant(session.draftDocument, graph!);
    expect(shapes.filter((shape) => shape.type === "text").every((shape) => shape.anchor?.type === "shape")).toBe(true);
  });

  // targetId が problem の場合 resolveOverlayInsertionTarget が prompt[0] へ
  // アンカーを付け替える。ネストしたブロックも推定矩形に載っていないと
  // dx/dy に絶対座標がそのまま残り、描画時に blockTop 分だけ二重加算される。
  it("converts absolute coordinates for a problem target that re-anchors to its prompt block", () => {
    const document = createDocument([
      paragraph("p_1", "基準本文"),
      {
        type: "problem",
        id: "prob_1",
        tags: [],
        lead: [paragraph("prob_1_lead", "リード文")],
        prompt: [paragraph("prob_1_prompt", "問題文")],
        answer: { type: "math", expected: "x=1" },
        solution: [],
        hints: [],
      },
    ] as unknown as SigmaDocument["content"]);
    const session = createSigmaDocAgentSession({ document, selectedId: "p_1" });
    const promptRect = anchorRect(session.draftDocument, "prob_1_prompt");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "prob_1",
      id: "shape_on_problem",
      kind: "circle",
      x: promptRect.left + 30,
      y: promptRect.top + 90,
      r: 40,
    }).ok).toBe(true);

    const circle = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((shape): shape is OverlayGeoShape => shape.id === "shape_on_problem" && shape.type === "geo");
    expect(circle?.anchor).toMatchObject({ type: "block", blockId: "prob_1_prompt" });
    expectAnchorDelta(circle?.anchor, { dx: 30, dy: 90 });
    expectAnchorInvariant(session.draftDocument, circle!);
  });

  it("anchors a raw insert_overlay_shape by its absolute coordinates", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_overlay_shape", {
      targetId: "p_1",
      shape: {
        id: "raw_overlay_shape",
        type: "geo",
        x: rect.left + 15,
        y: rect.top + 300,
        rotation: 0,
        props: {
          w: 100,
          h: 60,
          geo: "rectangle",
          fill: "none",
          color: "black",
          fillColor: "#ffffff",
          labelColor: "black",
          dash: "solid",
          size: "m",
        },
      },
      assets: {},
    }).ok).toBe(true);

    const shape = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((item) => item.id === "raw_overlay_shape");
    expectAnchorDelta(shape?.anchor, { dx: 15, dy: 300 });
    expectAnchorInvariant(session.draftDocument, shape!);
  });

  it("anchors every cloned material shape against the requested absolute origin", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument(),
      selectedId: "p_1",
      materials: [materialItem("material_placement", "ばね")],
    });
    const rect = anchorRect(session.draftDocument, "p_1");

    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_material", {
      targetId: "p_1",
      materialId: "material_placement",
      x: rect.left + 50,
      y: rect.top + 200,
    }).ok).toBe(true);

    const shapes = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes[0]?.x).toBeCloseTo(rect.left + 50, 6);
    expect(shapes[0]?.y).toBeCloseTo(rect.top + 200, 6);
    for (const shape of shapes) {
      expect(shape.anchor?.type).toBe("block");
      expectAnchorInvariant(session.draftDocument, shape);
    }
  });
});

describe("normalizeAiShapeGeometryPatch: absolute→local-origin normalization + delta-based anchor recompute", () => {
  // blockTop≠0 fixtures: anchor.dy ≠ shape.y (dy = shape.y - blockTop) and anchor.dx ≠ shape.x
  // (dx = shape.x - blockLeft), so a delta bug (overwriting dy with absolute y) would be caught.
  // Here blockTop=380 (dy 120 vs y 500), blockLeft=30 (dx 10 vs x 40).
  function lineFixture(): OverlayLineShape {
    return {
      id: "line_1",
      type: "line",
      x: 40,
      y: 500,
      rotation: 0,
      anchor: { type: "block", blockId: "p_1", dx: 10, dy: 120 },
      props: {
        kind: "polyline",
        points: [{ x: 0, y: 0 }, { x: 60, y: 20 }],
        closed: false,
        color: "black",
        dash: "solid",
        size: "m",
      },
    };
  }

  function arrowFixture(): OverlayArrowShape {
    // blockTop=360 (dy 200 vs y 560), blockLeft=30 (dx 10 vs x 40).
    return {
      id: "arrow_1",
      type: "arrow",
      x: 40,
      y: 560,
      rotation: 0,
      anchor: { type: "block", blockId: "p_1", dx: 10, dy: 200 },
      props: {
        start: { x: 0, y: 0 },
        end: { x: 120, y: 0 },
        arrowheadEnd: "arrow",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };
  }

  it("normalizes a line's absolute points to the first-point origin and shifts the anchor by the delta", () => {
    const patch = normalizeAiShapeGeometryPatch(lineFixture(), {
      points: [{ x: 60, y: 600 }, { x: 120, y: 640 }, { x: 180, y: 600 }],
      closed: true,
    });
    expect(patch.x).toBe(60);
    expect(patch.y).toBe(600);
    expect(patch.props.points).toEqual([{ x: 0, y: 0 }, { x: 60, y: 40 }, { x: 120, y: 0 }]);
    expect(patch.props.closed).toBe(true);
    // dy shifts by (600-500)=100 → 220; dx shifts by (60-40)=20 → 30. NOT overwritten with abs y/x.
    expect(patch.anchor).toEqual({ type: "block", blockId: "p_1", dx: 30, dy: 220 });
  });

  it("PRESERVES position (anchor & shape.y unchanged) when the existing absolute points are echoed back", () => {
    // Fixture line's current absolute points: origin = shape {40,500}, second = {100,520}.
    const patch = normalizeAiShapeGeometryPatch(lineFixture(), { points: [{ x: 40, y: 500 }, { x: 100, y: 520 }] });
    expect(patch.x).toBe(40);
    expect(patch.y).toBe(500);
    // Delta is zero → anchor identical to the existing one (no teleport by blockTop).
    expect(patch.anchor).toEqual({ type: "block", blockId: "p_1", dx: 10, dy: 120 });
  });

  it("leaves dx absent (does not reintroduce a blockLeft offset) when the existing anchor has no dx", () => {
    const line = lineFixture();
    line.anchor = { type: "block", blockId: "p_1", dy: 120 };
    const patch = normalizeAiShapeGeometryPatch(line, { points: [{ x: 60, y: 600 }, { x: 120, y: 640 }] });
    expect(patch.x).toBe(60);
    expect(patch.anchor).toEqual({ type: "block", blockId: "p_1", dy: 220 });
    expect(patch.anchor && "dx" in patch.anchor).toBe(false);
  });

  it("only sets closed (no coord/anchor change) when points are omitted", () => {
    const patch = normalizeAiShapeGeometryPatch(lineFixture(), { closed: true });
    expect(patch.x).toBeUndefined();
    expect(patch.y).toBeUndefined();
    expect(patch.anchor).toBeUndefined();
    expect(patch.props).toEqual({ closed: true });
  });

  it("normalizes an arrow's absolute start/end to a start origin and shifts the anchor by the delta", () => {
    const patch = normalizeAiShapeGeometryPatch(arrowFixture(), {
      start: { x: 70, y: 700 },
      end: { x: 220, y: 730 },
    });
    expect(patch.x).toBe(70);
    expect(patch.y).toBe(700);
    expect(patch.props.start).toEqual({ x: 0, y: 0 });
    expect(patch.props.end).toEqual({ x: 150, y: 30 });
    // dy shifts by (700-560)=140 → 340; dx shifts by (70-40)=30 → 40.
    expect(patch.anchor).toEqual({ type: "block", blockId: "p_1", dx: 40, dy: 340 });
  });

  it("reconstructs the existing absolute start (and preserves the anchor) when only end is supplied", () => {
    // Fixture arrow: abs start {40,560}, abs end {160,560}.
    const patch = normalizeAiShapeGeometryPatch(arrowFixture(), { end: { x: 300, y: 600 } });
    expect(patch.x).toBe(40);
    expect(patch.y).toBe(560);
    expect(patch.props.start).toEqual({ x: 0, y: 0 });
    expect(patch.props.end).toEqual({ x: 260, y: 40 });
    // start unchanged → delta zero → anchor preserved.
    expect(patch.anchor).toEqual({ type: "block", blockId: "p_1", dx: 10, dy: 200 });
  });


  it("inserts boxBlock with valid styleId and normalizes inner blocks with math", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p1", "本文1")]),
      selectedId: "p1",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p1",
      blocks: [{
        type: "boxBlock",
        styleId: "itembox",
        title: "ポイント",
        blocks: [{ type: "paragraph", text: "計算は $x=1$ です。" }]
      }]
    });

    expect(result.ok).toBe(true);
    const boxBlock = session.draftDocument.content[1];
    expect(boxBlock).toMatchObject({
      type: "boxBlock",
      styleId: "itembox"
    });
    if (boxBlock.type === "boxBlock") {
      expect(boxBlock.title?.[0]).toMatchObject({ type: "text", text: "ポイント" });
      expect(boxBlock.blocks[0]).toMatchObject({
        type: "paragraph",
        children: [
          { type: "text", text: "計算は " },
          { type: "mathInline", tex: "x=1", display: "inline" },
          { type: "text", text: " です。" }
        ]
      });
    }
  });

  it("preserves list items and nested lists inside a boxBlock", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p1", "本文")]),
      selectedId: "p1",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p1",
      blocks: [{
        type: "boxBlock",
        styleId: "itembox",
        blocks: [{
          type: "list",
          id: "steps",
          listType: "ordered",
          start: 3,
          items: [{
            id: "step_1",
            runs: ["式 ", { type: "math", id: "step_math", tex: "x=1" }],
            nested: [{
              type: "list",
              id: "notes",
              listType: "bullet",
              items: [{ id: "note_1", text: "途中式を残す。" }],
            }],
          }],
        }],
      }],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[1]).toMatchObject({
      type: "boxBlock",
      blocks: [{
        type: "list",
        id: "steps",
        listType: "ordered",
        start: 3,
        items: [{
          type: "listItem",
          id: "step_1",
          children: [
            { type: "text", text: "式 " },
            { type: "mathInline", id: "step_math", tex: "x=1" },
          ],
          nested: [{
            type: "list",
            id: "notes",
            listType: "bullet",
            items: [{
              type: "listItem",
              id: "note_1",
              children: [{ type: "text", text: "途中式を残す。" }],
            }],
          }],
        }],
      }],
    });
  });

  it("keeps a requested (1) marker style and ignores it on bullets and unknown values", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p1", "本文")]),
      selectedId: "p1",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p1",
      blocks: [
        {
          type: "list",
          id: "paren",
          listType: "ordered",
          markerStyle: "paren",
          items: [{ id: "paren_1", text: "括弧付き" }],
        },
        {
          type: "list",
          id: "unknown_marker",
          listType: "ordered",
          markerStyle: "roman",
          items: [{ id: "unknown_1", text: "未知のマーカー" }],
        },
        {
          type: "list",
          id: "bullet",
          listType: "bullet",
          markerStyle: "paren",
          items: [{ id: "bullet_1", text: "箇条書き" }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(session.draftDocument.content[1]).toMatchObject({ type: "list", markerStyle: "paren" });
    expect(session.draftDocument.content[2]).not.toHaveProperty("markerStyle");
    expect(session.draftDocument.content[3]).not.toHaveProperty("markerStyle");
  });

  it("rejects invalid TeX in every rich child type of a top-level boxBlock", () => {
    const invalidMath = (id: string) => ({
      type: "mathInline" as const,
      id,
      tex: "\\unknown{x}",
      display: "inline" as const,
    });
    const blocks: BoxBlockChildBlock[] = [
      { type: "heading", id: "heading", level: 2, children: [invalidMath("bad_heading")] },
      { type: "paragraph", id: "paragraph", children: [invalidMath("bad_paragraph")] },
      {
        type: "list",
        id: "list",
        listType: "bullet",
        items: [{
          type: "listItem",
          id: "list_item",
          children: [invalidMath("bad_list")],
          nested: [{
            type: "list",
            id: "nested_list",
            listType: "ordered",
            items: [{ type: "listItem", id: "nested_item", children: [invalidMath("bad_nested_list")] }],
          }],
        }],
      },
      {
        type: "layoutSection",
        id: "layout",
        layout: { columnCount: 2 },
        children: [{ type: "paragraph", id: "layout_paragraph", children: [invalidMath("bad_layout")] }],
      },
      {
        type: "boxBlock",
        id: "nested_box",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", id: "nested_box_paragraph", children: [invalidMath("bad_nested_box")] }],
      },
    ];
    const session = createSigmaDocAgentSession({
      document: createDocument([{
        type: "boxBlock",
        id: "box",
        styleId: "itembox",
        title: [invalidMath("bad_title")],
        blocks,
      }]),
      selectedId: "box",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_validate", {});

    expect(result.ok).toBe(false);
    for (const id of [
      "bad_title",
      "bad_heading",
      "bad_paragraph",
      "bad_list",
      "bad_nested_list",
      "bad_layout",
      "bad_nested_box",
    ]) {
      expect(result.message).toContain(id);
    }
  });

  it("rejects invalid boxBlock styleId with list of available styles", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([paragraph("p1", "本文")]),
      selectedId: "p1",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p1",
      blocks: [{
        type: "boxBlock",
        styleId: "invalid-style",
        blocks: [{ type: "paragraph", text: "本文" }]
      }]
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/指定されたboxのスタイルが見つかりません/);
    expect(result.message).toContain("fancybox");
    expect(result.message).toContain("itembox");
  });

  it("prevents boxBlock insertion in problem areas", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([{
        type: "problem",
        id: "problem1",
        tags: [],
        lead: [],
        prompt: [paragraph("p_prompt", "問題文")],
        solution: [],
        hints: []
      }]),
      selectedId: "p_prompt",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "p_prompt",
      area: "prompt",
      blocks: [{
        type: "boxBlock",
        styleId: "fancybox",
        blocks: [{ type: "paragraph", text: "本文" }]
      }]
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/boxBlockは問題エリア内に挿入できません/);
  });

  it("leaves a non-block anchor untouched (page/shape anchors carry no origin offset)", () => {
    const line = lineFixture();
    line.anchor = { type: "page" };
    const patch = normalizeAiShapeGeometryPatch(line, { points: [{ x: 60, y: 600 }, { x: 120, y: 640 }] });
    expect(patch.x).toBe(60);
    expect(patch.anchor).toBeUndefined();
  });
});

describe("draft_insert_graph3d / draft_update_graph3d", () => {
  const presetNames = buildGraph3DPresetNames(createTranslator("ja", "shape"));

  function findGraph3DShapes(session: ReturnType<typeof createSigmaDocAgentSession>): OverlayGraph3DShape[] {
    return (session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
      .filter((shape): shape is OverlayGraph3DShape => shape.type === "graph3dShape");
  }

  /** ツールの語彙に無い永続fieldを図形へ置く。cutsを書ける経路はツール側に存在しないので、
   * 「無関係な更新が既存のcutsを消さない」ことはここで作った状態からしか確かめられない。 */
  function putCutOnGraph3DShape(
    session: ReturnType<typeof createSigmaDocAgentSession>,
    shapeId: string,
    cut: Graph3DCut,
  ): void {
    const layout = session.draftDocument.pageLayout!;
    const snapshot = layout.overlay!.overlaySnapshot!;
    session.draftDocument = {
      ...session.draftDocument,
      pageLayout: {
        ...layout,
        overlay: {
          ...layout.overlay!,
          overlaySnapshot: {
            ...snapshot,
            shapes: snapshot.shapes.map((shape) => (
              shape.id === shapeId && shape.type === "graph3dShape"
                ? { ...shape, props: { ...shape.props, spec: { ...shape.props.spec, cuts: [cut] } } }
                : shape
            )),
          },
        },
      },
    };
  }

  function insertRevolution(session: ReturnType<typeof createSigmaDocAgentSession>, args: Record<string, unknown> = {}) {
    return executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      id: "graph3d_ai",
      preset: "revolution",
      ...args,
    });
  }

  it("inserts a graph3dShape from a preset alone and never persists cuts", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session);

    expect(result.ok).toBe(true);
    const shapes = findGraph3DShapes(session);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].props.spec.objects.some((object) => object.kind === "solidOfRevolution")).toBe(true);
    expect(shapes[0].props.spec.cuts).toEqual([]);
    expect(shapes[0].props.spec.version).toBe(1);
  });

  it("uses the drag default 360x280 box and honours explicit w/h", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    expect(insertRevolution(session).ok).toBe(true);
    expect(findGraph3DShapes(session)[0].props).toMatchObject({ w: 360, h: 280 });

    const sized = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(sized, { id: "graph3d_sized", w: 480, h: 320 }).ok).toBe(true);
    expect(findGraph3DShapes(sized)[0].props).toMatchObject({ w: 480, h: 320 });
  });

  it("merges camera shallowly onto the preset camera", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, { camera: { position: { x: 1, y: 1, z: 1 } } });

    expect(result.ok).toBe(true);
    expect(findGraph3DShapes(session)[0].props.spec.camera).toEqual({
      projection: "perspective",
      position: { x: 1, y: 1, z: 1 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 42,
    });
  });

  it("merges view shallowly onto the preset view", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, { view: { showGrid: false } });

    expect(result.ok).toBe(true);
    const view = findGraph3DShapes(session)[0].props.spec.view;
    expect(view.showGrid).toBe(false);
    expect(view.showAxes).toBe(true);
    expect(view.coordinateSystem).toBe("zUp");
    expect(view.backgroundColor).toBe("#ffffff");
  });

  it("replaces arrays wholesale instead of appending to the preset", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      objects: [{
        id: "sphere_only",
        kind: "primitive",
        primitive: "sphere",
        center: { x: "0", y: "0", z: "0" },
        size: { x: "2", y: "2", z: "2" },
      }],
      regions: [],
      annotations: [],
      parameters: [],
    });

    expect(result.ok).toBe(true);
    const spec = findGraph3DShapes(session)[0].props.spec;
    expect(spec.objects.map((object) => object.id)).toEqual(["sphere_only"]);
    expect(spec.regions).toEqual([]);
    expect(spec.annotations).toEqual([]);
    expect(spec.parameters).toEqual([]);
  });

  it("accepts a full spec without a preset", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      id: "graph3d_spec_only",
      spec: {
        parameters: [],
        objects: [{
          id: "segment_only",
          kind: "segment",
          from: { x: "0", y: "0", z: "0" },
          to: { x: "1", y: "1", z: "1" },
        }],
        regions: [],
        annotations: [],
        camera: {
          projection: "orthographic",
          position: { x: 4, y: -4, z: 3 },
          target: { x: 0, y: 0, z: 0 },
          up: { x: 0, y: 0, z: 1 },
          zoom: 1.5,
        },
        view: {
          coordinateSystem: "zUp",
          showAxes: false,
          showGrid: false,
          backgroundColor: "#eef2ff",
        },
      },
    });

    expect(result.ok).toBe(true);
    const spec = findGraph3DShapes(session)[0].props.spec;
    expect(spec.objects.map((object) => object.kind)).toEqual(["segment"]);
    expect(spec.camera.projection).toBe("orthographic");
    expect(spec.view.backgroundColor).toBe("#eef2ff");
    expect(spec.cuts).toEqual([]);
  });

  it("rejects an invalid object and names the failing field path", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      objects: [{ id: "broken", kind: "notAKind" }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("objects[0]");
    expect(findGraph3DShapes(session)).toHaveLength(0);
  });

  it("names both camera and view when both are broken", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      preset: "blank",
      camera: { projection: "isometric" },
      view: { coordinateSystem: "yUp" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("camera");
    expect(result.message).toContain("view");
  });

  it("names only the broken half when just the camera is invalid", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      preset: "blank",
      camera: { projection: "isometric" },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("camera");
    expect(result.message).not.toContain("view");
  });

  it("refuses a preview png that is not a PNG data url even when the shared gate accepts it", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      previewPng: { dataUrl: "sigma-doc-storage://graph3d-preview", w: 1, h: 1 },
    });

    expect(result.ok).toBe(false);
    expect(findGraph3DShapes(session)).toHaveLength(0);
  });

  it("inserts on a whiteboard CANVAS without an anchor and refuses CANVAS elsewhere", () => {
    const whiteboard = createSigmaDocAgentSession({ document: createWhiteboardDocument(), selectedId: null });

    const canvasResult = executeSigmaDocAgentDraftTool(whiteboard, "draft_insert_graph3d", {
      targetId: "CANVAS",
      id: "whiteboard_graph3d",
      preset: "blank",
      x: 640,
      y: 400,
    });

    expect(canvasResult.ok).toBe(true);
    const canvasShape = findGraph3DShapes(whiteboard)[0];
    expect(canvasShape).toMatchObject({ x: 640, y: 400 });
    expect(canvasShape).not.toHaveProperty("anchor");

    const paged = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(executeSigmaDocAgentDraftTool(paged, "draft_insert_graph3d", {
      targetId: "CANVAS",
      preset: "blank",
    }).ok).toBe(false);
  });

  it("anchors an area insertion inside the requested problem area", () => {
    const session = createSigmaDocAgentSession({
      document: createDocument([{
        type: "problem",
        id: "problem_graph3d",
        tags: [],
        lead: [],
        prompt: [paragraph("problem_graph3d_prompt", "問題文")],
        solution: [paragraph("problem_graph3d_solution", "解説")],
        hints: [],
      }]),
      selectedId: "problem_graph3d",
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "problem_graph3d",
      area: "solution",
      id: "graph3d_area",
      preset: "blank",
    });

    expect(result.ok).toBe(true);
    expect(findGraph3DShapes(session)[0].anchor).toMatchObject({
      type: "block",
      blockId: "problem_graph3d_solution",
    });
  });

  it("returns scene issues without failing the insertion", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      id: "graph3d_bad_expression",
      preset: "blank",
      objects: [{
        id: "broken_surface",
        kind: "implicitSurface",
        expression: "x^^2",
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        resolution: 8,
      }],
    });

    expect(result.ok).toBe(true);
    const data = result.data as { sceneIssues: { scope: string; id: string }[]; objectCount: number };
    expect(data.objectCount).toBe(1);
    expect(data.sceneIssues).toHaveLength(1);
    expect(data.sceneIssues[0]).toMatchObject({ scope: "object", id: "broken_surface" });
    expect(findGraph3DShapes(session)).toHaveLength(1);
  });

  it.each(["revolution", "surface", "tricylinder", "sphereTetrahedron", "blank"] as const)(
    "reports no scene issues for the %s preset",
    (preset) => {
      const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

      const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
        targetId: "p_1",
        id: `graph3d_${preset}`,
        preset,
      });

      expect(result.ok).toBe(true);
      expect((result.data as { sceneIssues: unknown[] }).sceneIssues).toEqual([]);
    },
  );

  it("bounds the issue probe so a dense figure cannot stall the tool call", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    // 解像度256のmarching cubesは1個で約1.8秒、この個数を素の密度で回すとヒープが尽きる。
    const objects = Array.from({ length: 16 }, (_, index) => ({
      id: `dense_solid_${index}`,
      kind: "boundedSolid",
      inequalities: ["x^2 + y^2 + z^2 <= 1"],
      bounds: {
        x: { min: "-1", max: "1" },
        y: { min: "-1", max: "1" },
        z: { min: "-1", max: "1" },
      },
      resolution: 256,
    }));

    const startedAt = Date.now();
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      id: "graph3d_dense",
      preset: "blank",
      objects,
    });

    expect(result.ok).toBe(true);
    expect((result.data as { sceneIssues: unknown[] }).sceneIssues).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // authoredな解像度は文書側にそのまま残る (粗くするのは検査用のサンプルだけ)。
    const stored = findGraph3DShapes(session)[0].props.spec.objects[0];
    expect(stored).toMatchObject({ kind: "boundedSolid", resolution: 256 });
  }, 30_000);

  it("bounds the issue probe for primitives too, which the shared sampler leaves alone", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    // `createGraph3DSampledSpec` は factor<1 では primitive の分割数を触らないので、
    // スキーマ上限どうし (64個 × 分割数256) を掛けるとピークメモリがGB級になる。
    const objects = Array.from({ length: 64 }, (_, index) => ({
      id: `dense_sphere_${index}`,
      kind: "primitive",
      primitive: "sphere",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
      resolution: 256,
    }));

    const startedAt = Date.now();
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_graph3d", {
      targetId: "p_1",
      id: "graph3d_dense_primitives",
      preset: "blank",
      objects,
    });

    expect(result.ok).toBe(true);
    expect((result.data as { sceneIssues: unknown[] }).sceneIssues).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(findGraph3DShapes(session)[0].props.spec.objects[0]).toMatchObject({ resolution: 256 });
  }, 30_000);

  it("reports regions whose members no longer exist after an objects replacement", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      objects: [{
        id: "lone_point",
        kind: "point",
        position: { x: "0", y: "0", z: "0" },
      }],
    });

    expect(result.ok).toBe(true);
    const data = result.data as { regionCount: number; unresolvedRegionIds: string[] };
    // revolution プリセットの region はメンバーを失っても spec には残る (黙って消さない)。
    expect(data.regionCount).toBe(1);
    expect(data.unresolvedRegionIds).toEqual(["region_section"]);
  });

  it("refuses a preview png that the AI overlay asset gate rejects", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      previewPng: { dataUrl: "data:image/png;base64,AAAA", w: 720, h: 560 },
    });

    expect(result.ok).toBe(false);
    expect(findGraph3DShapes(session)).toHaveLength(0);
  });

  it("attaches the supplied preview png as an overlay asset and stamps the source hash", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = insertRevolution(session, {
      // w/h は「実際に描かれたビットマップの寸法」なので、fixture の 1x1 PNG と一致させる。
      previewPng: { dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, w: 1, h: 1 },
    });

    expect(result.ok).toBe(true);
    const shape = findGraph3DShapes(session)[0];
    expect(shape.props.previewAssetId).toBe(`asset_graph3d_preview_${shape.id}`);
    expect(shape.props.previewSourceHash).toBe(getGraph3DPreviewSourceHash(shape.props.spec));
    const assets = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.assets ?? {};
    expect(assets[shape.props.previewAssetId!].props).toMatchObject({
      w: 1,
      h: 1,
      mimeType: "image/png",
      isAnimated: false,
    });
    expect((result.data as { preview: { source: string } }).preview.source).toBe("provided");
  });

  it("keeps id, position, anchor, size and unspecified spec fields on update", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session, { x: 120, y: 240, w: 400, h: 300 }).ok).toBe(true);
    const before = findGraph3DShapes(session)[0];

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId: before.id,
      objects: [{
        id: "updated_point",
        kind: "point",
        position: { x: "1", y: "2", z: "3" },
      }],
    });

    expect(result.ok).toBe(true);
    const after = findGraph3DShapes(session)[0];
    expect(after.id).toBe(before.id);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.props.w).toBe(before.props.w);
    expect(after.props.h).toBe(before.props.h);
    expect(after.props.spec.camera).toEqual(before.props.spec.camera);
    expect(after.props.spec.view).toEqual(before.props.spec.view);
    expect(after.props.spec.objects.map((object) => object.id)).toEqual(["updated_point"]);
    expect(after.props.spec.parameters).toEqual(before.props.spec.parameters);
  });

  it("leaves the preview hash alone when an update only resizes", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session, {
      previewPng: { dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, w: 1, h: 1 },
    }).ok).toBe(true);
    const before = findGraph3DShapes(session)[0];

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId: before.id,
      w: 500,
    });

    expect(result.ok).toBe(true);
    const after = findGraph3DShapes(session)[0];
    expect(after.props.spec).toBe(before.props.spec);
    // 内容が変わっていないのだから、プレビューが「更新待ち」に化けてはいけない。
    expect(after.props.previewSourceHash).toBe(getGraph3DPreviewSourceHash(after.props.spec));
    expect((result.data as { preview: { source: string } }).preview.source).toBe("unchanged");
  });

  it("never echoes the preview png bytes back in the tool result", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    const previewPng = { dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, w: 1, h: 1 };

    const inserted = insertRevolution(session, { previewPng });
    const shapeId = findGraph3DShapes(session)[0].id;
    const updated = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId,
      camera: { position: { x: 4, y: 4, z: 4 } },
      previewPng: { dataUrl: `data:image/png;base64,${PNG_2X2_BASE64}`, w: 2, h: 2 },
    });

    // 画像は文書に入る。それを結果でもう一度返すと、1回のツール応答でモデルのcontextが埋まる。
    expect(JSON.stringify(inserted.data)).not.toContain(PNG_1X1_BASE64);
    expect(JSON.stringify(updated.data)).not.toContain(PNG_2X2_BASE64);
    // 画像が付いたことは分かる必要がある。
    expect(JSON.stringify(inserted.data)).toContain(`asset_graph3d_preview_${shapeId}`);
  });

  it("keeps cuts that are already on the shape when an update only moves the camera", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session).ok).toBe(true);
    const shapeId = findGraph3DShapes(session)[0].id;
    // 断面は永続化されるがツールの語彙には無い。無関係な更新で黙って消してはいけない。
    putCutOnGraph3DShape(session, shapeId, {
      id: "cut_1",
      targetObjectIds: [],
      plane: { kind: "equation", expression: "z = 0" },
    });

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId,
      camera: { position: { x: 4, y: 4, z: 4 } },
    });

    expect(result.ok).toBe(true);
    const after = findGraph3DShapes(session)[0];
    expect(after.props.spec.cuts.map((cut) => cut.id)).toEqual(["cut_1"]);
    expect(after.props.spec.camera.position).toEqual({ x: 4, y: 4, z: 4 });
  });

  it("replaces the derived preview asset and refreshes the hash when an update changes the spec", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session, {
      previewPng: { dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`, w: 1, h: 1 },
    }).ok).toBe(true);
    const before = findGraph3DShapes(session)[0];

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId: before.id,
      objects: [{ id: "moved_point", kind: "point", position: { x: "1", y: "1", z: "1" } }],
      previewPng: { dataUrl: `data:image/png;base64,${PNG_2X2_BASE64}`, w: 2, h: 2 },
    });

    expect(result.ok).toBe(true);
    const after = findGraph3DShapes(session)[0];
    expect(after.props.previewAssetId).toBe(`asset_graph3d_preview_${after.id}`);
    expect(after.props.previewSourceHash).toBe(getGraph3DPreviewSourceHash(after.props.spec));
    expect(after.props.previewSourceHash).not.toBe(before.props.previewSourceHash);
    const assets = session.draftDocument.pageLayout?.overlay?.overlaySnapshot?.assets ?? {};
    expect(assets[after.props.previewAssetId!].props.src).toBe(`data:image/png;base64,${PNG_2X2_BASE64}`);
    // 同じidへ上書きするので、更新のたびに孤児assetが増えない。
    expect(Object.keys(assets)).toEqual([`asset_graph3d_preview_${after.id}`]);
    expect((result.data as { preview: { source: string } }).preview.source).toBe("provided");
  });

  it("refuses an update whose preview png the AI overlay asset gate rejects", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session).ok).toBe(true);
    const shapeId = findGraph3DShapes(session)[0].id;

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId,
      camera: { position: { x: 4, y: 4, z: 4 } },
      previewPng: { dataUrl: "data:image/png;base64,AAAA", w: 2, h: 2 },
    });

    expect(result.ok).toBe(false);
  });

  it("refuses an update that asks for nothing", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session).ok).toBe(true);
    const shapeId = findGraph3DShapes(session)[0].id;

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", { shapeId });

    expect(result.ok).toBe(false);
  });

  it("resizes on update when w/h are supplied", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(insertRevolution(session).ok).toBe(true);
    const shapeId = findGraph3DShapes(session)[0].id;

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId,
      w: 500,
      h: 400,
    });

    expect(result.ok).toBe(true);
    expect(findGraph3DShapes(session)[0].props).toMatchObject({ w: 500, h: 400 });
  });

  it("names the actual shape type when the update target is not a graph3dShape", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "p_1",
      id: "graph2d_target",
      curves: [{ id: "curve_target", expr: "x^2" }],
    }).ok).toBe(true);

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId: "graph2d_target",
      preset: "blank",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("graph3dShape");
    expect(result.message).toContain("graph2dShape");
  });

  it("reports a missing update target by id", () => {
    const session = createSigmaDocAgentSession({ document: createDocument(), selectedId: "p_1" });

    const result = executeSigmaDocAgentDraftTool(session, "draft_update_graph3d", {
      shapeId: "graph3d_missing",
      preset: "blank",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("graph3d_missing");
  });

  it("buildGraph3DSpecFromToolArgs replaces arrays, merges camera, and always clears cuts", () => {
    const base = createGraph3DSpecPreset("revolution", presetNames);

    const next = buildGraph3DSpecFromToolArgs(base, {
      objects: [{
        id: "only_point",
        kind: "point",
        position: { x: "0", y: "0", z: "0" },
      }],
      camera: { zoom: 2 },
    });

    expect(next.objects.map((object) => object.id)).toEqual(["only_point"]);
    expect(next.camera).toEqual({ ...base.camera, zoom: 2 });
    expect(next.cuts).toEqual([]);
    expect(next.regions).toEqual(base.regions);
    expect(next.annotations).toEqual(base.annotations);
    expect(next.parameters).toEqual(base.parameters);
  });

  it("buildGraph3DSpecFromToolArgs layers explicit fields on top of a supplied spec", () => {
    const base = createGraph3DSpecPreset("blank", presetNames);

    const next = buildGraph3DSpecFromToolArgs(base, {
      spec: {
        parameters: [],
        objects: [{ id: "spec_point", kind: "point", position: { x: "0", y: "0", z: "0" } }],
        regions: [],
        annotations: [],
        camera: {
          projection: "orthographic",
          position: { x: 1, y: 1, z: 1 },
          target: { x: 0, y: 0, z: 0 },
          up: { x: 0, y: 0, z: 1 },
        },
        view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#ffffff" },
      },
      view: { showGrid: false },
    });

    expect(next.objects.map((object) => object.id)).toEqual(["spec_point"]);
    expect(next.camera.projection).toBe("orthographic");
    expect(next.view.showGrid).toBe(false);
    expect(next.view.showAxes).toBe(true);
  });
});
