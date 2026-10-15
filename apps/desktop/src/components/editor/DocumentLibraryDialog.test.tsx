// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DocumentMetadata } from "@/lib/storage";
import { DocumentLibraryDialog } from "./DocumentLibraryDialog";

function props() {
  return {
    open: false, activeFileId: "file_1", activeDocumentTitle: "編集用教材", openFileIds: ["file_1"],
    documents: [{ fileId: "file_1", title: "編集用教材", updatedAt: "2026-10-15T00:00:00.000Z" }] as DocumentMetadata[],
    onClose: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
  };
}

describe("DocumentLibraryDialog", () => {
  it("does not inspect a large document list while closed", () => {
    const documents = new Proxy(new Array<DocumentMetadata>(54_000), {
      get() { throw new Error("A closed dialog must not read the library"); },
    });
    expect(renderToStaticMarkup(<DocumentLibraryDialog {...props()} documents={documents} />)).toBe("");
  });

  it("mounts actions on opening and discards a pending delete on closing", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const p = props();
    try {
      await act(async () => root.render(<DocumentLibraryDialog {...p} open />));
      const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
      const duplicate = buttons().find((button) => button.getAttribute("aria-label") === "複製");
      expect(duplicate).toBeDefined();
      act(() => duplicate!.click());
      expect(p.onDuplicate).toHaveBeenCalledWith("file_1");
      // Two files enable the per-document delete action.
      const second = { ...p.documents[0], fileId: "file_2", title: "もう一つ" };
      await act(async () => root.render(<DocumentLibraryDialog {...p} documents={[...p.documents, second]} open />));
      act(() => buttons().find((button) => button.getAttribute("aria-label") === "削除")!.click());
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(2);
      await act(async () => root.render(<DocumentLibraryDialog {...p} />));
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
      await act(async () => root.render(<DocumentLibraryDialog {...p} open />));
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
      expect(p.onDelete).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
