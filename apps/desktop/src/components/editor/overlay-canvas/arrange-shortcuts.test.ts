import { describe, expect, it } from "vitest";

import {
  getOverlayArrangeShortcutAction,
  overlayArrangeActionAllowsRepeat,
} from "./arrange-shortcuts";

describe("overlay arrange shortcuts", () => {
  it("maps Google Slides primary arrow shortcuts", () => {
    expect(action({ key: "ArrowUp", metaKey: true, shiftKey: true })).toBe("front");
    expect(action({ key: "ArrowDown", ctrlKey: true, shiftKey: true })).toBe("back");
    expect(action({ key: "ArrowUp", ctrlKey: true })).toBe("forward");
    expect(action({ key: "ArrowDown", metaKey: true })).toBe("backward");
  });

  it("accepts PowerPoint and legacy bracket aliases", () => {
    expect(action({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })).toBe("front");
    expect(action({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true })).toBe("back");
    expect(action({ key: "]", metaKey: true })).toBe("forward");
    expect(action({ key: "[", ctrlKey: true })).toBe("backward");
    expect(action({ key: "]" })).toBe("front");
    expect(action({ key: "[" })).toBe("back");
    expect(action({ key: "]", altKey: true })).toBe("forward");
    expect(action({ key: "[", altKey: true })).toBe("backward");
  });

  it("only repeats one-step moves", () => {
    expect(overlayArrangeActionAllowsRepeat("forward")).toBe(true);
    expect(overlayArrangeActionAllowsRepeat("backward")).toBe(true);
    expect(overlayArrangeActionAllowsRepeat("front")).toBe(false);
    expect(overlayArrangeActionAllowsRepeat("back")).toBe(false);
  });
});

function action({
  key,
  code = "",
  altKey = false,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
}: {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}) {
  return getOverlayArrangeShortcutAction({ altKey, code, ctrlKey, key, metaKey, shiftKey });
}
