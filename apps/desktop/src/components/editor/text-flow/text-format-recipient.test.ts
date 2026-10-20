import { describe, expect, it } from "vitest";
import { resolveTextFormatRecipient } from "./text-format-recipient";

const source = { editor: "source", focused: false, replica: false, ownsSelectedBlock: true };
const replica = { editor: "replica", focused: true, replica: true, ownsSelectedBlock: true };

describe("text format recipient", () => {
  it("prefers the focused replica and keeps that recipient after focus changes", () => {
    const event = new Event("format");
    expect(resolveTextFormatRecipient(event, [source, replica])).toBe("replica");
    expect(resolveTextFormatRecipient(event, [{ ...source, focused: true }, { ...replica, focused: false }])).toBe("replica");
  });
  it("uses only the source when a toolbar input owns focus", () => {
    expect(resolveTextFormatRecipient(new Event("format"), [{ ...replica, focused: false }, source])).toBe("source");
    expect(resolveTextFormatRecipient(new Event("format"), [{ ...replica, focused: false }])).toBeNull();
  });
  it("waits for an unregistered running-region editor's listener", () => {
    const event = new Event("format");
    expect(resolveTextFormatRecipient(event, [source], true)).toBeNull();
    expect(resolveTextFormatRecipient(event, [source, { ...source, editor: "header", focused: true }], true)).toBe("header");
    const blurred = new Event("format");
    expect(resolveTextFormatRecipient(blurred, [{ ...source, ownsSelectedBlock: false }])).toBeNull();
    expect(resolveTextFormatRecipient(blurred, [{ ...source, editor: "header" }])).toBe("header");
  });
  it("ignores unrelated unfocused surfaces and chooses afresh for the next command", () => {
    expect(resolveTextFormatRecipient(new Event("format"), [{ ...source, ownsSelectedBlock: false }])).toBeNull();
    expect(resolveTextFormatRecipient(new Event("format"), [source, replica])).toBe("replica");
    expect(resolveTextFormatRecipient(new Event("format"), [source, { ...replica, focused: false }])).toBe("source");
  });
});
