import { readFileSync } from "node:fs";

import { Schema, type Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";

import { BLOCK_SPACE_AFTER_FOLLOWER_CLASS } from "@/features/document";

import { createSpaceAfterPreviewDecorations } from "./space-after-preview-decorations";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      attrs: { sigmaDocId: { default: "" } },
      toDOM: () => ["p", 0] as const,
    },
    text: {},
  },
});

function docOf(ids: readonly string[]): ProseMirrorModelNode {
  return schema.node(
    "doc",
    null,
    ids.map((id) => schema.node("paragraph", { sigmaDocId: id }, schema.text(id))),
  );
}

function decoratedIds(doc: ProseMirrorModelNode, set: DecorationSet): string[] {
  return set.find().map((decoration) => String(doc.nodeAt(decoration.from)?.attrs.sigmaDocId ?? ""));
}

function decoratedClasses(set: DecorationSet): string[] {
  return set.find().map((decoration) => (
    (decoration as unknown as { type: { attrs?: Record<string, string> } }).type.attrs?.class ?? ""
  ));
}

describe("createSpaceAfterPreviewDecorations", () => {
  it("marks only the blocks that follow the dragged one", () => {
    const doc = docOf(["p1", "p2", "p3"]);
    const set = createSpaceAfterPreviewDecorations(doc, {
      blockId: "p1",
      followerBlockIds: ["p2", "p3"],
    });

    expect(decoratedIds(doc, set)).toEqual(["p2", "p3"]);
    expect(decoratedClasses(set)).toEqual([
      BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
      BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
    ]);
  });

  it("leaves the dragged block alone — its own space is invisible, only the followers move", () => {
    const doc = docOf(["p1", "p2"]);
    const set = createSpaceAfterPreviewDecorations(doc, {
      blockId: "p1",
      followerBlockIds: ["p2"],
    });

    expect(decoratedIds(doc, set)).not.toContain("p1");
  });

  it("carries no px, so removing it can never strip the block's stored space", () => {
    const doc = docOf(["p1", "p2"]);
    const set = createSpaceAfterPreviewDecorations(doc, {
      blockId: "p1",
      followerBlockIds: ["p2"],
    });

    for (const decoration of set.find()) {
      const attrs = (decoration as unknown as { type: { attrs?: Record<string, string> } }).type.attrs;
      expect(attrs?.style).toBeUndefined();
    }
  });

  it("costs nothing when no drag is in flight (the common case: every transaction)", () => {
    expect(createSpaceAfterPreviewDecorations(docOf(["p1"]), null)).toBe(DecorationSet.empty);
  });

  it("costs nothing when the drag has no followers on this surface", () => {
    expect(createSpaceAfterPreviewDecorations(docOf(["p1"]), {
      blockId: "p1",
      followerBlockIds: [],
    })).toBe(DecorationSet.empty);
  });

  it("is the only place a surface turns the shared mark into a decoration", () => {
    // 印はモジュールのストアから **ブロック id で** 配られる。ページを跨いだ続きを描く複製は
    // 正本と同じ id の面をもう 1 つ作るので、面ごとに「描くかどうか」を決められないと、別の
    // ページにあるクリップ窓の中身まで一緒に平行移動する。判断は `TextFlowEditor` 側
    // (`isReplicaSurface`) にあり、この純関数は渡されたものをそのまま印にする。
    const source = readFileSync(new URL("../TextFlowEditor.tsx", import.meta.url), "utf8");
    const extension = source.slice(
      source.indexOf("const SpaceAfterPreviewExtension"),
      source.indexOf("function styleVarsToInlineCss"),
    );

    expect(extension).toContain("isReplicaSurface()");
    expect(extension).toContain("DecorationSet.empty");
  });

  it("ignores follower ids this surface does not draw", () => {
    const doc = docOf(["p1", "p2"]);
    const set = createSpaceAfterPreviewDecorations(doc, {
      blockId: "elsewhere",
      followerBlockIds: ["p2", "not_here"],
    });

    expect(decoratedIds(doc, set)).toEqual(["p2"]);
  });
});
