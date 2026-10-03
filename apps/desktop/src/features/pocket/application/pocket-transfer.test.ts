// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OverlayShape, ParagraphNode } from "@/features/document";
import {
  createOverlayClipboardPayload,
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

import { getPocketState, resetPocketForTests } from "./pocket-store";
import { addSelectionToPocket, insertPocketItem, POCKET_ROOT_ATTRIBUTE } from "./pocket-transfer";

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
