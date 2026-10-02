// @vitest-environment happy-dom
import { createEmptyEditorDocument } from "@/lib/blank-document";
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { useWorkspaceDocumentNavigation } from "./use-workspace-document-navigation";

type Ports = Parameters<typeof useWorkspaceDocumentNavigation>[0];
let root: Root;
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; root = createRoot(document.createElement("div")); });
afterEach(() => { act(() => root.unmount()); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides: Partial<Ports> = {}) {
  let open!: ReturnType<typeof useWorkspaceDocumentNavigation>;
  const document = { ...createEmptyEditorDocument(), docId: "two" };
  const order: string[] = [];
  const ports: Ports = {
    openFileIds: ["one"], workspaceReady: true, getActiveFileId: () => "one", setLoadingFileId: vi.fn(),
    saveCurrentDocumentBeforeReplacement: vi.fn(async () => { order.push("save"); return true; }),
    rememberLeavingEditorTabViewState: vi.fn(), loadWorkspaceDocument: vi.fn(async () => { order.push("load"); return { document, observedRevision: 17 }; }),
    showRecordedDocumentOpenFailure: () => null, enterDocumentOpenFailureState: vi.fn(async () => {}),
    prepareIncomingEditorTabViewState: () => ({ selectedId: undefined, textSelection: null, scrollTop: 0, scrollLeft: 0 }),
    resetEditorDocument: vi.fn(() => { order.push("reset"); }), restoreTextSelection: vi.fn(), setOpenFileIds: vi.fn(), setActiveFileId: vi.fn(),
    saveWorkspaceState: vi.fn(async () => ({ ok: true })), refreshDocumentMetadatas: vi.fn(async () => {}), setSaveState: vi.fn(), setStatusMessage: vi.fn(), ...overrides,
  };
  function Probe() { open = useWorkspaceDocumentNavigation(ports); return null; }
  act(() => root.render(<Probe />));
  return { open: (id: string) => open(id), ports, document, order };
}
describe("workspace document navigation boundary", () => {
  it("saves before loading and gives the sole reset owner the observed revision", async () => {
    const f = fixture(); await act(async () => f.open("two"));
    expect(f.order).toEqual(["save", "load", "reset"]);
    expect(f.ports.resetEditorDocument).toHaveBeenCalledWith(expect.objectContaining({ docId: "two" }), undefined, 17);
    expect(f.ports.setOpenFileIds).toHaveBeenCalledWith(["one", "two"]); expect(f.ports.setActiveFileId).toHaveBeenCalledWith("two");
  });
  it("a refused save never loads or resets another document", async () => {
    const f = fixture({ saveCurrentDocumentBeforeReplacement: async () => false }); await act(async () => f.open("two"));
    expect(f.ports.loadWorkspaceDocument).not.toHaveBeenCalled(); expect(f.ports.resetEditorDocument).not.toHaveBeenCalled();
  });
  it("disposal while saving prevents the pending switch", async () => {
    const pending = deferred<boolean>(); const f = fixture({ saveCurrentDocumentBeforeReplacement: () => pending.promise });
    const switching = f.open("two"); act(() => root.render(null));
    await act(async () => { pending.resolve(true); await switching; });
    expect(f.ports.loadWorkspaceDocument).not.toHaveBeenCalled(); expect(f.ports.resetEditorDocument).not.toHaveBeenCalled();
  });
  it("disposal while loading prevents activation and leaves no late UI cleanup", async () => {
    const pending = deferred<Awaited<ReturnType<Ports["loadWorkspaceDocument"]>>>();
    const f = fixture({ loadWorkspaceDocument: () => pending.promise }); let switching!: Promise<void>;
    await act(async () => { switching = f.open("two"); }); act(() => root.render(null));
    await act(async () => { pending.resolve({ document: f.document, observedRevision: 17 }); await switching; });
    expect(f.ports.resetEditorDocument).not.toHaveBeenCalled(); expect(f.ports.setLoadingFileId).toHaveBeenCalledExactlyOnceWith("two");
  });
});
