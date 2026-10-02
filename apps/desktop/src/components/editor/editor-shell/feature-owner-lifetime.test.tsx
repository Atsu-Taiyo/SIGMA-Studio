// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyEditorDocument } from "@/lib/blank-document";
import * as bridge from "@/lib/desktop-bridge";
import type { DesktopAPI, DesktopMcpEditProposalSummary } from "@/types/desktop";
import { useAiSurfaceController } from "./use-ai-surface-controller";
import { useDocumentPrintController } from "./use-document-print-controller";
import { useMcpProposalController } from "./use-mcp-proposal-controller";

type ProposalPorts = Parameters<typeof useMcpProposalController>[0];
const services = {
  groupMcpProposalsForPreview: () => ({ groups: [], stale: [] }),
  useAiRunSessions: () => new Map(),
  deriveAiProposalPresentation: () => ({ previewGroups: [] }),
  isAiRunStatusActive: () => false,
  buildSourceReferencesByTurnId: () => new Map(),
  buildInsertedShapePreviewsByTurnId: () => new Map(),
  buildRestorableProposalsByTurnId: () => new Map(),
  buildAppliedTurnChangesByTurnId: () => new Map(),
} as unknown as ProposalPorts["services"];
let root: Root;
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); root = createRoot(document.createElement("div")); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("MCP proposal display owner", () => {
  let current: ReturnType<typeof useMcpProposalController>;
  let activeFileId: string;
  const getActiveFileId = () => activeFileId;
  function Probe() { current = useMcpProposalController({ activeFileId, activeDocumentRevision: 7, overlayShapes: [], getActiveFileId, services }); return null; }
  beforeEach(() => { activeFileId = "one"; });
  it("coalesces watcher and approval refreshes into one trailing batch", async () => {
    const list = vi.fn(async () => []);
    vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ storage: { listMcpEditProposals: list } } as unknown as DesktopAPI);
    act(() => root.render(<Probe />));
    const first = current.refreshMcpEditProposals(); const second = current.refreshMcpEditProposals();
    expect(first).toBe(second); expect(list).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(75); await first; });
    expect(list).toHaveBeenCalledExactlyOnceWith({ status: "all", fileId: "one" });
  });
  it("settles a queued batch and clears its timer when disposed", async () => {
    const list = vi.fn(async () => []);
    vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ storage: { listMcpEditProposals: list } } as unknown as DesktopAPI);
    act(() => root.render(<Probe />)); const waiting = current.refreshMcpEditProposals();
    act(() => root.render(null)); await waiting;
    expect(vi.getTimerCount()).toBe(0); expect(list).not.toHaveBeenCalled();
  });
  it("discards a response scoped to a document that has since switched", async () => {
    const pending = deferred<DesktopMcpEditProposalSummary[]>();
    vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ storage: { listMcpEditProposals: () => pending.promise } } as unknown as DesktopAPI);
    act(() => root.render(<Probe />)); const refresh = current.refreshMcpEditProposals();
    await act(async () => { await vi.advanceTimersByTimeAsync(75); });
    activeFileId = "two"; act(() => root.render(<Probe />));
    await act(async () => { pending.resolve([{ proposalId: "old", fileId: "one", status: "pending" } as DesktopMcpEditProposalSummary]); await refresh; });
    expect(current.mcpEditProposals).toEqual([]); expect(current.mcpProposalCitations).toEqual([]);
  });
});

