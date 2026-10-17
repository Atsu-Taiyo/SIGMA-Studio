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
function setup(initial: SigmaDocument, saved: SigmaDocument) {
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
  function Probe() { boundary = useDocumentSaveBoundary(ports); return null; }
  act(() => root.render(<Probe />));

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
  return { overlay, writes, documentRef, isCurrentDocumentDirty, closeOutcome };
}

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
