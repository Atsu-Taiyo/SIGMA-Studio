// @vitest-environment happy-dom
import { ensurePageLayout, type OverlayShape, type SigmaDocument } from "@/features/document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { createTranslator } from "@/lib/i18n";
import * as storage from "@/lib/storage";
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentSaveBoundary } from "./use-document-save-boundary";
import { resolveWindowCloseOutcome } from "./window-close-save";

type Ports = Parameters<typeof useDocumentSaveBoundary>[0];
type Boundary = ReturnType<typeof useDocumentSaveBoundary>;

const FILE_ID = "file_close";

function documentWithShape(patch: { x?: number; y?: number; props?: Record<string, unknown> } = {}): SigmaDocument {
  const document = ensurePageLayout({
    version: "2.0", docId: "doc_close", metadata: { title: "閉じる直前" },
    content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  } as SigmaDocument);
  const shape = {
    id: "shape_text", type: "text", x: patch.x ?? 100, y: patch.y ?? 220, rotation: 0,
    props: {
      w: 260, h: 36, color: "#111111", size: "m",
      blocks: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "答" }] }],
      ...patch.props,
    },
  } as OverlayShape;
  document.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [shape] } };
  return document;
}

function savedShape(document: SigmaDocument | undefined) {
  return document?.pageLayout?.overlay?.overlaySnapshot?.shapes[0] as (OverlayShape & { props: { h: number } }) | undefined;
}

function documentWithBody(text: string): SigmaDocument {
  return {
    ...documentWithShape(),
    content: [{ type: "paragraph", id: "body", children: [{ type: "text", text }] }],
  };
}

let root: Root;
let boundary: Boundary;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The shell's side of a boundary save, with one overlay editor whose edit is still waiting on its
 * save debounce. `expireDebounce` is that timer running out; the storage stubs call it while their
 * write is in flight, which is the window the close-time save used to lose.
 */
function setup(initial: SigmaDocument, saved: SigmaDocument, configure?: (ports: Ports) => void) {
  const ref = <T,>(current: T) => ({ current }) as RefObject<T>;
  const documentRef = ref(initial);
  const lastSavedDocumentRef = ref(saved);
  const documentDirtyRevisionRef = ref(areSigmaDocumentsEquivalent(initial, saved) ? 0 : 1);
  const lastSavedDirtyRevisionRef = ref(0);
  const isCurrentDocumentDirty = () => !areSigmaDocumentsEquivalent(documentRef.current, lastSavedDocumentRef.current);

  let pending: SigmaDocument | null = null;
  const commit = (next: SigmaDocument) => {
    documentRef.current = next;
    documentDirtyRevisionRef.current += 1;
  };
  const overlay = {
    hold(next: SigmaDocument) { pending = next; },
    /** `FLUSH_OVERLAY_CHANGES_EVENT`: what the editor holds goes in now. */
    flush() {
      if (!pending) return;
      const next = pending;
      pending = null;
      commit(next);
    },
    expireDebounce() { overlay.flush(); },
  };

  const writes: SigmaDocument[] = [];
  vi.spyOn(storage, "saveDocumentRecord").mockImplementation(async (write) => {
    overlay.expireDebounce();
    writes.push(write.document);
    return { ok: true, revision: write.observedRevision + 1 } as Awaited<ReturnType<typeof storage.saveDocumentRecord>>;
  });
  vi.spyOn(storage, "captureDocumentVersion").mockImplementation(async () => {
    overlay.expireDebounce();
    return { ok: true } as Awaited<ReturnType<typeof storage.captureDocumentVersion>>;
  });

  const ports: Ports = {
    setVersionHistoryWarnings: vi.fn(),
    t: createTranslator("ja", "chrome"),
    documentOpenFailureRef: ref(null),
    activeFileIdRef: ref(FILE_ID),
    documentDirtyRevisionRef,
    embeddedHostRef: ref(undefined),
    documentRef,
    lastSavedDocumentRef,
    lastSavedDirtyRevisionRef,
    lastSyncedDocumentRef: ref(saved),
    tEditor: createTranslator("ja", "editor"),
    documentObservedRevisionRef: ref(1),
    inFlightSavePromiseRef: ref(null),
    successfulDocumentSavesRef: ref(new Map()),
    workspaceReadyRef: ref(true),
    externalChangeFileIdsRef: ref(new Set()),
    mcpPreviewBusyRef: ref(false),
    isCurrentDocumentDirty,
    flushPendingEdits: () => overlay.flush(),
    isEmbedded: false,
    setSaveState: vi.fn(),
    setStatusMessage: vi.fn(),
    dispatchDocumentStorageChange: vi.fn(),
    autosave: {
      activeFileId: FILE_ID,
      document: initial,
      workspaceReady: true,
      blocked: false,
      isDesktopApp: true,
      openFileIds: [FILE_ID],
      setOpenFileIds: vi.fn(),
      saveWorkspaceState: vi.fn(async () => ({ ok: true })),
      refreshDocumentMetadatas: vi.fn(async () => undefined),
    },
  };
  configure?.(ports);
  function Probe() { boundary = useDocumentSaveBoundary(ports); return null; }
  // Reuse this component type so rerenders exercise effect cleanup on the same hook instance.
  const rerender = () => act(() => root.render(<Probe />));
  rerender();

  const closeOutcome = async () => {
    let result!: Awaited<ReturnType<Boundary["attemptBoundarySave"]>>;
    await act(async () => { result = await boundary.attemptBoundarySave("app-close"); });
    return resolveWindowCloseOutcome({
      saveOk: result.ok,
      saveError: result.error,
      timedOut: false,
      dirty: isCurrentDocumentDirty(),
      skipped: result.skipped === true,
      skippedReason: result.skippedReason,
    });
  };
  return { overlay, writes, documentRef, isCurrentDocumentDirty, closeOutcome, ports, commit, rerender };
}

