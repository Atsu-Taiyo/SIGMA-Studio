import { describe, expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { isPristineUntitledDocument, isUntouchedNewDocument } from "./new-document-draft";

describe("untouched new documents", () => {
  it("recognizes workspace-created drafts but retains saved or customized materials", () => {
    const blank = createBlankDocument("無題の教材 2");
    expect(isPristineUntitledDocument(blank, 1)).toBe(true);
    expect(isPristineUntitledDocument(blank, 2)).toBe(false);
    expect(isPristineUntitledDocument(createBlankDocument("残す教材"), 1)).toBe(false);
    expect(isPristineUntitledDocument({ ...blank, pageLayout: { ...blank.pageLayout!, orientation: "landscape" } }, 1)).toBe(false);
  });
  it("allows empty text normalization and save timestamps", () => {
    const initial = createBlankDocument("無題の教材 2");
    const current = { ...initial, updatedAt: "2026-09-07T00:00:00Z", content: [{ ...initial.content[0], children: [] }] };
    expect(isUntouchedNewDocument(initial, current)).toBe(true);
  });
  it("retains renamed, written, formatted, and imported documents", () => {
    const initial = createBlankDocument();
    expect(isUntouchedNewDocument(initial, { ...initial, metadata: { ...initial.metadata, title: "保存する教材" } })).toBe(false);
    const written = { ...initial, content: [{ id: "p", type: "paragraph" as const, children: [{ type: "text" as const, text: "朝" }] }] };
    expect(isUntouchedNewDocument(initial, written)).toBe(false);
    expect(isUntouchedNewDocument(written, written)).toBe(false);
    expect(isUntouchedNewDocument(initial, { ...initial, pageLayout: { ...initial.pageLayout!, orientation: "landscape" } })).toBe(false);
  });
});
