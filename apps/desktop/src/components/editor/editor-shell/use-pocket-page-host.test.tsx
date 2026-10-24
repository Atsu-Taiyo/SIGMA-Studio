// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pocketShapeFixtures } from "../../../../tests/helpers/pocket-fixtures";
import { getPocketPageHost } from "@/features/pocket/application/pocket-drag";
import { addToPocket, resetPocketForTests } from "@/features/pocket/application/pocket-store";
import { insertPocketItem } from "@/features/pocket/application/pocket-transfer";
import { createPocketItem } from "@/features/pocket/model/pocket-items";
import { createOverlayClipboardPayload, createTextFlowClipboardPayload, EDITOR_CLIPBOARD_MIME, serializeEditorClipboardPayload, type EditorClipboardPayload } from "@/lib/editor-clipboard";

import { usePocketPageHost } from "./use-pocket-page-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipOf = (payload: EditorClipboardPayload) => ({ [EDITOR_CLIPBOARD_MIME]: serializeEditorClipboardPayload(payload) });
const fixtures = pocketShapeFixtures();

describe("pocket page host", () => {
  let root: Root;
  let container: HTMLDivElement;
  const requestOverlayAction = vi.fn();
  const getViewportCenter = vi.fn(() => ({ x: 400, y: 500 }));

  function Host({ bodyless = false }: { bodyless?: boolean }) {
    usePocketPageHost({ ownsInput: () => true, ownsDropLocation: () => true, bodyless, requestOverlayAction, getViewportCenter });
    return null;
  }

  beforeEach(() => {
    resetPocketForTests();
    vi.clearAllMocks();
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    resetPocketForTests();
  });

  it.each(Object.entries(fixtures.shapes))("inserts %s through the page action while a cell or text editor keeps focus", async (type, shape) => {
    await act(async () => root.render(<Host />));
    const outcome = addToPocket(clipOf(createOverlayClipboardPayload([shape], fixtures.assets, "source")));
    if (!outcome.ok) throw new Error(outcome.reason);
    const editor = document.body.appendChild(document.createElement("div"));
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    editor.focus();
    const paste = vi.fn();
    editor.addEventListener("paste", paste);

    expect(insertPocketItem(outcome.item.id)).toBe("inserted");
    expect(insertPocketItem(outcome.item.id)).toBe("inserted");
    expect(requestOverlayAction).toHaveBeenCalledTimes(2);
    expect(requestOverlayAction).toHaveBeenLastCalledWith({
      type: "pasteShapes", payload: expect.objectContaining({ shapes: [expect.objectContaining({ type })] }), unbounded: false,
    });
    expect(document.activeElement).toBe(editor);
    expect(paste).not.toHaveBeenCalled();
  });

  it("uses the drop point and preserves body text routing and host cleanup", async () => {
    await act(async () => root.render(<Host />));
    const pageItem = createPocketItem(clipOf(createOverlayClipboardPayload([fixtures.shapes.tableShape], {})), { id: "table", addedAt: 1 })!;
    const textItem = createPocketItem(clipOf(createTextFlowClipboardPayload([
      { type: "paragraph", id: "p", children: [{ type: "text", text: "本文" }] },
    ])), { id: "text", addedAt: 1 })!;
    const point = { x: 120, y: 250 };
    expect(getPocketPageHost()!.placeOnPage(pageItem, point)).toBe(true);
    expect(requestOverlayAction.mock.lastCall?.[0].centerAt).toEqual(point);
    expect(getPocketPageHost()!.placeOnPage(textItem, null)).toBe(false);

    await act(async () => root.render(<Host bodyless />));
    expect(getPocketPageHost()!.placeOnPage(textItem, null)).toBe(true);
    expect(requestOverlayAction.mock.lastCall?.[0]).toMatchObject({ centerAt: { x: 400, y: 500 }, unbounded: true });
    await act(async () => root.render(null));
    expect(getPocketPageHost()).toBeNull();
  });

  it("routes to the focused pane at insertion time and keeps other hosts after unmount", async () => {
    let focused = "left";
    const left = vi.fn(), right = vi.fn();
    function Pane({ id, request }: { id: string; request: typeof left }) {
      usePocketPageHost({ ownsInput: () => focused === id, ownsDropLocation: location => (location.clientX < 100 ? "left" : "right") === id, bodyless: false, requestOverlayAction: request, getViewportCenter });
      return null;
    }
    await act(async () => root.render(<><Pane id="left" request={left} /><Pane id="right" request={right} /></>));
    const item = addToPocket(clipOf(createOverlayClipboardPayload([fixtures.shapes.tableShape], fixtures.assets)));
    if (!item.ok) throw new Error(item.reason);
    expect(insertPocketItem(item.item.id)).toBe("inserted");
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).not.toHaveBeenCalled();
    const dropHost = getPocketPageHost({ clientX: 150, clientY: 20, pagePoint: { x: 50, y: 20 } });
    expect(dropHost?.placeOnPage(item.item, { x: 50, y: 20 })).toBe(true);
    expect(right).toHaveBeenCalledTimes(1);
    focused = "right";
    expect(insertPocketItem(item.item.id)).toBe("inserted");
    expect(right).toHaveBeenCalledTimes(2);
    focused = "left";
    await act(async () => root.render(<Pane id="left" request={left} />));
    expect(insertPocketItem(item.item.id)).toBe("inserted");
    expect(left).toHaveBeenCalledTimes(2);
    focused = "none";
    expect(getPocketPageHost()).toBeNull();
  });
});
