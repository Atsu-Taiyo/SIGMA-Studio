import { expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument, LOCAL_ORIGIN } from "../../src/features/collaboration/model/shared-document";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { documentImageReferences, mergedOperationId, mergeOperationUpdates, updateAssetReferences } from "./asset-repair";
import { CollaborationHttpError, isAssetRefusal, responseError } from "./transport";

function withImage(document: ObjectValue, key: string, src: string): void {
  const layout = document.pageLayout as ObjectValue;
  const snapshot = ((layout.overlay ??= { overlaySnapshot: { version: 1, shapes: [], assets: {} } }) as ObjectValue).overlaySnapshot as ObjectValue;
  (snapshot.shapes as ObjectValue[]).push({ id: `shape_${key}`, type: "image", x: 10, y: 20, props: { assetId: key, w: 64, h: 48 } });
  (snapshot.assets as ObjectValue)[key] = { id: key, type: "image",
    props: { w: 64, h: 48, name: `${key}.png`, isAnimated: false, mimeType: "image/png", src, fileSize: 8 } };
}
function withoutImage(document: ObjectValue, key: string): void {
  const snapshot = ((document.pageLayout as ObjectValue).overlay as ObjectValue).overlaySnapshot as ObjectValue;
  snapshot.shapes = (snapshot.shapes as ObjectValue[]).filter((shape) => shape.id !== `shape_${key}`);
  delete (snapshot.assets as ObjectValue)[key];
}

// #251: the images unsent edits need are the ones those edits write, including edits that an
// offline undo/redo later brings back.
it("finds the images unsent edits write: added, replaced, deleted and brought back by undo/redo", () => {
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue, { sharedDocumentId: "shared", epoch: 1 });
  const undo = shared.createUndoManager();
  const updates: Uint8Array[] = [];
  shared.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL_ORIGIN || origin === undo) updates.push(update);
  });
  const edit = (change: (document: ObjectValue) => void) => {
    const before = shared.project();
    const after = structuredClone(before);
    change(after);
    shared.change(before, after);
    undo.stopCapturing();
  };
  edit((document) => withImage(document, "asset_a", "sigma-doc-storage://image-a"));
  const added = updates.length;
  edit((document) => {
    const assets = (((document.pageLayout as ObjectValue).overlay as ObjectValue).overlaySnapshot as ObjectValue).assets as Record<string, ObjectValue>;
    (assets.asset_a.props as ObjectValue).src = "sigma-doc-storage://image-b";
  });
  edit((document) => withoutImage(document, "asset_a"));
  const deleted = updates.length;
  undo.undo();
  undo.redo();
  undo.undo();
  expect(JSON.stringify(shared.project())).toContain("sigma-doc-storage://image-b");
  expect([...updateAssetReferences(updates.slice(0, added))]).toEqual(["image-a"]);
  expect([...updateAssetReferences(updates)].sort()).toEqual(["image-a", "image-b"]);
  // The delete and the undo/redo write no image of their own: the image they bring back was written
  // by an earlier edit, which is still unsent or already on the server.
  expect([...updateAssetReferences(updates.slice(deleted - 1))]).toEqual([]);
  expect(updateAssetReferences([mergeOperationUpdates(updates)])).toEqual(new Set(["image-a", "image-b"]));
  shared.destroy();
});

it("reads every src as the server does, naming the images and the references it would refuse", () => {
  const document = JSON.parse(JSON.stringify(createBlankDocument())) as ObjectValue;
  withImage(document, "asset_ok", "sigma-doc-storage://image-ok");
  withImage(document, "asset_legacy", "sigma-doc-storage://workspaces/a/remote.png");
  expect(documentImageReferences(document)).toEqual([
    { ownerId: "asset_ok", name: "asset_ok.png", src: "sigma-doc-storage://image-ok", assetId: "image-ok" },
    { ownerId: "asset_legacy", name: "asset_legacy.png", src: "sigma-doc-storage://workspaces/a/remote.png" },
  ]);
});

it("gives the same merged operation the same id, so a lost acknowledgement is answered from the receipt", () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  expect(mergedOperationId(ids)).toBe(mergedOperationId([...ids]));
  expect(mergedOperationId(ids)).not.toBe(mergedOperationId([...ids].reverse()));
  expect(mergedOperationId(ids)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("reads what a refusal names, and nothing from servers that name nothing", async () => {
  const named = await responseError(Response.json({
    error: "MISSING_ASSET", missingAssetIds: ["image-a", "../escape", 7], invalidAssetReferences: ["asset_legacy"],
    operationId: "11111111-1111-4111-8111-111111111111",
  }, { status: 400 }));
  expect(named).toMatchObject({ message: "MISSING_ASSET", status: 400, details: {
    missingAssetIds: ["image-a"], invalidAssetReferences: ["asset_legacy"], operationId: "11111111-1111-4111-8111-111111111111",
  } });
  expect(isAssetRefusal(named)).toBe(true);
  const old = await responseError(Response.json({ error: "MISSING_ASSET" }, { status: 400 }));
  expect(old.details).toEqual({});
  expect(isAssetRefusal(old)).toBe(true);
  expect(isAssetRefusal(new CollaborationHttpError("INVALID_ASSET_REFERENCE", 400))).toBe(true);
  expect(isAssetRefusal(new CollaborationHttpError("INVALID_REQUEST", 400))).toBe(false);
  expect(isAssetRefusal(new CollaborationHttpError("MISSING_ASSET", 404))).toBe(false);
});
