// @vitest-environment happy-dom
import type { OverlayImageEntry } from "@/features/drawing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { OverlayImageRequest } from "../page-overlay-types";
import { createOverlayImageEntry } from "./image-file";
import type { OverlayShape } from "./types";
import { useOverlayImageImport } from "./use-image-import";
vi.mock("./image-file", () => ({ createOverlayImageEntry: vi.fn() }));

it("does not insert into the next document or acknowledge its request after an old decode completes", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (entry: OverlayImageEntry) => void; const pending = new Promise<OverlayImageEntry>(yes => { resolve = yes; });
  vi.mocked(createOverlayImageEntry).mockReturnValueOnce(pending);
  const shapesRef = { current: [] as OverlayShape[] }; const handled = vi.fn(); const setShapes = vi.fn(); const setAssets = vi.fn(); const save = vi.fn(); const noop = vi.fn();
  const ports = { shapesRef, setShapes, setAssets, assetsRef: { current: {} }, canvasWidthRef: { current: 800 }, canvasHeightRef: { current: 600 }, focusedGroupIdRef: { current: null }, imageInsertAreaWidth: 800, imageInsertAreaHeight: 600, setSelectedShapeIds: noop, transitionMode: noop, queueOverlaySave: save, onImageHandled: handled };
  function Harness({ documentId, request }: { documentId: string; request: OverlayImageRequest | null }) { useOverlayImageImport({ ...ports, documentId, imageRequest: request }); return null; }
  const root = createRoot(document.createElement("div")); const request = { id: 1, files: [new File(["x"], "image.png", { type: "image/png" })] };
  await act(async () => root.render(<Harness documentId="old" request={request} />));
  await act(async () => root.render(<Harness documentId="new" request={null} />));
  await act(async () => resolve({ asset: { id: "asset", type: "image", props: { w: 100, h: 50, name: "old", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 1 } }, shape: { id: "old-image", type: "image", x: 0, y: 0, props: { assetId: "asset", w: 100, h: 50 } } }));
  expect(setShapes).not.toHaveBeenCalled(); expect(setAssets).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(handled).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
