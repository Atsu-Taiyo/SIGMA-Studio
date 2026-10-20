import { describe, expect, it } from "vitest";
import { ensurePageLayout } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import { isPristineUntitledDocument, isUntouchedNewDocument } from "./new-document-draft";

describe("untouched new documents", () => {
  it.each(["無題の教材 2", "無題の教材-2"])("recognizes workspace-created draft %s but retains saved or customized materials", title => {
    const blank = createBlankDocument(title);
    expect(isPristineUntitledDocument(blank, 1)).toBe(true);
    expect(isPristineUntitledDocument(blank, 2)).toBe(false);
    expect(isPristineUntitledDocument(createBlankDocument("残す教材"), 1)).toBe(false);
  });
  it("recognizes a workspace-created draft that inherited the previous material's page setup", () => {
    const blank = createBlankDocument("無題の教材 3");
    // Stored documents are normalized: a landscape A4 also has its width and height swapped.
    const inherited = ensurePageLayout({
      ...blank,
      metadata: { ...blank.metadata, headingNumbering: { enabled: true } },
      pageLayout: {
        ...blank.pageLayout!,
        orientation: "landscape" as const,
        header: { ...blank.pageLayout!.header!, enabled: true, blocks: [{ type: "paragraph" as const, id: "h", children: [{ type: "text" as const, text: "○○高校" }] }] },
      },
    });
    expect(isPristineUntitledDocument(inherited, 1)).toBe(true);
    expect(isPristineUntitledDocument(inherited, 2)).toBe(false);
    const written = { ...inherited, content: [{ type: "paragraph" as const, id: inherited.content[0].id, children: [{ type: "text" as const, text: "本文" }] }] };
    expect(isPristineUntitledDocument(written, 1)).toBe(false);
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
