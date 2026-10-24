import { describe, expect, it } from "vitest";

import { pocketShapeFixtures } from "../../../../tests/helpers/pocket-fixtures";
import {
  cloneOverlayShapesForPaste,
  createEditorClipboardHtml,
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  serializeEditorClipboardPayload,
} from "@/lib/editor-clipboard";

import { readPocketClipboardPayload } from "./pocket-content";
import { createPocketItem } from "./pocket-items";

const fixtures = pocketShapeFixtures();

describe("pocket content snapshots", () => {
  it.each(Object.entries(fixtures.shapes))("keeps %s independent of its source, preview and every pasted copy", (type, shape) => {
    const payload = createOverlayClipboardPayload([shape], fixtures.assets, "source");
    const serialized = serializeEditorClipboardPayload(payload);
    const source = { [EDITOR_CLIPBOARD_MIME]: serialized };
    const item = createPocketItem(source, { id: "pocket", addedAt: 1 })!;
    expect(item.transferTarget).toBe("page");
    expect(Object.isFrozen(item.clip)).toBe(true);

    source[EDITOR_CLIPBOARD_MIME] = "{}";
    payload.shapes[0].x = 900;
    if (item.preview.kind !== "shapes") throw new Error("Expected shapes");
    item.preview.shapes[0].x = 800;
    const restored = readPocketClipboardPayload(item.clip);
    if (restored?.kind !== "overlayShapes") throw new Error("Expected overlay payload");
    expect(restored.shapes[0]).toMatchObject({ type, x: shape.x });
    const first = cloneOverlayShapesForPaste(restored);
    const second = cloneOverlayShapesForPaste(readPocketClipboardPayload(item.clip) as typeof restored);
    expect(first.shapes[0].id).not.toBe(shape.id);
    expect(second.shapes[0].id).not.toBe(first.shapes[0].id);
    first.shapes[0].x = 700;
    expect(second.shapes[0].x).toBe(shape.x + 20);
    expect(item.clip[EDITOR_CLIPBOARD_MIME]).toBe(serialized);
  });

  it("uses HTML fallback for page routing and keeps mixed content on the text route", () => {
    const shapes = createOverlayClipboardPayload([fixtures.shapes.tableShape], {});
    const html = createPocketItem({ "text/html": createEditorClipboardHtml(shapes) }, { id: "html", addedAt: 1 });
    expect(html?.transferTarget).toBe("page");
    const mixed = createTextAndShapesClipboardPayload({ slice: { content: [] }, text: "本文" }, shapes.shapes, {});
    expect(createPocketItem({ [EDITOR_CLIPBOARD_MIME]: serializeEditorClipboardPayload(mixed) }, { id: "mixed", addedAt: 1 })?.transferTarget).toBe("caret");
    expect(createPocketItem({ "text/plain": "文章" }, { id: "text", addedAt: 1 })?.transferTarget).toBe("caret");
  });
});
