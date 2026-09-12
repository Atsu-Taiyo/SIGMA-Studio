// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE } from "@/features/document";

import {
  beginBlockSpaceAfterPreview,
  endBlockSpaceAfterPreview,
  getBlockSpaceAfterPreview,
  registerBlockSpaceAfterPreviewRoot,
  setBlockSpaceAfterPreviewDeltaPx,
  subscribeBlockSpaceAfterPreview,
} from "./block-space-after-preview";

const unregisters: Array<() => void> = [];

function root(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  unregisters.push(registerBlockSpaceAfterPreviewRoot(element));
  return element;
}

function readDelta(element: HTMLElement): string {
  return element.style.getPropertyValue(BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE);
}

afterEach(() => {
  endBlockSpaceAfterPreview();
  while (unregisters.length > 0) {
    unregisters.pop()?.();
  }
  document.body.innerHTML = "";
});

describe("block space-after preview store", () => {
  it("starts empty", () => {
    expect(getBlockSpaceAfterPreview()).toBeNull();
  });

  it("holds the cohort the drag decided at pointerdown", () => {
    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2", "p3"] });

    expect(getBlockSpaceAfterPreview()).toEqual({ blockId: "p1", followerBlockIds: ["p2", "p3"] });
  });

  it("never notifies subscribers while the pointer moves", () => {
    const element = root();
    const listener = vi.fn();
    subscribeBlockSpaceAfterPreview(listener);

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    for (let px = 1; px <= 100; px += 1) {
      setBlockSpaceAfterPreviewDeltaPx(px);
    }
    endBlockSpaceAfterPreview();

    // 1 ドラッグにつき begin と end の 2 回きり。ここが増えると pointermove ごとに
    // 紙面全体の ProseMirror 装飾が走り直す (= 直したかった重さそのもの)。
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readDelta(element)).toBe("");
  });

  it("writes the pointer's travel onto every registered root", () => {
    const first = root();
    const second = root();

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    setBlockSpaceAfterPreviewDeltaPx(42);

    expect(readDelta(first)).toBe("42px");
    expect(readDelta(second)).toBe("42px");
  });

  it("gives a root registered mid-drag the value already in flight", () => {
    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    setBlockSpaceAfterPreviewDeltaPx(17);
    const late = root();

    expect(readDelta(late)).toBe("17px");
  });

  it("clears the variable when the drag ends", () => {
    const element = root();

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    setBlockSpaceAfterPreviewDeltaPx(24);
    endBlockSpaceAfterPreview();

    expect(getBlockSpaceAfterPreview()).toBeNull();
    expect(readDelta(element)).toBe("");
  });

  it("ends only once, even if asked twice", () => {
    const listener = vi.fn();
    subscribeBlockSpaceAfterPreview(listener);

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    endBlockSpaceAfterPreview();
    endBlockSpaceAfterPreview();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores a delta when no drag is in flight", () => {
    const element = root();

    setBlockSpaceAfterPreviewDeltaPx(30);

    expect(readDelta(element)).toBe("");
  });

  it("leaves nothing on an unregistered root", () => {
    const element = document.createElement("div");
    const unregister = registerBlockSpaceAfterPreviewRoot(element);

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });
    setBlockSpaceAfterPreviewDeltaPx(12);
    unregister();
    setBlockSpaceAfterPreviewDeltaPx(24);

    expect(readDelta(element)).toBe("");
  });

  it("stops calling a listener that unsubscribed", () => {
    const listener = vi.fn();
    subscribeBlockSpaceAfterPreview(listener)();

    beginBlockSpaceAfterPreview({ blockId: "p1", followerBlockIds: ["p2"] });

    expect(listener).not.toHaveBeenCalled();
  });
});
