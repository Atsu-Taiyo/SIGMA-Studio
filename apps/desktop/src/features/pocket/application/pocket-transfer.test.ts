// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayShape, ParagraphNode } from "@/features/document";
import {
  createOverlayClipboardPayload,
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

import { beginPocketDrag, registerPocketPageHost, type PocketPageHost } from "./pocket-drag";
import { getPocketState, resetPocketForTests } from "./pocket-store";
import { addSelectionToPocket, dropPocketItem, insertPocketItem, POCKET_ROOT_ATTRIBUTE } from "./pocket-transfer";

const paragraph: ParagraphNode = { type: "paragraph", id: "p_src", children: [{ type: "text", text: "本文の段落" }] };
const rectangle = {
  id: "shape_a",
  type: "geo",
  x: 10,
  y: 20,
  rotation: 0,
  props: { w: 100, h: 60, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
} as OverlayShape;

/** copy / paste を受けて記録する window の受け手。編集面が自分の `copy` で書くのと同じ形を再現する。 */
function installCopyWriter(write: (data: DataTransfer) => void): () => void {
  const handler = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    write(event.clipboardData);
  };
  window.addEventListener("copy", handler);
  return () => window.removeEventListener("copy", handler);
}

interface PasteRecord {
  target: EventTarget | null;
  types: string[];
  payload: string;
}

function installPasteRecorder(options: { handle: boolean }): { records: PasteRecord[]; dispose: () => void } {
  const records: PasteRecord[] = [];
  const handler = (event: ClipboardEvent) => {
    records.push({
      target: event.target,
      types: [...(event.clipboardData?.types ?? [])],
      payload: event.clipboardData?.getData("application/x-sigma-studio") ?? "",
    });
    if (options.handle) event.preventDefault();
  };
  window.addEventListener("paste", handler);
  return { records, dispose: () => window.removeEventListener("paste", handler) };
}

describe("pocket transfer", () => {
  let disposers: Array<() => void>;

  beforeEach(() => {
    resetPocketForTests();
    disposers = [];
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disposers.forEach((dispose) => dispose());
    resetPocketForTests();
    document.body.innerHTML = "";
  });

  it("collects what the editing surface writes on copy, without the clipboard or the remembered copy", () => {
    // ユーザーが先に別のものを普通にコピーしてある。
    const remembered = createTextFlowClipboardPayload([{ ...paragraph, id: "p_copied" }]);
    writeEditorClipboardData(new DataTransfer(), remembered);
    disposers.push(installCopyWriter((data) => {
      writeEditorClipboardData(data, createTextFlowClipboardPayload([paragraph]));
    }));

    const result = addSelectionToPocket();

    expect(result.ok).toBe(true);
    expect(getPocketState().items).toHaveLength(1);
    expect(getPocketState().items[0]?.preview).toMatchObject({ kind: "blocks", blockCount: 1 });
    // 「最後の Sigma コピー」は、ポケットへ入れても書き換わらない (次の ⌘V が別のものを貼らない)。
    expect(getLocalEditorClipboardPayload()).toEqual(remembered);
  });

  it("explains itself and opens the pocket when nothing was selected", () => {
    const result = addSelectionToPocket();

    expect(result).toEqual({ ok: false, reason: "nothing" });
    expect(getPocketState().items).toEqual([]);
    expect(getPocketState().notice?.kind).toBe("nothing");
    expect(getPocketState().expanded).toBe(true);
  });

  it("sends the copy to the focused editing surface when there is one", () => {
    const editor = document.body.appendChild(document.createElement("div"));
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    editor.focus();
    const seen: Array<EventTarget | null> = [];
    disposers.push(installCopyWriter((data) => {
      writeEditorClipboardData(data, createTextFlowClipboardPayload([paragraph]));
    }));
    const listener = (event: Event) => seen.push(event.target);
    window.addEventListener("copy", listener);
    disposers.push(() => window.removeEventListener("copy", listener));

    addSelectionToPocket();

    expect(seen[0]).toBe(editor);
  });

  it("sends it to the page instead when focus is inside the pocket or in a text field", () => {
    const pocket = document.body.appendChild(document.createElement("section"));
    pocket.setAttribute(POCKET_ROOT_ATTRIBUTE, "");
    const button = pocket.appendChild(document.createElement("button"));
    const field = document.body.appendChild(document.createElement("input"));
    const seen: Array<EventTarget | null> = [];
    const listener = (event: Event) => seen.push(event.target);
    window.addEventListener("copy", listener);
    disposers.push(() => window.removeEventListener("copy", listener));

    button.focus();
    addSelectionToPocket();
    field.focus();
    addSelectionToPocket();

    expect(seen).toEqual([document.body, document.body]);
  });

  it("refuses an environment that cannot build clipboard events, without throwing", () => {
    const original = globalThis.DataTransfer;
    // @ts-expect-error — 古い環境では DataTransfer を new できない。
    globalThis.DataTransfer = function Unsupported() { throw new TypeError("Illegal constructor"); };
    try {
      expect(addSelectionToPocket()).toEqual({ ok: false, reason: "unsupported" });
      expect(getPocketState().notice?.kind).toBe("unsupported");
    } finally {
      globalThis.DataTransfer = original;
    }
  });

  it("inserts with a paste that carries exactly what the copy wrote, and keeps the item", () => {
    const payload = createTextFlowClipboardPayload([paragraph]);
    disposers.push(installCopyWriter((data) => writeEditorClipboardData(data, payload)));
    addSelectionToPocket();
    const [item] = getPocketState().items;
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);
    const editor = document.body.appendChild(document.createElement("div"));
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    editor.focus();

    expect(insertPocketItem(item!.id)).toBe("inserted");
    expect(insertPocketItem(item!.id)).toBe("inserted");

    expect(recorder.records).toHaveLength(2);
    expect(recorder.records[0]?.target).toBe(editor);
    expect(recorder.records[0]?.types).toEqual(expect.arrayContaining(["application/x-sigma-studio", "text/html", "text/plain"]));
    expect(JSON.parse(recorder.records[0]?.payload ?? "{}")).toEqual(JSON.parse(JSON.stringify(payload)));
    // 何度でも入れられる。
    expect(getPocketState().items).toHaveLength(1);
  });

  it("pastes shapes onto the page, not into the caret's text editor", () => {
    disposers.push(installCopyWriter((data) => {
      writeEditorClipboardData(data, createOverlayClipboardPayload([rectangle], {}, "doc_a"));
    }));
    addSelectionToPocket();
    const [item] = getPocketState().items;
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);
    const editor = document.body.appendChild(document.createElement("div"));
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    editor.focus();

    expect(insertPocketItem(item!.id)).toBe("inserted");

    expect(recorder.records[0]?.target).toBe(document.body);
  });

  it("says so when nobody takes the paste, and when the item is gone", () => {
    disposers.push(installCopyWriter((data) => {
      writeEditorClipboardData(data, createTextFlowClipboardPayload([paragraph]));
    }));
    addSelectionToPocket();
    const [item] = getPocketState().items;
    const recorder = installPasteRecorder({ handle: false });
    disposers.push(recorder.dispose);

    expect(insertPocketItem(item!.id)).toBe("rejected");
    expect(getPocketState().notice?.kind).toBe("rejected");

    expect(insertPocketItem("pocket_missing")).toBe("missing");
  });
});

