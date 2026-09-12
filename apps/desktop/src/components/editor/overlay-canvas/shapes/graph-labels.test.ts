import { describe, expect, it } from "vitest";

import {
  getGraphAxisLabelSpecText as getCanonicalGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey as getCanonicalGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText as getCanonicalOverlayRichTextLabelText,
} from "@/features/document";

import {
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getTiptapLabelText,
} from "./graph-labels";

describe("graph label compatibility exports", () => {
  it("delegates read models to the canonical document feature", () => {
    expect(getGraphAxisLabelSpecText).toBe(getCanonicalGraphAxisLabelSpecText);
    expect(getGraphAxisLabelTextsByKey).toBe(getCanonicalGraphAxisLabelTextsByKey);
    expect(getOverlayTextBlocksLabelText).toBe(getCanonicalOverlayRichTextLabelText);
    expect(getTiptapLabelText).toBe(getCanonicalOverlayRichTextLabelText);
  });
});
