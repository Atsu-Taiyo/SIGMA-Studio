import { describe, expect, it } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { ensurePageLayout } from "@/features/document";
import { createTableShapeProps } from "@/components/editor/overlay-canvas/shapes/table";
import { SharedDocument } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { cloneOverlayShapesForPaste, createOverlayClipboardPayload } from "@/lib/editor-clipboard";

/** Shared sessions validate every binary update before journal append and become read-only on failure. */
describe("pasting tables into a shared document", () => {
  it("passes journal/server validation and accepts the next edit after custom table borders are copied", () => {
    const document = ensurePageLayout(createBlankDocument("共有の表"));
    const props = createTableShapeProps("plain");
    props.table.grid.lineOverrides = [
      { axis: "horizontal", beforeRowId: props.table.rows[1].id, style: { borderStyle: "double" } },
      { axis: "vertical", beforeColumnId: props.table.columns[1].id, style: { visible: false } },
    ];
    document.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
      id: "table_shared_source", type: "tableShape", x: 100, y: 200, props,
    }] } };
    const server = new SharedDocument();
    server.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: "shared-table", epoch: 1 });
    const client = new SharedDocument(server.snapshot());
    try {
      const next = parseSigmaDocument(client.project());
      const snapshot = next.pageLayout!.overlay!.overlaySnapshot!;
      snapshot.shapes.push(...cloneOverlayShapesForPaste(createOverlayClipboardPayload(snapshot.shapes, {}), { x: 20, y: 20 }).shapes);
      client.change(client.project(), JSON.parse(JSON.stringify(next)) as ObjectValue);
      const update = client.difference(server.vector());
      // This is the exact validation used by DesktopCollaborationSessions.update and the server.
      const candidate = server.prepareUpdate(update, parseSigmaDocument);
      candidate.destroy();
      server.applyUpdate(update);
      expect(parseSigmaDocument(server.project()).pageLayout!.overlay!.overlaySnapshot!.shapes).toEqual(snapshot.shapes);
      next.metadata.title = "挿入後も保存できる";
      client.change(client.project(), JSON.parse(JSON.stringify(next)) as ObjectValue);
      const second = client.difference(server.vector());
      const secondCandidate = server.prepareUpdate(second, parseSigmaDocument);
      secondCandidate.destroy();
      server.applyUpdate(second);
      const reopened = new SharedDocument(server.snapshot());
      try {
        expect(parseSigmaDocument(reopened.project()).metadata.title).toBe("挿入後も保存できる");
        expect(parseSigmaDocument(reopened.project()).pageLayout!.overlay!.overlaySnapshot!.shapes).toEqual(snapshot.shapes);
      } finally { reopened.destroy(); }
    } finally { client.destroy(); server.destroy(); }
  });
});
