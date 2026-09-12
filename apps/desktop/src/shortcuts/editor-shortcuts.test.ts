import { describe, expect, it } from "vitest";

import { isInsertTextShapeAtCursorShortcut } from "./editor-shortcuts";

describe("editor shortcuts", () => {
  it("matches Cmd+Option+T by physical key code", () => {
    expect(isInsertTextShapeAtCursorShortcut(keyEvent({ altKey: true, metaKey: true, code: "KeyT", key: "†" }))).toBe(true);
  });

  it("matches Ctrl+Alt+T on non-Mac keyboards", () => {
    expect(isInsertTextShapeAtCursorShortcut(keyEvent({ altKey: true, ctrlKey: true, code: "KeyT", key: "t" }))).toBe(true);
  });

  it("does not match plain text shortcuts", () => {
    expect(isInsertTextShapeAtCursorShortcut(keyEvent({ metaKey: true, code: "KeyT", key: "t" }))).toBe(false);
    expect(isInsertTextShapeAtCursorShortcut(keyEvent({ altKey: true, code: "KeyT", key: "t" }))).toBe(false);
  });
});

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}