async function advanceTime(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

describe("ordinary autosave without a document session or embedded host", () => {
  it("A009-01 restarts the 450ms wait after editing and saves body B once", async () => {
    const saved = documentWithBody("保存済み");
    const bodyA = documentWithBody("本文A");
    const bodyB = documentWithBody("本文B");
    const fixture = setup(bodyA, saved);
    const { ports } = fixture;
    let finishSave!: (result: Awaited<ReturnType<typeof storage.saveDocumentRecord>>) => void;
    vi.mocked(storage.saveDocumentRecord).mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = resolve;
    }));

    // t=0: dirty render schedules a save, but no storage request has started.
    expect(storage.saveDocumentRecord).not.toHaveBeenCalled();
    await advanceTime(300);
    expect(storage.saveDocumentRecord).not.toHaveBeenCalled();
    fixture.commit(bodyB);
    ports.autosave.document = bodyB;
    fixture.rerender();

    await advanceTime(150); // t=450: the old deadline was cancelled.
    expect(storage.saveDocumentRecord).not.toHaveBeenCalled();
    await advanceTime(299); // t=749: 449ms since the latest edit is still waiting.
    expect(storage.saveDocumentRecord).not.toHaveBeenCalled();
    await advanceTime(1); // t=750: the valid deadline starts the save.
    expect(storage.saveDocumentRecord).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      fileId: FILE_ID,
      document: expect.objectContaining({ content: bodyB.content }),
      observedRevision: 1,
    }));
    const write = vi.mocked(storage.saveDocumentRecord).mock.calls[0][0];
    expect(areSigmaDocumentsEquivalent(write.document, bodyB)).toBe(true);
    expect(ports.inFlightSavePromiseRef.current).not.toBeNull();
    expect(ports.lastSavedDocumentRef.current).toBe(saved);
    expect(ports.lastSavedDirtyRevisionRef.current).toBe(0);
    expect(ports.documentObservedRevisionRef.current).toBe(1);

    const saving = ports.inFlightSavePromiseRef.current;
    await act(async () => { finishSave({ ok: true, revision: 2 }); await saving; });
    expect(ports.lastSavedDocumentRef.current).toBe(write.document);
    expect(ports.lastSavedDirtyRevisionRef.current).toBe(2);
    expect(ports.lastSavedDirtyRevisionRef.current).toBe(ports.documentDirtyRevisionRef.current);
    expect(ports.documentObservedRevisionRef.current).toBe(2);
    expect(fixture.isCurrentDocumentDirty()).toBe(false);
    expect(ports.inFlightSavePromiseRef.current).toBeNull();

    await advanceTime(900);
    expect(storage.saveDocumentRecord).toHaveBeenCalledTimes(1);
  });

  it("A009-01 reads the latest body and edit revision from refs before a deferred render", async () => {
    const bodyA = documentWithBody("本文A");
    const bodyB = documentWithBody("本文B");
    const fixture = setup(bodyA, documentWithBody("保存済み"));
    await advanceTime(300);
    // EditorShell.commitDocumentChange updates both refs before startTransition renders state.
    // Keep the rendered document at A while that deferred render is still pending.
    fixture.commit(bodyB);
    expect(fixture.ports.autosave.document).toBe(bodyA);
    await advanceTime(150);

    expect(storage.saveDocumentRecord).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      fileId: FILE_ID,
      document: expect.objectContaining({ content: bodyB.content }),
      observedRevision: 1,
    }));
    expect(areSigmaDocumentsEquivalent(fixture.ports.lastSavedDocumentRef.current, bodyB)).toBe(true);
    expect(fixture.ports.lastSavedDirtyRevisionRef.current).toBe(2);
    expect(fixture.isCurrentDocumentDirty()).toBe(false);
  });

  it.each([
    { id: "A009-02", condition: "clean", dirty: false, workspaceReady: true, blocked: false, openFailed: false },
    { id: "A009-03", condition: "workspace not ready", dirty: true, workspaceReady: false, blocked: false, openFailed: false },
    { id: "A009-04", condition: "blocked hook argument", dirty: true, workspaceReady: true, blocked: true, openFailed: false },
    { id: "A009-05", condition: "active file failed to load", dirty: true, workspaceReady: true, blocked: false, openFailed: true },
  ])("$id does not save when $condition", async ({ dirty, workspaceReady, blocked, openFailed }) => {
    const saved = documentWithBody("保存済み");
    const savedSnapshot = structuredClone(saved);
    const fixture = setup(dirty ? documentWithBody("未保存の本文") : saved, saved, (ports) => {
      ports.autosave.workspaceReady = workspaceReady;
      ports.autosave.blocked = blocked;
      if (openFailed) {
        ports.documentOpenFailureRef.current = {
          fileId: FILE_ID, title: "読込失敗", error: "Invalid JSON", kind: "json", failures: [],
        };
      }
    });
    const { ports } = fixture;
    const savedDirtyRevision = ports.lastSavedDirtyRevisionRef.current;
    expect(fixture.isCurrentDocumentDirty()).toBe(dirty);
    expect(ports.documentDirtyRevisionRef.current).toBe(dirty ? 1 : savedDirtyRevision);

    await advanceTime(1000);

    expect(storage.saveDocumentRecord).not.toHaveBeenCalled();
    expect(ports.lastSavedDocumentRef.current).toBe(saved);
    expect(ports.lastSavedDocumentRef.current).toEqual(savedSnapshot);
    expect(ports.lastSavedDirtyRevisionRef.current).toBe(savedDirtyRevision);
  });
});