describe("print/export owner", () => {
  let current: ReturnType<typeof useDocumentPrintController>;
  function fixture(save: () => Promise<{ ok: boolean }>) {
    let fileId = "one";
    const exportPdf = vi.fn(async () => ({ filePath: "/output.pdf" }));
    vi.spyOn(bridge, "getDesktopBridge").mockReturnValue({ file: { exportPdf } } as unknown as DesktopAPI);
    const getDocument = () => createEmptyEditorDocument(); const getActiveFileId = () => fileId;
    function Probe() { current = useDocumentPrintController({ isDesktopApp: true, isEmbedded: false, getDocument, getActiveFileId, flushOverlayChanges: vi.fn(), saveCurrentDocumentRecord: save, setSaveState: vi.fn(), setStatusMessage: vi.fn() }); return null; }
    act(() => root.render(<Probe />));
    act(() => current.setPrintPreviewRenderState({ state: "ready", surfaceId: "surface", revision: 2, pageCount: 1, pageWidthMm: 210, pageHeightMm: 297 }));
    return { exportPdf, switchFile: () => { fileId = "two"; } };
  }
  it("does not export after disposal while the save boundary is awaiting", async () => {
    const pending = deferred<{ ok: boolean }>(); const f = fixture(() => pending.promise);
    let exporting!: Promise<void>; act(() => { exporting = current.exportPdf(); }); act(() => root.render(null));
    await act(async () => { pending.resolve({ ok: true }); await exporting; });
    expect(f.exportPdf).not.toHaveBeenCalled();
  });
  it("does not export a prior preview under a new file identity", async () => {
    const pending = deferred<{ ok: boolean }>(); const f = fixture(() => pending.promise);
    let exporting!: Promise<void>; act(() => { exporting = current.exportPdf(); }); f.switchFile();
    await act(async () => { pending.resolve({ ok: true }); await exporting; });
    expect(f.exportPdf).not.toHaveBeenCalled(); expect(current.pdfExporting).toBe(false);
  });
  it("uses the settled preview surface after the existing save boundary", async () => {
    const order: string[] = []; const f = fixture(async () => { order.push("save"); return { ok: true }; });
    f.exportPdf.mockImplementation(async () => { order.push("export"); return { filePath: "/output.pdf" }; });
    await act(async () => current.exportPdf());
    expect(order).toEqual(["save", "export"]); expect(f.exportPdf).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "surface", revision: 2, pageCount: 1 }));
    expect(current.exportedPdfPath).toBe("/output.pdf");
  });
});

describe("AI display owner", () => {
  let current: ReturnType<typeof useAiSurfaceController>;
  function fixture() {
    const clearAiEditPinnedReferences = vi.fn(); const clearAiEditPreview = vi.fn();
    function Probe() { current = useAiSurfaceController({ isDesktopApp: true, transitions: {
      openInline: () => ({ displayMode: "inline", aiSidebarOpen: false, aiInlineOpen: true }),
      promoteToSidebar: () => ({ displayMode: "sidebar", aiSidebarOpen: true, aiInlineOpen: false }),
      closeSurface: () => ({ displayMode: "inline", aiSidebarOpen: false, aiInlineOpen: false }),
    }, dismissVersionHistory: vi.fn(), clearRunAnchor: vi.fn(), hasRunAnchor: () => false, clearAiEditPinnedReferences, clearAiEditPreview }); return null; }
    act(() => root.render(<Probe />)); return { clearAiEditPinnedReferences, clearAiEditPreview };
  }
  it("reopening inline input cancels the preceding close animation", () => {
    const f = fixture(); act(() => current.openAiInline(null)); act(() => current.closeAiSurface());
    act(() => current.openAiInline({ left: 10, top: 20 })); act(() => vi.advanceTimersByTime(200));
    expect(current.aiInlineOpen).toBe(true); expect(current.aiInlineClosing).toBe(false); expect(current.aiInlineSessionId).toBe(2);
    expect(f.clearAiEditPinnedReferences).not.toHaveBeenCalled(); expect(f.clearAiEditPreview).not.toHaveBeenCalled();
  });
  it("disposing an inline close clears the timer and preserves previews", () => {
    const f = fixture(); act(() => current.openAiInline(null)); act(() => current.closeAiSurface()); act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0); act(() => vi.advanceTimersByTime(200)); expect(f.clearAiEditPreview).not.toHaveBeenCalled();
  });
});
