import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { createHeadingNumberingDecorations } from "./heading-numbering-extension";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    heading: {
      attrs: {
        sigmaDocId: { default: "" },
        sigmaDocType: { default: "heading" },
      },
      content: "text*",
      group: "block",
      toDOM: () => ["h1", 0],
    },
    text: { group: "inline" },
  },
});

describe("createHeadingNumberingDecorations", () => {
  it("creates a non-document widget only for numbered headings and keys it by layout", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { sigmaDocId: "h1" }, schema.text("Title")),
      schema.node("heading", { sigmaDocId: "h2" }, schema.text("Other")),
    ]);
    const decorations = createHeadingNumberingDecorations(doc, { h1: "1" }, () => "column:2:40");
    const found = decorations.find();

    expect(found).toHaveLength(1);
    expect(found[0].spec).toMatchObject({
      blockId: "h1",
      key: "heading-number-h1-1-column:2:40",
    });
    expect(doc.textContent).toBe("TitleOther");
  });

  it("decorates a section projected as a level-1 heading", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { sigmaDocId: "section-1", sigmaDocType: "section" }, schema.text("Section")),
    ]);
    const decorations = createHeadingNumberingDecorations(doc, { "section-1": "1" });

    expect(decorations.find()).toHaveLength(1);
    expect(decorations.find()[0].spec).toMatchObject({
      blockId: "section-1",
      key: "heading-number-section-1-1-flow",
    });
  });
});
