import { readFileSync } from "node:fs";
import path from "node:path";

import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OverlayAsset, OverlayImageShape, SigmaBlock, SigmaDocument } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import type { AiEditDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import type { AiEditPreviewState } from "../model/preview";
import {
  AI_PROPOSAL_PREVIEW_ID_PREFIX,
  buildAppliedProposalContent,
  buildPendingProposalContent,
  type AiProposalContent,
} from "../model/proposal-content";
import { resolveProposalMergePreview } from "../model/proposal-merge-preview";
import { AiProposalContentView } from "./AiProposalContentView";

function paragraph(id: string, text: string): SigmaBlock {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

function problem(id = "problem_1", options: { frame?: boolean } = {}): SigmaBlock {
  return {
    id,
    type: "problem",
    tags: [],
    lead: [],
    prompt: [paragraph(`${id}_prompt`, "問題文") as never],
    hints: [],
    solution: [paragraph(`${id}_solution`, "解答") as never],
    answer: { type: "math", expected: "" },
    numbering: { value: 4 },
    ...(options.frame ? { frame: { enabled: true } } : {}),
  } as SigmaBlock;
}

function documentOf(content: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_view",
    metadata: { title: "表示" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function previewOf(operations: AiEditDraft[], mutationOperations: SigmaDocMutationOp[] = []): AiEditPreviewState {
  return {
    targetId: operations[0]?.targetId ?? "",
    draft: {
      summary: "提案",
      plan: [],
      warnings: [],
      operations,
      ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
    },
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
  };
}

function pending(document: SigmaDocument, preview: AiEditPreviewState): AiProposalContent {
  return buildPendingProposalContent(document, resolveProposalMergePreview(document, preview).afterDocument, preview);
}

const BASE_CONTENT: SigmaBlock[] = [
  paragraph("p1", "変更前の問題文"),
  problem(),
  {
    id: "box_1",
    type: "boxBlock",
    styleId: "itembox",
    title: [{ type: "text", text: "要点" }],
    blocks: [paragraph("box_p", "箱の本文") as never],
  } as SigmaBlock,
  {
    id: "list_1",
    type: "list",
    listType: "ordered",
    items: [
      { type: "listItem", id: "li_1", children: [{ type: "text", text: "いち" }] },
      { type: "listItem", id: "li_2", children: [{ type: "text", text: "に" }] },
    ],
  } as SigmaBlock,
  {
    id: "layout_1",
    type: "layoutSection",
    layout: { columnCount: 2, columnStartIds: ["col_a", "col_b"] },
    children: [paragraph("col_a", "左の段") as never, paragraph("col_b", "右の段") as never],
  } as SigmaBlock,
];

const PROPOSALS: Array<[string, AiEditDraft]> = [
  ["置換", { operation: "replace", summary: "書き換え", targetId: "p1", replacementBlock: paragraph("p1", "変更後の問題文") as never }],
  ["挿入", { operation: "insertAfter", summary: "挿入", targetId: "p1", insertedBlock: paragraph("ins", "追加した段落") as never }],
  ["問題全体", { operation: "replace", summary: "問題", targetId: "problem_1", replacementBlock: problem("problem_1", { frame: true }) as never }],
  ["箱", {
    operation: "replace",
    summary: "箱",
    targetId: "box_1",
    replacementBlock: { ...BASE_CONTENT[2], title: [{ type: "text", text: "新しい要点" }] } as never,
  }],
  ["リスト", {
    operation: "replace",
    summary: "リスト",
    targetId: "list_1",
    replacementBlock: {
      ...BASE_CONTENT[3],
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "いち" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "にい" }] },
      ],
    } as never,
  }],
  ["段組み", {
    operation: "replace",
    summary: "段組み",
    targetId: "layout_1",
    replacementBlock: {
      ...BASE_CONTENT[4],
      children: [paragraph("col_a", "左の段を直した") as never, paragraph("col_b", "右の段") as never],
    } as never,
  }],
];

