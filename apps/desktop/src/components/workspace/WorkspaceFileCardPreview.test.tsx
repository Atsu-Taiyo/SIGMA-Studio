// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceFileCardPreview } from "./WorkspaceFileCardPreview";
import { loadWorkspacePreviewDocument } from "@/lib/workspace-repository";
import { lookupWorkspacePreviewImage } from "@/lib/workspace-preview-image";

vi.mock("@/components/print/paged-render/PagedThumbnailRenderer", () => ({ PagedThumbnailRenderer: () => null }));
vi.mock("@/lib/workspace-repository", () => ({ loadWorkspacePreviewDocument: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/workspace-preview-image", () => ({ lookupWorkspacePreviewImage: vi.fn(), persistWorkspacePreviewImage: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.mocked(lookupWorkspacePreviewImage).mockResolvedValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("listing an unopened shared card never loads its body", async () => {
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={1} allowDocumentLoad={false} />));
  expect(lookupWorkspacePreviewImage).toHaveBeenCalledWith("shared", 1);
  expect(loadWorkspacePreviewDocument).not.toHaveBeenCalled();
  expect(container.querySelector("[data-preview-state]")?.getAttribute("data-preview-state")).toBe("idle");
});

it("uses a saved shared thumbnail without opening a session", async () => {
  vi.mocked(lookupWorkspacePreviewImage).mockResolvedValue("data:image/png;base64,AAAA");
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={2} allowDocumentLoad={false} />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(loadWorkspacePreviewDocument).not.toHaveBeenCalled();
});

it("continues generating previews for local documents", async () => {
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="local" revision={1} />));
  expect(loadWorkspacePreviewDocument).toHaveBeenCalledWith("local");
});
