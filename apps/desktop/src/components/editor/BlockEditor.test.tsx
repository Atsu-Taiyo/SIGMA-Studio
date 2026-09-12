import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TextFlowEditPolicy } from "@/components/tiptap/edit-guard-extension";
import type { ProblemNode } from "@/features/document";

vi.mock("@/components/editor/RichTextEditor", () => ({
  RichTextEditor: () => null,
}));

vi.mock("@/components/editor/TextFlowEditor", async () => {
  const { Schema } = await import("@tiptap/pm/model");
  const { createEditGuardDecorations } = await import("@/components/tiptap/edit-guard-extension");
  const { createElement } = await import("react");
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "text*",
        attrs: { sigmaDocId: { default: null } },
      },
      text: { group: "inline" },
    },
  });

  return {
    TextFlowEditor: ({
      blocks,
      editPolicy,
    }: {
      blocks: Array<{ id: string }>;
      editPolicy?: TextFlowEditPolicy;
    }) => {
      const doc = schema.nodes.doc.create(
        null,
        blocks.map((block) => schema.nodes.paragraph.create(
          { sigmaDocId: block.id },
          schema.text(block.id),
        )),
      );
      const guards = new Map((editPolicy?.guards ?? []).map((guard) => [guard.blockId, guard]));
      const decorationClasses = createEditGuardDecorations(doc, guards)
        .find()
        .flatMap((decoration) => {
          const attrs = (decoration as unknown as {
            type: { attrs?: Record<string, string> };
          }).type.attrs;
          return attrs?.class?.split(" ") ?? [];
        });
      const matchingGuard = editPolicy?.guards.find((guard) =>
        blocks.some((block) => block.id === guard.blockId));

      return createElement("div", {
        className: decorationClasses.join(" "),
        "data-edit-guard-block-id": matchingGuard?.blockId,
        "data-edit-guard-id": matchingGuard?.guardId,
        "data-text-flow-block-ids": blocks.map((block) => block.id).join(","),
      });
    },
  };
});

import { BlockEditor } from "./BlockEditor";
import { EditorExtensionProvider } from "./editor-extension-context";

const LOCKED_BLOCK_CLASS = "ai-edit-locked-block";

describe("BlockEditor text-flow edit policy", () => {
  it("renders the locked-block decoration for a guarded SigmaDoc problem-area block id", () => {
    const promptBlockId = "problem-prompt-paragraph";
    const problem: ProblemNode = {
      type: "problem",
      id: "problem-owner",
      tags: [],
      lead: [],
      prompt: [{
        type: "paragraph",
        id: promptBlockId,
        children: [{ type: "text", text: "問題文" }],
      }],
      hints: [],
      solution: [],
    };
    const editPolicy: TextFlowEditPolicy = {
      guards: [{
        blockId: promptBlockId,
        guardId: "ai-run-1",
        isPrimaryActionTarget: true,
        blockedMessage: "AI編集中です。",
        presentation: {
          highlightedBlockClassName: LOCKED_BLOCK_CLASS,
          readOnlyBlockClassName: "ai-edit-readonly-block",
          characterClassName: "ai-edit-lock-char",
          atomClassName: "ai-edit-lock-atom",
        },
        highlight: true,
      }],
    };

    const html = renderToStaticMarkup(
      <EditorExtensionProvider value={{ textFlowEditPolicy: editPolicy }}>
        <BlockEditor
          block={problem}
          selectedId={null}
          historyRevision={0}
          onSelect={() => undefined}
          onChange={() => undefined}
          onDelete={() => undefined}
          onDuplicate={() => undefined}
          onMove={() => undefined}
          onAddProblemBlock={() => undefined}
        />
      </EditorExtensionProvider>,
    );

    expect(html).toContain(LOCKED_BLOCK_CLASS);
    expect(html).toContain(`data-edit-guard-block-id="${promptBlockId}"`);
    expect(html).toContain('data-edit-guard-id="ai-run-1"');
  });

  it("passes editPolicy to every TextFlowEditor call site", () => {
    const source = readFileSync(new URL("./BlockEditor.tsx", import.meta.url), "utf8");
    const callSites = [...source.matchAll(/<TextFlowEditor\b[\s\S]*?\/>/g)].map((match) => {
      const precedingSource = source.slice(0, match.index);
      const functionName = [...precedingSource.matchAll(/^function\s+(\w+)\(/gm)].at(-1)?.[1];
      return {
        functionName,
        source: match[0],
      };
    });

    expect(callSites.map((callSite) => callSite.functionName)).toEqual([
      "QuoteBlockEditor",
      "CodeBlockEditor",
      "ListEditor",
      "BoxBlockEditor",
      "RichBlockList",
    ]);
    for (const callSite of callSites) {
      expect(callSite.source, callSite.functionName).toMatch(/\beditPolicy=\{editPolicy\}/);
    }
  });
});