function parse(html: string) {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  return { container, close: () => window.close() };
}

/** 追加側の紙面描画 (`PrintBlock` が出す要素) のクラスの並び。 */
function addedPaperClassSequence(html: string): string[] {
  const { container, close } = parse(html);
  const paper = container.querySelector('[data-change="added"] .text-flow-editor');
  const classes = paper ? Array.from(paper.querySelectorAll("*")).map((element) => element.getAttribute("class") ?? "") : [];
  close();
  return classes;
}

function sigmaDocIds(html: string): string[] {
  return [...html.matchAll(/data-sigma-doc-id="([^"]*)"/g)].map((match) => match[1] ?? "");
}

function render(content: AiProposalContent, surface: "page" | "panel"): string {
  return renderToStaticMarkup(<AiProposalContentView content={content} surface={surface} />);
}

describe("AiProposalContentView", () => {
  it.each(PROPOSALS)("draws the %s proposal with the same PrintBlock DOM on the page and in the panel", (_label, draft) => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([draft]));

    const page = addedPaperClassSequence(render(content, "page"));
    const panel = addedPaperClassSequence(render(content, "panel"));

    expect(page.length).toBeGreaterThan(0);
    expect(panel).toEqual(page);
  });

  it("uses the shared print renderer for every kind of block", () => {
    const html = PROPOSALS
      .map(([, draft]) => render(pending(documentOf(BASE_CONTENT), previewOf([draft])), "page"))
      .join("");

    for (const className of ["print-paragraph", "print-problem-area with-frame", "print-problem-number", "print-box-block", "print-list", "print-layout-section"]) {
      expect(html).toContain(className);
    }
  });

  it("never repeats a document id the page itself carries", () => {
    const documentIds = new Set(["p1", "ins", "problem_1", "problem_1_prompt", "problem_1_solution", "box_1", "box_p", "list_1", "li_1", "li_2", "layout_1", "col_a", "col_b"]);
    for (const [, draft] of PROPOSALS) {
      const content = pending(documentOf(BASE_CONTENT), previewOf([draft]));
      for (const surface of ["page", "panel"] as const) {
        const ids = sigmaDocIds(render(content, surface));
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.filter((id) => documentIds.has(id))).toEqual([]);
        expect(ids.every((id) => id.startsWith(AI_PROPOSAL_PREVIEW_ID_PREFIX))).toBe(true);
      }
    }
  });

  it("keeps the layout section's columns after renaming its children", () => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([PROPOSALS[5][1]]));
    const { container, close } = parse(render(content, "page"));

    expect(container.querySelectorAll(".print-layout-section-column")).toHaveLength(2);
    close();
  });

  it("shows only the proposed side on the page and both sides in the panel", () => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([PROPOSALS[0][1]]));

    expect(render(content, "page")).not.toContain('data-change="removed"');
    expect(render(content, "page")).toContain('data-change="added"');
    const { container, close } = parse(render(content, "panel"));
    expect(container.querySelector('[data-change="removed"]')?.textContent).toContain("変更前の問題文");
    expect(container.querySelector('[data-change="added"]')?.textContent).toContain("変更後の問題文");
    close();
  });

  it("paints only the changed word and writes nothing into the document it was given", () => {
    const document = documentOf(BASE_CONTENT);
    const preview = previewOf([PROPOSALS[0][1]]);
    const documentBefore = structuredClone(document);
    const previewBefore = structuredClone(preview);

    const html = render(pending(document, preview), "panel");
    const painted = (side: string) => [...html.matchAll(new RegExp(`<span[^>]*background-color:var\\(--ai-proposal-word-${side}-mark, transparent\\)[^>]*>([^<]*)</span>`, "g"))]
      .map((match) => match[1]);

    expect(painted("removed")).toEqual(["前"]);
    expect(painted("added")).toEqual(["後"]);
    expect(document).toEqual(documentBefore);
    expect(preview).toEqual(previewBefore);
  });

  it("keeps a marker color under the highlight and lays the highlight over it as a separate layer", () => {
    const document = documentOf([{ id: "p1", type: "paragraph", children: [{ type: "text", text: "強調", backgroundColor: "#fff59d" }] }]);
    const html = render(pending(document, previewOf([{
      operation: "replace",
      summary: "マーカーの色を変える",
      targetId: "p1",
      replacementBlock: { id: "p1", type: "paragraph", children: [{ type: "text", text: "強調", backgroundColor: "#f8bbd0" }] } as never,
    }])), "panel");
    const css = readFileSync(path.join(import.meta.dirname, "AiProposalContentView.module.css"), "utf8");

    // 描かれる背景色は元のマーカー色のまま (印の変数は定義しないので既定値が使われる)。
    expect(html).toContain("background-color:var(--ai-proposal-word-removed-mark, #fff59d)");
    expect(html).toContain("background-color:var(--ai-proposal-word-added-mark, #f8bbd0)");
    // 差分の色は background-image として重ねる (半透明なので元の色が透ける)。背景色は上書きしない。
    for (const side of ["removed", "added"]) {
      const rule = new RegExp(`\\[style\\*="--ai-proposal-word-${side}-mark"\\][^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toContain(`background-image: linear-gradient(var(--ai-proposal-word-${side}), var(--ai-proposal-word-${side}))`);
      expect(rule).not.toContain("background-color");
    }
  });

  it.each([
    ["子の項目", "子の項目を直した", {
      type: "listItem",
      id: "li_1",
      children: [{ type: "text", text: "親の項目" }],
      nested: [{ id: "nested_1", type: "list", listType: "bullet", items: [{ type: "listItem", id: "li_1a", children: [{ type: "text", text: "子の項目を直した" }] }] }],
    }],
    ["続きの段落", "続きの段落を直した", {
      type: "listItem",
      id: "li_1",
      children: [{ type: "text", text: "親の項目" }],
      continuations: [{ id: "cont_1", type: "paragraph", children: [{ type: "text", text: "続きの段落を直した" }] }],
    }],
  ] as const)("draws a list item's %s, and paints the changed words on the line that is actually drawn", (_label, changedText, replacement) => {
    const document = documentOf([{
      id: "list_1",
      type: "list",
      listType: "ordered",
      items: [
        { type: "listItem", id: "li_0", children: [{ type: "text", text: "前の項目" }] },
        {
          type: "listItem",
          id: "li_1",
          children: [{ type: "text", text: "親の項目" }],
          nested: [{ id: "nested_1", type: "list", listType: "bullet", items: [{ type: "listItem", id: "li_1a", children: [{ type: "text", text: "子の項目" }] }] }],
          continuations: [{ id: "cont_1", type: "paragraph", children: [{ type: "text", text: "続きの段落" }] }],
        },
      ],
    } as SigmaBlock]);
    const preview = previewOf([{
      operation: "replace",
      summary: "項目を直す",
      targetId: "li_1",
      replacementBlock: {
        nested: [{ id: "nested_1", type: "list", listType: "bullet", items: [{ type: "listItem", id: "li_1a", children: [{ type: "text", text: "子の項目" }] }] }],
        continuations: [{ id: "cont_1", type: "paragraph", children: [{ type: "text", text: "続きの段落" }] }],
        ...replacement,
      } as never,
    }]);
    const content = pending(document, preview);

    for (const surface of ["page", "panel"] as const) {
      const { container, close } = parse(render(content, surface));
      const added = container.querySelector('[data-change="added"]');
      expect(added?.textContent).toContain("親の項目");
      expect(added?.textContent).toContain(changedText);
      // 塗りは変わった単語 (「直し」「た」) にだけ付き、変わらない親の行には付かない。
      const painted = Array.from(added?.querySelectorAll('[style*="--ai-proposal-word-added-mark"]') ?? [])
        .map((element) => element.textContent).join("");
      expect(painted.length).toBeGreaterThan(0);
      expect(changedText).toContain(painted.replace(/\s/g, "").slice(0, 2));
      expect(painted).not.toContain("親の項目");
      // 番号はリストの中の位置のまま (2 番目の項目)。
      expect(added?.querySelector("ol")?.getAttribute("start")).toBe("2");
      if (surface === "panel") {
        const removed = container.querySelector('[data-change="removed"]');
        expect(removed?.textContent).toContain(changedText.replace("を直した", ""));
      }
      close();
    }
  });

  it("labels an edit inside a problem with the area and the applied problem number", () => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([{
      operation: "insertAfter",
      summary: "問題文を追加",
      targetId: "problem_1_prompt",
      insertedBlock: paragraph("next_prompt", "新しい問題文") as never,
    }]));

    const html = render(content, "page");

    expect(html).toContain('data-problem-area="prompt"');
    expect(html).toMatch(/data-ai-proposal-area-label="">問4 問題文</);
    expect(html).toContain("新しい問題文");
  });

  it("names a change that carries no block content by its summary, with a generic fallback", () => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([], [
      { operation: "moveBlocks", summary: "箱を先頭へ移動", blockIds: ["box_1"], targetId: "p1", position: "before" },
    ]));
    const unknown: AiProposalContent = {
      hunks: [{ ...content.hunks[0]!, notes: [""] }],
      shapes: [],
    };

    expect(render(content, "page")).toContain("箱を先頭へ移動");
    expect(render(unknown, "page")).toContain("AI編集案");
  });

  it("draws an updated image's picture from the document's assets in the panel", () => {
    const asset: OverlayAsset = {
      id: "asset_1",
      type: "image",
      props: { w: 40, h: 30, name: "図.png", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 1 },
    };
    const image: OverlayImageShape = { id: "img_1", type: "image", x: 10, y: 20, rotation: 0, props: { assetId: "asset_1", w: 40, h: 30 } };
    const document = {
      ...documentOf(BASE_CONTENT),
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [image], assets: { asset_1: asset } } } },
    } as unknown as SigmaDocument;
    const content = pending(document, previewOf([], [
      { operation: "updateOverlayShape", summary: "画像を右へ", shapeId: "img_1", patch: { x: 120 } },
    ]));

    const html = render(content, "panel");

    expect(html.match(/href="data:image\/png;base64,AA=="/g)).toHaveLength(2);
  });

  it("draws an applied diff and a pending proposal through the same parts", () => {
    const applied = buildAppliedProposalContent({
      body: [
        { change: "removed", block: paragraph("p1", "変更前の問題文") as never },
        { change: "added", block: paragraph("p1", "変更後の問題文") as never },
      ],
      shapes: [],
    });
    const pendingContent = pending(documentOf(BASE_CONTENT), previewOf([PROPOSALS[0][1]]));

    expect(addedPaperClassSequence(render(applied, "panel"))).toEqual(addedPaperClassSequence(render(pendingContent, "panel")));
    expect(render(applied, "panel")).toContain("background-color:var(--ai-proposal-word-added-mark, transparent)");
  });

  it("lays the panel out at the page's column width before shrinking it", () => {
    const content = pending(documentOf(BASE_CONTENT), previewOf([PROPOSALS[0][1]]));

    const panel = renderToStaticMarkup(<AiProposalContentView content={content} surface="panel" paperWidthPx={500} />);

    expect(panel).toMatch(/class="[^"]*text-flow-editor[^"]*" style="width:500px/);
    expect(render(content, "page")).not.toMatch(/text-flow-editor[^"]*" style="width/);
  });

  it("renders nothing for empty content", () => {
    expect(render({ hunks: [], shapes: [] }, "panel")).toBe("");
  });

  it("has English labels for the before/after sides", () => {
    const t = createTranslator("en", "ai");

    expect(t("diff.before")).toBe("Before");
    expect(t("diff.after")).toBe("After");
  });
});