describe("pocket drop and page host", () => {
  let disposers: Array<() => void>;

  function putIntoPocket(payload: Parameters<typeof writeEditorClipboardData>[1]): string {
    const remove = installCopyWriter((data) => writeEditorClipboardData(data, payload));
    addSelectionToPocket();
    remove();
    const items = getPocketState().items;
    return items[items.length - 1]!.id;
  }

  function dragOf(id: string): DataTransfer {
    const data = new DataTransfer();
    beginPocketDrag(data, id);
    return data;
  }

  /** 画面の座標の下にある要素と、そこへ置かれるキャレットを決める (happy-dom は座標を持たない)。 */
  function stubPoint(editable: HTMLElement | null, text: Text | null): void {
    document.elementsFromPoint = vi.fn(() => (editable ? [editable] : [document.body]));
    document.caretRangeFromPoint = vi.fn(() => {
      if (!text) return null;
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      return range;
    });
  }

  function createEditable(): { editable: HTMLElement; text: Text } {
    const editable = document.body.appendChild(document.createElement("div"));
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    const text = editable.appendChild(document.createTextNode("本文の文字"));
    return { editable, text };
  }

  beforeEach(() => {
    resetPocketForTests();
    disposers = [];
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disposers.forEach((dispose) => dispose());
    resetPocketForTests();
    document.body.innerHTML = "";
  });

  it("lets the page host place an item on a click, instead of pasting", () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const placed: Array<{ kind: string; point: unknown }> = [];
    const host: PocketPageHost = { placeOnPage: (item, point) => { placed.push({ kind: item.preview.kind, point }); return true; } };
    disposers.push(registerPocketPageHost(host));
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    expect(insertPocketItem(id)).toBe("inserted");

    expect(placed).toEqual([{ kind: "blocks", point: null }]);
    expect(recorder.records).toHaveLength(0);
  });

  it("falls back to the normal paste when the page host declines", () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    disposers.push(registerPocketPageHost({ placeOnPage: () => false }));
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    expect(insertPocketItem(id)).toBe("inserted");

    expect(recorder.records).toHaveLength(1);
  });

  it("stops asking a host that was unregistered", () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    let asked = 0;
    const unregister = registerPocketPageHost({ placeOnPage: () => { asked += 1; return true; } });
    unregister();
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    insertPocketItem(id);

    expect(asked).toBe(0);
    expect(recorder.records).toHaveLength(1);
  });

  it("hands a drop on the page to the host with the page point, and pastes nothing", async () => {
    const id = putIntoPocket(createOverlayClipboardPayload([rectangle], {}, "doc_a"));
    const points: unknown[] = [];
    disposers.push(registerPocketPageHost({ placeOnPage: (_item, point) => { points.push(point); return true; } }));
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const result = await dropPocketItem(dragOf(id), { clientX: 300, clientY: 200, pagePoint: { x: 120, y: 80 } });

    expect(result).toBe("inserted");
    expect(points).toEqual([{ x: 120, y: 80 }]);
    expect(recorder.records).toHaveLength(0);
  });

  it("puts the caret where the item was dropped on the body, then pastes there like Cmd+V", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const { editable, text } = createEditable();
    stubPoint(editable, text);
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const result = await dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: { x: 40, y: 50 } });

    expect(result).toBe("inserted");
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.target).toBe(editable);
    expect(JSON.parse(recorder.records[0]?.payload ?? "{}").kind).toBe("textFlowBlocks");
    // キャレットは落とした位置 (文字の 1 つ目の後ろ) に置かれ、編集面に焦点がある。
    const selection = window.getSelection();
    expect(document.activeElement).toBe(editable);
    expect(selection?.anchorNode).toBe(text);
    expect(selection?.anchorOffset).toBe(1);
    expect(selection?.isCollapsed).toBe(true);
  });

  it("waits one task after placing the caret, so the editor can take the selection first", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const { editable, text } = createEditable();
    stubPoint(editable, text);
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const pending = dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: null });

    expect(recorder.records).toHaveLength(0);
    await pending;
    expect(recorder.records).toHaveLength(1);
  });

  it("looks through a layer that covers the body (overlay editing) to find the caret, and puts it back", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const { editable, text } = createEditable();
    const cover = document.body.appendChild(document.createElement("div"));
    cover.style.pointerEvents = "auto";
    document.elementsFromPoint = vi.fn(() => [cover, editable]);
    let coverWhileLookingUp = "";
    document.caretRangeFromPoint = vi.fn(() => {
      coverWhileLookingUp = cover.style.pointerEvents;
      const range = document.createRange();
      range.setStart(text, 2);
      range.collapse(true);
      return range;
    });
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const result = await dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: null });

    expect(result).toBe("inserted");
    // 覆っている層を外して引き、引いたあとは元の値へ戻す。
    expect(coverWhileLookingUp).toBe("none");
    expect(cover.style.pointerEvents).toBe("auto");
    expect(window.getSelection()?.anchorOffset).toBe(2);
    expect(recorder.records[0]?.target).toBe(editable);
  });

  it("dissolves the editor's stale selection before it places the caret, as a click there would", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const { editable, text } = createEditable();
    stubPoint(editable, text);
    const order: string[] = [];
    disposers.push(registerPocketPageHost({
      placeOnPage: () => false,
      beforePlaceCaret: () => order.push("dissolve"),
    }));
    const caretLookup = document.caretRangeFromPoint;
    document.caretRangeFromPoint = (x, y) => {
      order.push("caret");
      return caretLookup.call(document, x, y);
    };
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    await dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: null });

    expect(order).toEqual(["dissolve", "caret"]);
    expect(recorder.records).toHaveLength(1);
  });

  it("leaves the editor's selection alone when shapes are dropped", async () => {
    const id = putIntoPocket(createOverlayClipboardPayload([rectangle], {}, "doc_a"));
    let dissolved = 0;
    disposers.push(registerPocketPageHost({
      placeOnPage: () => true,
      beforePlaceCaret: () => { dissolved += 1; },
    }));

    await dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: { x: 40, y: 50 } });

    expect(dissolved).toBe(0);
  });

  it("refuses a drop that is not on any text, and says so in the pocket", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    stubPoint(null, null);
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const result = await dropPocketItem(dragOf(id), { clientX: 5, clientY: 5, pagePoint: { x: 5, y: 5 } });

    expect(result).toBe("rejected");
    expect(recorder.records).toHaveLength(0);
    expect(getPocketState().notice?.kind).toBe("rejected");
  });

  it("never drops shapes into a text editor: with no host to place them, it refuses", async () => {
    const id = putIntoPocket(createOverlayClipboardPayload([rectangle], {}, "doc_a"));
    const { editable, text } = createEditable();
    stubPoint(editable, text);
    const recorder = installPasteRecorder({ handle: true });
    disposers.push(recorder.dispose);

    const result = await dropPocketItem(dragOf(id), { clientX: 40, clientY: 50, pagePoint: { x: 40, y: 50 } });

    expect(result).toBe("rejected");
    expect(recorder.records).toHaveLength(0);
  });

  it("does not drop into the pocket's own controls or into a text field", async () => {
    const id = putIntoPocket(createTextFlowClipboardPayload([paragraph]));
    const pocket = document.body.appendChild(document.createElement("section"));
    pocket.setAttribute(POCKET_ROOT_ATTRIBUTE, "");
    const { editable, text } = createEditable();
    pocket.appendChild(editable);
    stubPoint(editable, text);

    expect(await dropPocketItem(dragOf(id), { clientX: 1, clientY: 1, pagePoint: null })).toBe("rejected");
  });

  it("ignores a drop that carries no pocket item", async () => {
    expect(await dropPocketItem(new DataTransfer(), { clientX: 1, clientY: 1, pagePoint: null })).toBe("missing");
    const stale = dragOf("pocket_gone");
    expect(await dropPocketItem(stale, { clientX: 1, clientY: 1, pagePoint: null })).toBe("missing");
  });
});
