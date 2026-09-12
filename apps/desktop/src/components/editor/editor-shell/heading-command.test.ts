import { describe, expect, it, vi } from "vitest";

import { createEmptyEditorDocument } from "@/lib/blank-document";

import { handleHeadingCommandAutoNumbering } from "./heading-command";

const request = { triggerBlockId: "heading_1", level: 1 as const };

describe("handleHeadingCommandAutoNumbering", () => {
  it("enables numbering when the document has no saved configuration", () => {
    const document = createEmptyEditorDocument();
    const updatePageLayoutAndMetadata = vi.fn();

    expect(handleHeadingCommandAutoNumbering(document, updatePageLayoutAndMetadata, request)).toBe(true);
    expect(updatePageLayoutAndMetadata).toHaveBeenCalledOnce();
    expect(updatePageLayoutAndMetadata).toHaveBeenCalledWith(document.pageLayout, {
      ...document.metadata,
      headingNumbering: { enabled: true },
    });
  });

  it("preserves an explicitly disabled configuration", () => {
    const document = createEmptyEditorDocument();
    document.metadata.headingNumbering = { enabled: false };
    const updatePageLayoutAndMetadata = vi.fn();

    expect(handleHeadingCommandAutoNumbering(document, updatePageLayoutAndMetadata, request)).toBe(true);
    expect(updatePageLayoutAndMetadata).not.toHaveBeenCalled();
    expect(document.metadata.headingNumbering).toEqual({ enabled: false });
  });

  it("preserves an existing enabled configuration", () => {
    const document = createEmptyEditorDocument();
    document.metadata.headingNumbering = { enabled: true, style: "decimal", depth: 2 };
    const updatePageLayoutAndMetadata = vi.fn();

    expect(handleHeadingCommandAutoNumbering(document, updatePageLayoutAndMetadata, request)).toBe(true);
    expect(updatePageLayoutAndMetadata).not.toHaveBeenCalled();
    expect(document.metadata.headingNumbering).toEqual({ enabled: true, style: "decimal", depth: 2 });
  });
});
