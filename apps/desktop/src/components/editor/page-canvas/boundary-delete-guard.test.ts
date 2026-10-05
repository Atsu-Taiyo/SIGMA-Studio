import { describe, expect, it } from "vitest";

import type { SigmaBlock } from "@/features/document";
import { resolveTextFlowBoundaryDelete } from "@/features/text-editing";

import { findHiddenBoundaryDeleteBlockId, resolveVisibleBoundaryDelete } from "./boundary-delete-guard";

const paragraph = (id: string, text: string, breakBefore = false): SigmaBlock => ({
  id,
  type: "paragraph",
  children: [{ type: "text", text }],
  ...(breakBefore ? { pagination: { break: true } } : {}),
});

/** 畳んだ変更前 (folded) の前後に段落がある本文。 */
const content = [paragraph("first", "最初の段落"), paragraph("before", "前の段落"), paragraph("folded", "畳んだ変更前"), paragraph("after", "次の段落")];
const hidden = new Set(["folded"]);

function blockedBy(blockId: string, direction: "backward" | "forward", blocks = content): string | null {
  const deletion = resolveTextFlowBoundaryDelete(blocks, { direction, blockId, emptyBlock: false });
  if (!deletion) throw new Error("no deletion");
  return findHiddenBoundaryDeleteBlockId(deletion, hidden);
}

describe("boundary deletes next to a block folded out of the page", () => {
  it("refuses Backspace at the start of the next paragraph (it would join into the folded block)", () => {
    expect(blockedBy("after", "backward")).toBe("folded");
  });

  it("refuses Delete at the end of the previous paragraph (it would pull the folded block in)", () => {
    expect(blockedBy("before", "forward")).toBe("folded");
  });

  it("refuses moving the caret into the folded block across a manual break", () => {
    expect(blockedBy("before", "forward", [paragraph("before", "前の段落"), paragraph("folded", "畳んだ変更前", true)])).toBe("folded");
  });

  it("lets the deletes away from the folded block through", () => {
    expect(blockedBy("before", "backward")).toBeNull();
    expect(findHiddenBoundaryDeleteBlockId(
      resolveTextFlowBoundaryDelete(content, { direction: "backward", blockId: "after", emptyBlock: false })!,
      new Set(),
    )).toBeNull();
  });
});

describe("deleting an empty line next to a folded block", () => {
  const blocks = [paragraph("first", "最初の段落"), paragraph("folded", "畳んだ変更前"), paragraph("empty", ""), paragraph("after", "次の段落")];
  const resolve = (request: Parameters<typeof resolveTextFlowBoundaryDelete>[1]) => resolveTextFlowBoundaryDelete(blocks, request);

  it("deletes it and moves the caret to the nearest visible block instead of the folded one", () => {
    const outcome = resolveVisibleBoundaryDelete({ direction: "backward", blockId: "empty", emptyBlock: true }, resolve, hidden);

    expect(outcome).toMatchObject({ deletion: { previousIds: ["empty"], focusBlockId: "after", focusPosition: "start" } });
  });

  it("still refuses a join into the folded block", () => {
    expect(resolveVisibleBoundaryDelete({ direction: "backward", blockId: "after", emptyBlock: false }, (request) => resolveTextFlowBoundaryDelete(content, request), hidden))
      .toEqual({ blockedBlockId: "folded" });
  });

  it("leaves deletes away from folded blocks as they were", () => {
    const deletion = resolve({ direction: "backward", blockId: "after", emptyBlock: false });
    expect(resolveVisibleBoundaryDelete({ direction: "backward", blockId: "after", emptyBlock: false }, resolve, hidden)).toEqual({ deletion });
    expect(resolveVisibleBoundaryDelete({ direction: "backward", blockId: "first", emptyBlock: false }, resolve, hidden)).toBeNull();
  });
});
