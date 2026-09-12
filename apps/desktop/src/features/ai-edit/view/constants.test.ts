import { describe, expect, it } from "vitest";

import {
  AI_APPLY_ADD_FLASH_MS as publicApplyAddFlashMs,
  AI_APPLY_REMOVE_ANIMATION_MS as publicApplyRemoveAnimationMs,
  AI_SIDEBAR_WIDTH as publicSidebarWidth,
} from "@/features/ai-edit";

import {
  AI_APPLY_ADD_FLASH_MS,
  AI_APPLY_REMOVE_ANIMATION_MS,
  AI_SIDEBAR_WIDTH,
} from "./constants";

describe("AI edit view constants", () => {
  it("keeps animation timings and sidebar geometry stable", () => {
    expect(AI_APPLY_REMOVE_ANIMATION_MS).toBe(280);
    expect(AI_APPLY_ADD_FLASH_MS).toBe(1200);
    expect(AI_SIDEBAR_WIDTH).toBe(380);
  });

  it("exposes the canonical values unchanged from the public AI entrypoint", () => {
    expect(publicApplyRemoveAnimationMs).toBe(AI_APPLY_REMOVE_ANIMATION_MS);
    expect(publicApplyAddFlashMs).toBe(AI_APPLY_ADD_FLASH_MS);
    expect(publicSidebarWidth).toBe(AI_SIDEBAR_WIDTH);
  });
});
