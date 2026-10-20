import { Schema, type Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { textCaretAddress } from "@/features/text-editing";
import { retainedSelectionFingerprint } from "./retained-selection-fingerprint";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", attrs: { sigmaDocId: { default: null } } },
    text: { group: "inline" },
    mathInline: { group: "inline", inline: true, atom: true, attrs: { tex: {}, id: { default: null } } },
  },
  marks: { bold: {}, styledText: { attrs: { fontSize: {}, color: {} } } },
});
const paragraph = (id: string, text: string) => schema.node("paragraph", { sigmaDocId: id }, schema.text(text));
const document = (...blocks: Node[]) => schema.node("doc", null, blocks);
const original = document(paragraph("start", "abcdefgh"), paragraph("middle", "途中"), paragraph("end", "ijklmnop"));
const fingerprint = (docs: readonly Node[]) => retainedSelectionFingerprint(docs, textCaretAddress("start", 2), textCaretAddress("end", 4));

describe("retainedSelectionFingerprint", () => {
  it("ignores marks and their text-node boundaries", () => {
    const marked = schema.node("paragraph", { sigmaDocId: "start" }, [
      schema.text("ab"), schema.text("cd", [schema.mark("bold")]),
      schema.text("efgh", [schema.mark("styledText", { fontSize: 18, color: "#ff0000" })]),
    ]);
    expect(fingerprint([document(marked, original.child(1), original.child(2))])).toBe(fingerprint([original]));
  });

  it.each(["XXabcdefgh", "abcdfgh"])("detects insertion/deletion anywhere in an endpoint block: %s", text => {
    expect(fingerprint([document(paragraph("start", text), original.child(1), original.child(2))])).not.toBe(fingerprint([original]));
  });

  it("detects inline atom content even when textContent is identical", () => {
    const withMath = (tex: string) => document(
      schema.node("paragraph", { sigmaDocId: "start" }, [schema.text("abc"), schema.node("mathInline", { tex })]),
      original.child(1), original.child(2),
    );
    expect(withMath("x").textContent).toBe(withMath("y").textContent);
    expect(fingerprint([withMath("x")])).not.toBe(fingerprint([withMath("y")]));
  });

  it("ignores inline math marks and view IDs while retaining TeX", () => {
    const withMath = (id: string, marked: boolean) => document(
      schema.node("paragraph", { sigmaDocId: "start" }, [schema.text("abc"),
        schema.node("mathInline", { id, tex: "x" }, undefined, marked ? [schema.mark("bold")] : [])]),
      original.child(1), original.child(2),
    );
    expect(fingerprint([withMath("old", false)])).toBe(fingerprint([withMath("new", true)]));
  });

  it("includes intermediate blocks across separate documents and ignores surface boundaries", () => {
    expect(fingerprint([document(original.child(0)), document(original.child(1), original.child(2))])).toBe(fingerprint([original]));
    expect(fingerprint([document(original.child(0)), document(paragraph("middle", "変更")), document(original.child(2))])).not.toBe(fingerprint([original]));
  });

  it("detects changed block order, insertion, deletion and endpoint identity", () => {
    const before = fingerprint([original]);
    expect(fingerprint([document(original.child(2), original.child(1), original.child(0))])).not.toBe(before);
    expect(fingerprint([document(original.child(0), paragraph("new", "新"), original.child(1), original.child(2))])).not.toBe(before);
    expect(fingerprint([document(original.child(0), schema.node("paragraph", null, schema.text("匿名")), original.child(1), original.child(2))])).not.toBe(before);
    expect(fingerprint([document(original.child(0), original.child(2))])).not.toBe(before);
    expect(fingerprint([document(original.child(1), original.child(2))])).toBeNull();
    expect(fingerprint([original, original])).toBeNull();
  });

  it("ignores blocks outside the endpoint range and handles backward selection", () => {
    expect(fingerprint([document(paragraph("outside", "変更"), ...[0, 1, 2].map(i => original.child(i)))])).toBe(fingerprint([original]));
    expect(retainedSelectionFingerprint([original], textCaretAddress("end", 4), textCaretAddress("start", 2))).toBe(fingerprint([original]));
  });
});
