// @vitest-environment happy-dom
import { createEmptyEditorDocument } from "@/lib/blank-document";
import type { DocumentLoadResult } from "@/lib/storage";
import * as storage from "@/lib/storage";
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { TEXT_FORMAT_STATE_EVENT } from "./constants";
import { useDocumentRecovery } from "./use-document-recovery";
import { useEmbeddedDocumentSync } from "./use-embedded-document-sync";
import { useTextFormattingState } from "./use-text-formatting-state";

let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); root = createRoot(document.createElement("div"));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
describe("document recovery owner", () => {
  let recovery: ReturnType<typeof useDocumentRecovery>;
  const announceRecovery = vi.fn(); const rememberPristineDraft = vi.fn();
  function Probe() { recovery = useDocumentRecovery({ announceRecovery, rememberPristineDraft, activateFailedDocument: async () => {} }); return null; }
  it("drops delayed loaded documents after disposal", async () => {
    const pending = deferred<DocumentLoadResult>();
    vi.spyOn(storage, "loadDocumentByFileIdWithRecovery").mockReturnValue(pending.promise);
    act(() => root.render(<Probe />));
    const load = recovery.loadWorkspaceDocument("one");
    act(() => root.render(null));
    pending.resolve({ ok: true, document: createEmptyEditorDocument(), revision: 1, recoveryIssues: [{ kind: "block", path: ["content"], message: "repaired" }] });
    expect(await load).toBeNull();
    expect(announceRecovery).not.toHaveBeenCalled();
    expect(rememberPristineDraft).not.toHaveBeenCalled();
  });
  it("owns and clears a queued recovery announcement", async () => {
    vi.spyOn(storage, "loadDocumentByFileIdWithRecovery").mockResolvedValue({ ok: true, document: createEmptyEditorDocument(), revision: 2, recoveryIssues: [{ kind: "block", path: ["content"], message: "repaired" }] });
    act(() => root.render(<Probe />));
    await act(async () => { await recovery.loadWorkspaceDocument("one"); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.runAllTimers());
    expect(announceRecovery).not.toHaveBeenCalled();
  });
  it("keeps independent candidate loads and returns each observed revision", async () => {
    vi.spyOn(storage, "loadDocumentByFileIdWithRecovery").mockImplementation(async (id) => ({ ok: true, document: { ...createEmptyEditorDocument(), docId: id }, revision: id === "one" ? 7 : 9, recoveryIssues: [] }));
    act(() => root.render(<Probe />));
    const result = await Promise.all([recovery.loadWorkspaceDocument("one"), recovery.loadWorkspaceDocument("two")]);
    expect(result.map((item) => item?.observedRevision)).toEqual([7, 9]);
    expect(result.map((item) => item?.document.docId)).toEqual(["one", "two"]);
  });
});

describe("controlled embedded document reconciliation", () => {
  it("ignores timestamp-only updates and old emitted echoes, but accepts another document", async () => {
    const initial = createEmptyEditorDocument();
    let currentDocument = initial;
    const onChange = vi.fn(); const acceptDocument = vi.fn();
    const getDocument = () => currentDocument;
    function Probe({ input, value }: { input: typeof initial; value: typeof initial }) {
      useEmbeddedDocumentSync({ embeddedHost: { document: input, onChange }, document: value, initialDocument: initial, currentDocument: getDocument, acceptDocument }); return null;
    }
    await act(async () => root.render(<Probe input={initial} value={initial} />));
    await act(async () => root.render(<Probe input={{ ...initial, updatedAt: "2099-01-01T00:00:00Z" }} value={initial} />));
    expect(acceptDocument).not.toHaveBeenCalled();
    const edited = { ...initial, metadata: { ...initial.metadata, title: "edited" } };
    currentDocument = edited;
    await act(async () => root.render(<Probe input={initial} value={edited} />));
    expect(onChange).toHaveBeenCalledWith(edited);
    const latest = { ...edited, metadata: { ...edited.metadata, title: "latest" } };
    currentDocument = latest;
    await act(async () => root.render(<Probe input={initial} value={latest} />));
    await act(async () => root.render(<Probe input={structuredClone(edited)} value={latest} />));
    expect(acceptDocument).not.toHaveBeenCalled();
    const switched = { ...edited, docId: "another-document" };
    await act(async () => root.render(<Probe input={switched} value={latest} />));
    expect(acceptDocument).toHaveBeenCalledWith(switched);
  });
});

describe("toolbar formatting subscription", () => {
  it("mirrors formatting and releases its event listener on disposal", () => {
    let state!: ReturnType<typeof useTextFormattingState>;
    function Probe() { state = useTextFormattingState(); return null; }
    const remove = vi.spyOn(window, "removeEventListener");
    act(() => root.render(<Probe />));
    act(() => window.dispatchEvent(new CustomEvent(TEXT_FORMAT_STATE_EVENT, { detail: { target: "document", enabled: true, nodeType: "paragraph", blockId: "paragraph", bold: true, italic: false, underline: true, fontSize: null, fontSizeMixed: false, color: "#123456", lineHeight: "2" } })));
    expect(state.boldActive).toBe(true); expect(state.underlineActive).toBe(true);
    expect(state.textFontSize).toBeNull(); expect(state.textColor).toBe("#123456"); expect(state.lineHeight).toBe("2");
    act(() => root.render(null));
    expect(remove.mock.calls.some(([name]) => name === TEXT_FORMAT_STATE_EVENT)).toBe(true);
  });
});
