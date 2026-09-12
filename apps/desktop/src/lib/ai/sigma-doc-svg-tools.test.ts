import { describe, expect, it } from "vitest";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "./sigma-doc-agent-tools";
import { assertAiOverlayAssetsInDocument } from "./sigma-doc-edit-schema";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="red"/><text x="10" y="40">面積</text></svg>';
const snapshotOf = (document: SigmaDocument) => normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);

describe("SVG image draft tools", () => {
  it.each([false, true])("inserts a valid image proposal without mutating the source (whiteboard=%s)", (whiteboard) => {
    const document = structuredClone(sampleDocument);
    if (whiteboard) { document.content = []; document.pageLayout = getDefaultPageLayout("whiteboard"); }
    const before = structuredClone(document);
    const session = createSigmaDocAgentSession({ document, selectedId: null });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_svg_image", {
      svg, targetId: whiteboard ? "CANVAS" : document.content[0].id, h: 100, name: "面積図",
    });
    expect(result.ok, result.message).toBe(true);
    expect(document).toEqual(before);
    expect(session.attachments).toEqual([]);
    const snapshot = snapshotOf(session.draftDocument);
    const shape = snapshot.shapes.at(-1)!;
    expect(shape).toMatchObject({ type: "image", props: { w: 200, h: 100 } });
    expect(shape.anchor?.type).toBe(whiteboard ? undefined : "block");
    expect(Object.values(snapshot.assets).at(-1)?.props).toMatchObject({ mimeType: "image/svg+xml", name: "面積図" });
    expect(() => assertAiOverlayAssetsInDocument(parseSigmaDocument(JSON.parse(JSON.stringify(session.draftDocument))))).not.toThrow();
    expect(session.operations).toHaveLength(1);
  });

  it("updates the same image while preserving placement, rotation, display size and anchor", () => {
    const session = createSigmaDocAgentSession({ document: structuredClone(sampleDocument), selectedId: sampleDocument.content[0].id });
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_svg_image", { svg, x: 80, y: 90, w: 180 }).ok).toBe(true);
    const original = snapshotOf(session.draftDocument).shapes.at(-1)!;
    const result = executeSigmaDocAgentDraftTool(session, "draft_update_svg_image", { shapeId: original.id, svg: svg.replace('red', 'blue') });
    expect(result.ok, result.message).toBe(true);
    const snapshot = snapshotOf(session.draftDocument);
    expect(snapshot.shapes.at(-1)).toEqual(original);
    expect(Object.keys(snapshot.assets)).toHaveLength(1);
    expect(Buffer.from(Object.values(snapshot.assets)[0].props.src.split(',')[1], 'base64').toString()).toContain('blue');
    expect(() => assertAiOverlayAssetsInDocument(session.draftDocument)).not.toThrow();
  });

  it("copies shared assets on update and leaves the duplicate unchanged", () => {
    const session = createSigmaDocAgentSession({ document: structuredClone(sampleDocument), selectedId: sampleDocument.content[0].id });
    executeSigmaDocAgentDraftTool(session, "draft_insert_svg_image", { svg });
    const originalSnapshot = snapshotOf(session.draftDocument);
    const shape = originalSnapshot.shapes.at(-1)!;
    session.draftDocument.pageLayout!.overlay!.overlaySnapshot!.shapes.push({ ...shape, id: "duplicate" });
    const updateSession = createSigmaDocAgentSession({ document: session.draftDocument, selectedId: null });
    expect(executeSigmaDocAgentDraftTool(updateSession, "draft_update_svg_image", { shapeId: shape.id, svg: svg.replace('red', 'blue') }).ok).toBe(true);
    const snapshot = snapshotOf(updateSession.draftDocument);
    expect(snapshot.shapes.find((s) => s.id === "duplicate")).toEqual({ ...shape, id: "duplicate" });
    expect(Object.keys(snapshot.assets)).toHaveLength(2);
    expect(snapshot.assets[Object.keys(originalSnapshot.assets)[0]]).toEqual(Object.values(originalSnapshot.assets)[0]);
  });

  it("rejects unsafe SVG atomically before creating a proposal", () => {
    const session = createSigmaDocAgentSession({ document: structuredClone(sampleDocument), selectedId: sampleDocument.content[0].id });
    const before = structuredClone(session.draftDocument);
    expect(executeSigmaDocAgentDraftTool(session, "draft_insert_svg_image", { svg: svg.replace('<rect', '<rect onload="alert(1)"') }).ok).toBe(false);
    expect(session.draftDocument).toEqual(before);
    expect(session.operations).toEqual([]);
    expect(session.attachments).toEqual([]);
  });
});