describe("boundary save and edits still on the overlay's save debounce", () => {
  it("saves a shape edit made just before closing instead of finding it unsaved after the save", async () => {
    // A drag ended a moment ago: the document is still the saved one, the move waits on the debounce.
    const before = documentWithShape();
    const fixture = setup(before, before);
    const moved = documentWithShape({ x: 160, y: 260 });
    fixture.overlay.hold(moved);

    expect(await fixture.closeOutcome()).toBe("ready");
    expect(fixture.writes).toHaveLength(1);
    expect(savedShape(fixture.writes[0])).toMatchObject({ x: 160, y: 260 });
    expect(fixture.isCurrentDocumentDirty()).toBe(false);
  });

  it("saves the height a shape measured after a format change together with the change", async () => {
    // The format is in the document; the height its text then measured is still held back.
    const saved = documentWithShape();
    const formatted = documentWithShape({ props: { blocks: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "答", marks: ["bold"] }] }] } });
    const fixture = setup(formatted, saved);
    fixture.overlay.hold(documentWithShape({ props: {
      h: 37,
      blocks: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "答", marks: ["bold"] }] }],
    } }));

    expect(await fixture.closeOutcome()).toBe("ready");
    expect(fixture.writes).toHaveLength(1);
    expect(savedShape(fixture.writes[0])?.props.h).toBe(37);
    expect(JSON.stringify(savedShape(fixture.writes[0])?.props)).toContain("bold");
    expect(fixture.isCurrentDocumentDirty()).toBe(false);
  });

  it("still reports an edit that arrives after the save has read the document", async () => {
    // Not something to hide: a change that really lands after the snapshot leaves the document
    // unsaved, and closing must say so rather than claim it was saved.
    const before = documentWithShape();
    const fixture = setup(before, before);
    vi.mocked(storage.captureDocumentVersion).mockImplementation(async () => {
      fixture.documentRef.current = documentWithShape({ x: 300 });
      return { ok: true } as Awaited<ReturnType<typeof storage.captureDocumentVersion>>;
    });

    expect(await fixture.closeOutcome()).toBe("dialog");
  });
});

describe("boundary save waiting for an earlier autosave", () => {
  it.each([false, true])("flushes edits queued during the earlier save (reject=%s)", async (reject) => {
    const before = documentWithShape();
    const fixture = setup(before, before);
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const earlier = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    fixture.ports.inFlightSavePromiseRef.current = earlier;
    // The real autosave clears its ref in finally, including on failure.
    void earlier.finally(() => { fixture.ports.inFlightSavePromiseRef.current = null; }).catch(() => {});
    fixture.overlay.hold(documentWithShape({ x: 140 }));
    const closing = fixture.closeOutcome();
    expect(fixture.documentRef.current).toMatchObject({ pageLayout: { overlay: { overlaySnapshot: { shapes: [expect.objectContaining({ x: 140 })] } } } });
    expect(fixture.writes).toHaveLength(0);
    fixture.overlay.hold(documentWithShape({ x: 220 }));
    await act(async () => { if (reject) fail(new Error("save failed")); else finish(); });
    expect(await closing).toBe("ready");
    expect(fixture.writes).toHaveLength(1);
    expect(savedShape(fixture.writes[0])).toMatchObject({ x: 220 });
    expect(fixture.isCurrentDocumentDirty()).toBe(false);
  });
});
