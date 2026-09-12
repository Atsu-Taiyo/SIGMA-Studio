import { Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";

import {
  type AiEditLockInfo,
  createAiEditLockDecorations,
  handleAiEditLockStopButtonClick,
} from "./edit-lock-adapter";
import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";

const SigmaDocIdAttrs = Extension.create({
  name: "testSigmaDocIdAttrs",
  addGlobalAttributes() {
    return [{ types: ["paragraph", "heading"], attributes: { sigmaDocId: { default: null } } }];
  },
});

const schema = getSchema([
  StarterKit.configure({ undoRedo: false }),
  InlineMathExtension,
  SigmaDocIdAttrs,
]);

function createDoc(blocks: Array<{ id: string; text: string }>): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    blocks.map((block) => schema.nodes.paragraph.create({ sigmaDocId: block.id }, block.text ? schema.text(block.text) : undefined)),
  );
}

interface DecorationSpecLike {
  type: {
    spec?: Record<string, unknown>;
    attrs?: Record<string, string>;
  };
}

function decorationInfo(decoration: Decoration) {
  return (decoration as unknown as DecorationSpecLike).type;
}

describe("createAiEditLockDecorations", () => {
  it("decorates every locked block but renders one stop widget on the primary anchor", () => {
    const doc = createDoc([
      { id: "p1", text: "ab" },
      { id: "p2", text: "cd" },
      { id: "p3", text: "ef" },
    ]);
    const locks = new Map<string, AiEditLockInfo>([
      ["p1", { blockId: "p1", runId: "run-1", sessionLabel: "会話A", isPrimaryAnchor: true }],
      ["p2", { blockId: "p2", runId: "run-1", sessionLabel: "会話A", isPrimaryAnchor: false }],
    ]);
    const onRequestStop = vi.fn(async () => ({ ok: true }));

    const decorations = createAiEditLockDecorations(doc, locks, { onRequestStop }).find();

    const nodeDecorations = decorations.filter(
      (decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-locked-block",
    );
    expect(nodeDecorations).toHaveLength(2);
    expect(decorationInfo(nodeDecorations[0]).attrs).toMatchObject({
      class: "ai-edit-locked-block",
      "data-edit-guard-id": "run-1",
      contenteditable: "false",
      "aria-readonly": "true",
    });

    const charDecorations = decorations.filter(
      (decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-lock-char",
    );
    // "ab" and "cd" shimmer as one run; the unlocked "ef" block gets none.
    expect(charDecorations).toHaveLength(4);

    const widgetDecorations = decorations.filter((decoration) => decorationInfo(decoration).spec?.key);
    expect(widgetDecorations).toHaveLength(1);
    expect(decorationInfo(widgetDecorations[0]).spec).toMatchObject({ key: "edit-guard-action-p1-run-1" });
  });

  it("re-elects the first surviving target as stop-widget host when the primary block was deleted", () => {
    const doc = createDoc([
      { id: "p2", text: "cd" },
      { id: "p3", text: "ef" },
    ]);
    const locks = new Map<string, AiEditLockInfo>([
      ["p1", { blockId: "p1", runId: "run-1", sessionLabel: "会話A", isPrimaryAnchor: true }],
      ["p2", { blockId: "p2", runId: "run-1", sessionLabel: "会話A", isPrimaryAnchor: false }],
      ["p3", { blockId: "p3", runId: "run-1", sessionLabel: "会話A", isPrimaryAnchor: false }],
    ]);

    const decorations = createAiEditLockDecorations(doc, locks, { onRequestStop: vi.fn() }).find();
    const widgetDecorations = decorations.filter((decoration) => decorationInfo(decoration).spec?.key);

    expect(widgetDecorations).toHaveLength(1);
    expect(decorationInfo(widgetDecorations[0]).spec).toMatchObject({ key: "edit-guard-action-p2-run-1" });
  });

  it("produces no decorations when there are no locks", () => {
    const doc = createDoc([{ id: "p1", text: "ab" }]);
    const decorations = createAiEditLockDecorations(doc, new Map(), { onRequestStop: vi.fn() }).find();
    expect(decorations).toHaveLength(0);
  });

  it("keeps a pending proposal block read-only without rendering a nonexistent stop action", () => {
    const doc = createDoc([{ id: "p1", text: "ab" }]);
    const locks = new Map<string, AiEditLockInfo>([["p1", {
      blockId: "p1",
      runId: "pending-proposal",
      sessionLabel: null,
      isPrimaryAnchor: false,
      pendingProposal: true,
    }]]);

    const decorations = createAiEditLockDecorations(doc, locks, { onRequestStop: vi.fn() }).find();
    expect(decorations.some((decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-readonly-block")).toBe(true);
    expect(decorations.some((decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-lock-char")).toBe(false);
    expect(decorations.filter((decoration) => decorationInfo(decoration).spec?.key)).toHaveLength(0);
  });

  it("keeps a pending-proposal reservation invisible while shimmering only an explicit text range", () => {
    const doc = createDoc([
      { id: "p1", text: "abcd" },
      { id: "p2", text: "efgh" },
    ]);
    const locks = new Map<string, AiEditLockInfo>([
      ["p1", {
        blockId: "p1",
        runId: "run-1",
        sessionLabel: "会話A",
        isPrimaryAnchor: true,
        blockShimmerScopes: [{ kind: "text", blockId: "p1", from: 1, to: 2 }],
      }],
      ["p2", {
        blockId: "p2",
        runId: "pending-proposal",
        sessionLabel: null,
        isPrimaryAnchor: false,
        pendingProposal: true,
        blockShimmerScopes: [],
      }],
    ]);

    const decorations = createAiEditLockDecorations(doc, locks, { onRequestStop: vi.fn() }).find();
    const targetBlocks = decorations.filter(
      (decoration) => decorationInfo(decoration).attrs?.class?.split(" ").includes("ai-edit-locked-block"),
    );
    const readonlyBlocks = decorations.filter(
      (decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-readonly-block",
    );
    const shimmerChars = decorations.filter(
      (decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-lock-char",
    );

    expect(targetBlocks).toHaveLength(1);
    expect(decorationInfo(targetBlocks[0]).attrs?.class).toContain("ai-edit-locked-block-partial");
    expect(readonlyBlocks).toHaveLength(1);
    expect(shimmerChars).toHaveLength(1);
  });

  it("keeps the AI shimmer class while marking a locked math atom through the generic guard contract", () => {
    const mathNode = schema.nodes.mathInline.create({ id: "m1", tex: "x^2" });
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create({ sigmaDocId: "p1" }, [schema.text("a"), mathNode]),
    );
    const locks = new Map<string, AiEditLockInfo>([["p1", {
      blockId: "p1",
      runId: "run-1",
      sessionLabel: null,
      isPrimaryAnchor: true,
      blockShimmerScopes: [{ kind: "inlineMath", blockId: "p1", mathInlineId: "m1" }],
    }]]);

    const decorations = createAiEditLockDecorations(doc, locks, { onRequestStop: vi.fn() }).find();
    const atom = decorations.find(
      (decoration) => decorationInfo(decoration).attrs?.class === "ai-edit-lock-atom",
    );

    expect(atom).toBeDefined();
    expect(decorationInfo(atom!).attrs).toMatchObject({
      class: "ai-edit-lock-atom",
      "data-edit-guard-atom": "true",
    });
  });
});

// The hover "stop AI and edit" button itself is a plain DOM widget (see
// createAiEditLockStopButton) rendered through a PM widget decoration; this
// repo's vitest setup runs under `environment: "node"` with no jsdom
// available, so -- mirroring how the sibling page-break-gap-extension test
// only exercises the decoration specs, never the DOM factories -- the actual
// interaction/business logic behind the button (busy-guard, success/failure
// transitions, the "stop" call itself) lives in the plain state-machine
// function below and is tested directly, without any DOM.
describe("handleAiEditLockStopButtonClick", () => {
  const lock: AiEditLockInfo = {
    blockId: "p1",
    runId: "run-1",
    sessionLabel: "会話A",
    isPrimaryAnchor: true,
  };

  it("requests a stop with the given lock and transitions to busy + calls onStopped on success", async () => {
    const onRequestStop = vi.fn(async () => ({ ok: true }));
    const onStopped = vi.fn();

    const next = await handleAiEditLockStopButtonClick(lock, { status: "idle" }, { onRequestStop, onStopped });

    expect(onRequestStop).toHaveBeenCalledWith(lock);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(next).toEqual({ status: "busy" });
  });

  it("transitions to error (button re-enabled) when the stop request resolves not-ok", async () => {
    const onStopped = vi.fn();
    const next = await handleAiEditLockStopButtonClick(
      lock,
      { status: "idle" },
      { onRequestStop: async () => ({ ok: false }), onStopped },
    );

    expect(onStopped).not.toHaveBeenCalled();
    expect(next).toEqual({ status: "error" });
  });

  it("transitions to error when the stop request rejects", async () => {
    const next = await handleAiEditLockStopButtonClick(
      lock,
      { status: "idle" },
      {
        onRequestStop: async () => {
          throw new Error("network down");
        },
      },
    );

    expect(next).toEqual({ status: "error" });
  });

  it("ignores a click while already busy (connation guard) without calling onRequestStop again", async () => {
    const onRequestStop = vi.fn(async () => ({ ok: true }));

    const next = await handleAiEditLockStopButtonClick(lock, { status: "busy" }, { onRequestStop });

    expect(onRequestStop).not.toHaveBeenCalled();
    expect(next).toEqual({ status: "busy" });
  });

  it("allows retrying after a failed attempt", async () => {
    const onRequestStop = vi.fn(async () => ({ ok: true }));

    const errored = await handleAiEditLockStopButtonClick(
      lock,
      { status: "idle" },
      { onRequestStop: async () => ({ ok: false }) },
    );
    expect(errored).toEqual({ status: "error" });

    const next = await handleAiEditLockStopButtonClick(lock, errored, { onRequestStop });
    expect(onRequestStop).toHaveBeenCalledTimes(1);
    expect(next).toEqual({ status: "busy" });
  });
});
