import { describe, expect, it } from "vitest";

import type { TextFlowBlock } from "../model";

import { preserveManualBreaksAfterTextEdit } from "./manual-break-preservation";

const paragraph = (
  id: string,
  breakBefore = false,
): Extract<TextFlowBlock, { type: "paragraph" }> => ({
  type: "paragraph",
  id,
  children: [],
  ...(breakBefore ? { pagination: { break: true } } : {}),
});

describe("preserveManualBreaksAfterTextEdit", () => {
  it("transfers a replaced owner's break to the first fresh replacement block", () => {
    expect(preserveManualBreaksAfterTextEdit(
      [paragraph("before"), paragraph("removed", true), paragraph("after")],
      [paragraph("before"), paragraph("pasted"), paragraph("after")],
    ).map((block) => [block.id, block.pagination?.break])).toEqual([
      ["before", undefined],
      ["pasted", true],
      ["after", undefined],
    ]);
  });

  it("retains the minimum nested container chain for a deleted layout break owner", () => {
    const previous: TextFlowBlock[] = [
      paragraph("before"),
      {
        type: "boxBlock",
        id: "box",
        styleId: "fancybox",
        blocks: [{
          type: "layoutSection",
          id: "layout",
          layout: { columnCount: 2 },
          children: [paragraph("column-one"), paragraph("column-two", true)],
        }],
      },
      paragraph("after"),
    ];

    const result = preserveManualBreaksAfterTextEdit(
      previous,
      [paragraph("before"), paragraph("after")],
      { retainDeletedOwners: true },
    );

    expect(result.map((block) => block.id)).toEqual(["before", "box", "after"]);
    expect(result[1]).toMatchObject({
      type: "boxBlock",
      blocks: [{
        id: "layout",
        children: [
          { id: "column-one" },
          { id: "column-two", pagination: { break: true } },
        ],
      }],
    });
  });
});
