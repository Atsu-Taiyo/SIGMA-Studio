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
    resolveAssetSource: () => "blob:svg", tShape: createTranslator("ja", "shape") };
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
