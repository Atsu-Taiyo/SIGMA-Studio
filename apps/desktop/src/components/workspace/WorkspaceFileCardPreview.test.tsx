// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { WorkspaceFileCardPreview } from "./WorkspaceFileCardPreview";
import { loadWorkspacePreviewDocument, loadSharedWorkspacePreviewDocument } from "@/lib/workspace-repository";
import { lookupWorkspacePreviewImage, persistWorkspacePreviewImage } from "@/lib/workspace-preview-image";

vi.mock("@/components/print/paged-render/PagedThumbnailRenderer", () => ({ PagedThumbnailRenderer: ({ onRendered }: { onRendered: (image: string) => void }) => <button onClick={() => onRendered("data:image/png;base64,new")}>render preview</button> }));
vi.mock("@/lib/workspace-repository", () => ({ loadWorkspacePreviewDocument: vi.fn().mockResolvedValue(null), loadSharedWorkspacePreviewDocument: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/workspace-preview-image", () => ({ lookupWorkspacePreviewImage: vi.fn(), persistWorkspacePreviewImage: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.mocked(lookupWorkspacePreviewImage).mockResolvedValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { vi.useRealTimers(); Object.defineProperty(window, "desktopAPI", { configurable: true, value: undefined }); act(() => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("generates an unopened shared preview without opening its editable body or using stale revision caches", async () => {
  vi.mocked(loadSharedWorkspacePreviewDocument).mockResolvedValue(createBlankDocument("shared"));
  vi.mocked(lookupWorkspacePreviewImage).mockResolvedValue("data:image/png;base64,stale");
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={1} allowDocumentLoad={false} />));
  expect(loadSharedWorkspacePreviewDocument).toHaveBeenCalledWith("shared");
  expect(loadWorkspacePreviewDocument).not.toHaveBeenCalled();
  expect(lookupWorkspacePreviewImage).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,new");
  expect(persistWorkspacePreviewImage).not.toHaveBeenCalled();
});

it("does not show an old account thumbnail when shared access is unavailable", async () => {
  vi.mocked(loadSharedWorkspacePreviewDocument).mockResolvedValue(null);
  vi.mocked(lookupWorkspacePreviewImage).mockResolvedValue("data:image/png;base64,old-account");
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={1} allowDocumentLoad={false} />));
  expect(container.querySelector("img")).toBeNull();
  expect(loadWorkspacePreviewDocument).not.toHaveBeenCalled();
});

it("continues generating previews for local documents", async () => {
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="local" revision={1} />));
  expect(loadWorkspacePreviewDocument).toHaveBeenCalledWith("local");
});

it("reuses fresh shared thumbnails across remounts and refreshes after five minutes", async () => {
  vi.useFakeTimers();
  const getShared = vi.fn().mockResolvedValue({ token: "actor:document:version", dataUrl: "data:image/png;base64,cached", updatedAt: Date.now(), opened: false });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { workspacePreview: { getShared } } });
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={1} allowDocumentLoad={false} />));
  expect(container.querySelector("img")?.getAttribute("src")).toContain("cached");
  expect(loadSharedWorkspacePreviewDocument).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(270_000));
  expect(loadSharedWorkspacePreviewDocument).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(loadSharedWorkspacePreviewDocument).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: undefined });
});

it("refreshes previously opened previews after one minute and removes cached images on authorization failure", async () => {
  vi.useFakeTimers();
  const getShared = vi.fn().mockResolvedValue({ token: "actor:document:version", dataUrl: "data:image/png;base64,cached", updatedAt: Date.now(), opened: true });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { workspacePreview: { getShared } } });
  vi.mocked(loadSharedWorkspacePreviewDocument).mockRejectedValue(new Error("HTTP_403"));
  await act(async () => root.render(<WorkspaceFileCardPreview fileId="shared" revision={1} allowDocumentLoad={false} />));
  expect(container.querySelector("img")).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(loadSharedWorkspacePreviewDocument).toHaveBeenCalledTimes(1);
  expect(container.querySelector("img")).toBeNull();
});
