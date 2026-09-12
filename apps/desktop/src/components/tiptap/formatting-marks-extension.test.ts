import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { createFormattingMarkDecorations } from "./formatting-marks-extension";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    heading: { content: "inline*", group: "block", toDOM: () => ["h1", 0] },
    hardBreak: { group: "inline", inline: true, selectable: false, toDOM: () => ["br"] },
    text: { group: "inline" },
  },
});

function kindsOf(doc: ReturnType<Schema["node"]>, placeholder = ""): string[] {
  return createFormattingMarkDecorations(doc, () => placeholder).find()
    .map((decoration) => String(decoration.spec.key ?? "").replace(/-\d+$/, ""));
}

describe("createFormattingMarkDecorations", () => {
  it("omits the paragraph mark on an empty editor that shows the placeholder", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    expect(kindsOf(doc, "Write here")).toEqual([]);
  });

  it("keeps the paragraph mark on an empty editor that does not show the placeholder", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    expect(kindsOf(doc, "")).toEqual(["formatting-paragraph"]);
  });

  it("keeps the paragraph mark on real body text", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello")]),
    ]);
    expect(kindsOf(doc, "Write here")).toEqual(["formatting-paragraph"]);
  });

  it("keeps the paragraph mark on an empty paragraph after real text", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello")]),
      schema.node("paragraph"),
    ]);
    expect(kindsOf(doc, "Write here")).toEqual([
      "formatting-paragraph",
      "formatting-paragraph",
    ]);
  });

  it("keeps a hard-break mark even next to typed text", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello"), schema.node("hardBreak")]),
    ]);
    expect(kindsOf(doc, "Write here")).toEqual([
      "formatting-line",
      "formatting-paragraph",
    ]);
  });
});
