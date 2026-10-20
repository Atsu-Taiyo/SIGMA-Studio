import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { resolveTextSelectionBlockId } from "./text-selection-block";

const attrs = { sigmaDocId: { default: null } };
const schema = new Schema({ nodes: {
  doc: { content: "block+", attrs }, text: { group: "inline" },
  paragraph: { content: "inline*", group: "block", attrs },
  container: { content: "block+", group: "block", attrs },
  divider: { group: "block", attrs },
} });
const p = (id: string | null) => schema.node("paragraph", { sigmaDocId: id }, schema.text("本文"));

describe("resolveTextSelectionBlockId", () => {
  it("descends through nested containers for AllSelection, but preserves collapsed ancestor lookup", () => {
    const doc = schema.node("doc", null, [schema.node("container", { sigmaDocId: "outer" }, [
      schema.node("container", { sigmaDocId: "inner" }, [p("first")]),
    ]), p("last")]);
    expect(resolveTextSelectionBlockId(doc, 0, doc.content.size)).toBe("first");
    expect(resolveTextSelectionBlockId(doc, 0)).toBe("outer");
    expect(resolveTextSelectionBlockId(doc, 1)).toBe("outer");
    expect(resolveTextSelectionBlockId(doc, 4)).toBe("first");
  });
  it("preserves gap cursor and pointer positions before/after dividers and at document end", () => {
    const doc = schema.node("doc", null, [p("before"), schema.node("divider", { sigmaDocId: "rule" }), p("after")]);
    expect(resolveTextSelectionBlockId(doc, 4)).toBe("rule");
    expect(resolveTextSelectionBlockId(doc, 4, 4)).toBe("rule");
    expect(resolveTextSelectionBlockId(doc, 5)).toBe("after");
    expect(resolveTextSelectionBlockId(doc, doc.content.size)).toBe("after");
    expect(resolveTextSelectionBlockId(doc, 4, doc.content.size)).toBe("after");
    expect(resolveTextSelectionBlockId(doc, 4, 5)).toBeNull();
    expect(resolveTextSelectionBlockId(doc, 0, doc.content.size)).toBe("before");
  });
  it("uses nodeBefore when nodeAfter has no id, and includes the doc ancestor", () => {
    const doc = schema.node("doc", null, [p("before"), schema.node("divider"), p("after")]);
    expect(resolveTextSelectionBlockId(doc, 4)).toBe("before");
    const withId = schema.node("doc", { sigmaDocId: "root" }, [p("child")]);
    expect(resolveTextSelectionBlockId(withId, 0)).toBe("root");
  });
  it("uses the canonical list item id when the textblock has no id", () => {
    const doc = schema.node("doc", null, [schema.node("container", { sigmaDocId: "item" }, [p(null)])]);
    expect(resolveTextSelectionBlockId(doc, 0, doc.content.size)).toBe("item");
    expect(resolveTextSelectionBlockId(doc, 3)).toBe("item");
  });
});
