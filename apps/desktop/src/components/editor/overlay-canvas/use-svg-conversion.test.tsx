// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import { useSvgConversion } from "./use-svg-conversion";

afterEach(() => vi.unstubAllGlobals());

it.each(["document switch", "unmount", "asset replacement", "new lock"])("does not commit a delayed SVG after %s", async (change) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((yes) => { resolve = yes; });
  vi.stubGlobal("fetch", vi.fn(() => pending));
  const shapesRef = { current: [{ id: "image", type: "image", x: 0, y: 0, props: { assetId: "asset", w: 200, h: 100 } }] as OverlayShape[] };
  const asset: OverlayAsset = { id: "asset", type: "image", props: { w: 200, h: 100, name: "SVG", mimeType: "image/svg+xml",
    isAnimated: false, src: "sigma-doc-storage://asset", fileSize: 100 } };
  const assetsRef = { current: { asset } };
  const commit = vi.fn(), setShapes = vi.fn(), setAssets = vi.fn(), blocked = vi.fn();
  const locks = { current: new Set<string>() };
  let action!: (id: string) => Promise<void>;
  const ports = { shapesRef, assetsRef, extensionsRef: { current: undefined }, editPolicyLockedShapeIdsRef: locks,
    explicitlySavedShapeStatesRef: { current: new WeakSet<OverlayShape[]>() }, notifyEditPolicyBlocked: blocked,
    setShapes, setAssets, setSelectedShapeIds: vi.fn(), commitOverlayChangeNow: commit,
    readAssetSource: async () => "blob:svg", tShape: createTranslator("ja", "shape") };
  function Harness({ docId }: { docId: string }) { action = useSvgConversion({ ...ports, documentId: docId }).convertSvg; return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness docId="old" />));
  let conversion!: Promise<void>;
  await act(async () => { conversion = action("image"); });
  if (change === "document switch") await act(async () => root.render(<Harness docId="new" />));
  if (change === "unmount") await act(async () => root.unmount());
  if (change === "asset replacement") assetsRef.current = { asset: { ...asset, props: { ...asset.props, src: "data:image/svg+xml,new" } } };
  if (change === "new lock") locks.current.add("image");
  await act(async () => {
    resolve(new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="20" y="20" width="40" height="40"/></svg>'));
    await conversion;
  });
  expect(commit).not.toHaveBeenCalled();
  expect(setShapes).not.toHaveBeenCalled();
  expect(setAssets).not.toHaveBeenCalled();
  expect(shapesRef.current[0].type).toBe("image");
  if (change === "new lock") expect(blocked).toHaveBeenCalledOnce();
  if (change !== "unmount") await act(async () => root.unmount());
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="20" y="20" width="40" height="40"/></svg>';
function sharedFixture(readAssetSource: (source: string) => Promise<string>) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const shapesRef = { current: [{ id: "image", type: "image", x: 0, y: 0, props: { assetId: "asset", w: 200, h: 100 } }] as OverlayShape[] };
  // A shared document keeps only the storage reference; the renderer cannot fetch that scheme.
  const asset: OverlayAsset = { id: "asset", type: "image", props: { w: 200, h: 100, name: "SVG", mimeType: "image/svg+xml",
    isAnimated: false, src: "sigma-doc-storage://asset?ready=2", fileSize: 100 } };
  const ports = { shapesRef, assetsRef: { current: { asset } }, extensionsRef: { current: undefined },
    editPolicyLockedShapeIdsRef: { current: new Set<string>() }, explicitlySavedShapeStatesRef: { current: new WeakSet<OverlayShape[]>() },
    notifyEditPolicyBlocked: vi.fn(), setShapes: vi.fn(), setAssets: vi.fn(), setSelectedShapeIds: vi.fn(), commitOverlayChangeNow: vi.fn(),
    readAssetSource, tShape: createTranslator("ja", "shape") };
  const result: { convert?: (id: string) => Promise<void>; message?: string | null } = {};
  function Harness() { const api = useSvgConversion(ports); result.convert = api.convertSvg; result.message = api.svgConversionMessage; return null; }
  return { ports, result, Harness };
}

it("converts a shared document's SVG after reading its storage reference through the session", async () => {
  const read = vi.fn(async () => `data:image/svg+xml;base64,${btoa(SVG)}`);
  const { ports, result, Harness } = sharedFixture(read);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await act(async () => { await result.convert!("image"); });
  expect(read).toHaveBeenCalledWith("sigma-doc-storage://asset?ready=2");
  expect(ports.commitOverlayChangeNow).toHaveBeenCalledOnce();
  expect(ports.shapesRef.current).toMatchObject([{ id: "image", type: "geo", props: { geo: "rectangle", w: 42, h: 42 } }]);
  expect(result.message).toContain("1個の図形に変換しました");
  await act(async () => root.unmount());
});

it("keeps the image and reports a read failure when the shared asset cannot be read", async () => {
  const { ports, result, Harness } = sharedFixture(async () => { throw new Error("MISSING_ASSET"); });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await act(async () => { await result.convert!("image"); });
  expect(ports.commitOverlayChangeNow).not.toHaveBeenCalled();
  expect(ports.shapesRef.current[0].type).toBe("image");
  expect(result.message).toBe(createTranslator("ja", "shape")("svgConversion.source"));
  await act(async () => root.unmount());
});
