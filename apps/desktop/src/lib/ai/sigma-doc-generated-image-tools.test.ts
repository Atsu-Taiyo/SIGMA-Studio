import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "./sigma-doc-agent-tools";
import { assertAiOverlayAssetsInDocument } from "./sigma-doc-edit-schema";

const imageId = "a".repeat(64);
const bytes = createCanvas(64, 32).toBuffer("image/png");
const generatedImage = { id: imageId, name: "Test image", mimeType: "image/png", width: 64, height: 32, fileSize: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
const snapshotOf = (document: SigmaDocument) => normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);

describe("generated image draft tools", () => {
  it.each([false, true])("inserts a persistent image with proportional dimensions and no source mutation (whiteboard=%s)", (whiteboard) => {
    const document = structuredClone(sampleDocument);
    if (whiteboard) { document.content = []; document.pageLayout = getDefaultPageLayout("whiteboard"); }
    const before = structuredClone(document);
    const session = createSigmaDocAgentSession({ document, selectedId: null });
    const args = { imageId, generatedImage, targetId: whiteboard ? "CANVAS" : document.content[0].id, h: 100 };
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_generated_image", args);
    expect(result.ok, result.message).toBe(true);
    expect(document).toEqual(before);
    const snapshot = snapshotOf(session.draftDocument);
    expect(snapshot.shapes.at(-1)).toMatchObject({ type: "image", props: { w: 200, h: 100 } });
    expect(snapshot.shapes.at(-1)?.anchor?.type).toBe(whiteboard ? undefined : "block");
    expect(Object.values(snapshot.assets).at(-1)?.props.src).toBe(generatedImage.dataUrl);
    expect(() => assertAiOverlayAssetsInDocument(parseSigmaDocument(JSON.parse(JSON.stringify(session.draftDocument))))).not.toThrow();
    executeSigmaDocAgentDraftTool(session, "draft_insert_generated_image", args);
    expect(snapshotOf(session.draftDocument).shapes).toEqual(snapshot.shapes);
  });

  it("replaces only the target's shared asset, preserving shape geometry and anchoring", () => {
    const session = createSigmaDocAgentSession({ document: structuredClone(sampleDocument), selectedId: sampleDocument.content[0].id });
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_generated_image", { imageId, generatedImage, x: 60, y: 90, w: 180 }).ok).toBe(true);
    const original = snapshotOf(session.draftDocument).shapes.at(-1)!;
    session.draftDocument.pageLayout!.overlay!.overlaySnapshot!.shapes.push({ ...original, id: "duplicate" });
    const updateSession = createSigmaDocAgentSession({ document: session.draftDocument, selectedId: null });
    const nextId = "b".repeat(64);
    const result = executeSigmaDocAgentDraftTool(updateSession, "draft_update_generated_image", { shapeId: original.id, imageId: nextId, generatedImage: { ...generatedImage, id: nextId, width: 32, height: 64 } });
    expect(result.ok, result.message).toBe(true);
    const snapshot = snapshotOf(updateSession.draftDocument);
    const updated = snapshot.shapes.find((shape) => shape.id === original.id)!;
    expect({ ...updated, props: original.props }).toEqual(original);
    expect(snapshot.shapes.find((shape) => shape.id === "duplicate")).toEqual({ ...original, id: "duplicate" });
    expect(Object.values(snapshot.assets)).toHaveLength(2);
    expect(() => assertAiOverlayAssetsInDocument(updateSession.draftDocument)).not.toThrow();
  });

  it("rejects a missing/mismatched result or non-image target without changing the draft", () => {
    const session = createSigmaDocAgentSession({ document: structuredClone(sampleDocument), selectedId: sampleDocument.content[0].id });
    const before = structuredClone(session.draftDocument);
    for (const args of [{ imageId }, { imageId, generatedImage: { ...generatedImage, id: "other" } }]) {
      expect(executeSigmaDocAgentDraftTool(session, "draft_insert_generated_image", args).ok).toBe(false);
    }
    expect(executeSigmaDocAgentDraftTool(session, "draft_update_generated_image", { imageId, generatedImage, shapeId: "missing" }).ok).toBe(false);
    expect(session.draftDocument).toEqual(before);
    expect(session.operations).toEqual([]);
  });
});
