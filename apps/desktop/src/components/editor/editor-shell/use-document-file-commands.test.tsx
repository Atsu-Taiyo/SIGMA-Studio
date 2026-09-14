// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@/features/document";
import * as clipboard from "@/lib/clipboard-text";
import * as desktop from "@/lib/desktop-bridge";
import { createTranslator } from "@/lib/i18n";
import * as storage from "@/lib/storage";
import { useDocumentFileCommands, type DocumentFileCommandOptions } from "./use-document-file-commands";

let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useDocumentFileCommands>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe({ options }: { options: DocumentFileCommandOptions }) {
  const result = useDocumentFileCommands(options);
  useLayoutEffect(() => { actions = result; });
  return null;
}

function render(options: DocumentFileCommandOptions) {
  act(() => root.render(<Probe options={options} />));
}

function sigma(title = "旧タイトル"): SigmaDocument {
  return {
    version: "2.0", docId: "source", metadata: { title },
    content: [{ type: "paragraph", id: "paragraph", children: [{ type: "text", text: "本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

function fixture() {
  const events: string[] = [];
  const options: DocumentFileCommandOptions = {
    documentRef: { current: sigma() }, embeddedHostRef: { current: undefined },
    workspaceReady: true, isDesktopApp: false,
    flushOverlayChanges: vi.fn(() => { events.push("flush"); }),
    saveCurrentDocumentBeforeReplacement: vi.fn(async () => { events.push("save"); return true; }),
    openDocumentAsTab: vi.fn(async () => { events.push("open"); }),
    resetEditorDocument: vi.fn(), setOpenFileIds: vi.fn(), setActiveFileId: vi.fn(),
    setActiveMenu: vi.fn(), setSaveState: vi.fn(), setStatusMessage: vi.fn(),
    announceRecovery: vi.fn(() => { events.push("recovery"); }),
    DOCUMENT_BLOCK_OPERATION_PORTS: { now: () => "2026-09-09T00:00:00.000Z", createId: (prefix) => `${prefix}-imported` },
    tEditor: createTranslator("ja", "editor"),
  };
  const create = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockImplementation(async (document) => {
    events.push("create");
    return {
      fileId: "imported-file", document,
      metadata: {
        fileId: "imported-file", docId: document.docId, workspaceId: "workspace", folderId: null,
        title: document.metadata.title, revision: 1, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
      },
    };
  });
  return { options, events, create };
}

describe("document file commands", () => {
  it("keeps an OS request pending if saving fails, then imports a separate library copy on retry", async () => {
    const f = fixture();
    const original = f.options.documentRef.current;
    const pending = { id: 1, filePath: "/Downloads/配布教材.sigma.json", data: JSON.stringify(sigma()) };
    render(f.options);
    vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockResolvedValueOnce(false);
    expect(await actions.openExternalDocument(pending)).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.options.openDocumentAsTab).not.toHaveBeenCalled();
    expect(f.options.documentRef.current).toBe(original);
    expect(await actions.openExternalDocument(pending)).toBe(true);
    expect(f.events).toEqual(["save", "create", "open", "recovery"]);
    expect(f.create.mock.calls[0][0].metadata.title).toBe("配布教材");
    expect(f.create.mock.calls[0][0].docId).not.toBe(original.docId);
    expect(f.create.mock.calls[0][0].content).toEqual(original.content);
  });

  it("reports unreadable or invalid OS files without saving or replacing the active material", async () => {
    const f = fixture();
    render(f.options);
    expect(await actions.openExternalDocument({ id: 1, filePath: "/missing.sigma", error: "ENOENT" })).toBe(true);
    expect(await actions.openExternalDocument({ id: 2, filePath: "/invalid.sigma", data: '{"unrelated":true}' })).toBe(true);
    expect(f.options.setStatusMessage).toHaveBeenCalledTimes(2);
    expect(f.options.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
  });

  it("flushes overlays before reading the current document for export and clipboard fallback", async () => {
    const f = fixture();
    const exported = sigma("flush 後のタイトル");
    vi.mocked(f.options.flushOverlayChanges).mockImplementation(() => { f.options.documentRef.current = exported; });
    const saveSigmaDoc = vi.fn(async (request: { suggestedName: string; data: string }) => ({ filePath: `/tmp/${request.suggestedName}` }));
    vi.spyOn(desktop, "getDesktopBridge").mockReturnValue({ file: { saveSigmaDoc } } as unknown as NonNullable<ReturnType<typeof desktop.getDesktopBridge>>);
    const write = vi.spyOn(clipboard, "writeTextToClipboard").mockResolvedValue(false);
    render(f.options);

    await act(async () => { await actions.exportJson(); await actions.copyDocumentText(); });
    const payload = saveSigmaDoc.mock.calls[0]?.[0] as { suggestedName: string; data: string };
    expect(payload.suggestedName).toBe("flush 後のタイトル.sigma");
    expect(JSON.parse(payload.data).metadata.title).toBe("flush 後のタイトル");
    expect(write).toHaveBeenCalledWith(payload.data);
    expect(actions.documentTextCopyFallback).toBe(payload.data);
    expect(f.options.flushOverlayChanges).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed input before asking to save or creating a workspace file", async () => {
    const f = fixture();
    render(f.options);
    await act(async () => { await actions.importDocumentFile(new File(["{broken"], "教材.json")); });
    expect(f.options.setSaveState).toHaveBeenLastCalledWith("error");
    expect(f.options.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.options.openDocumentAsTab).not.toHaveBeenCalled();
  });

  it.each([true, false])("waits for the replacement save before import acceptance (%s)", async (accepted) => {
    const f = fixture();
    let allowSave!: (value: boolean) => void;
    vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockImplementation(() => {
      f.events.push("save");
      return new Promise((resolve) => { allowSave = resolve; });
    });
    render(f.options);
    const file = new File([JSON.stringify(sigma())], "数学.第1回.sigmadoc.json");
    const pending = actions.importDocumentFile(file);
    await vi.waitFor(() => expect(f.options.saveCurrentDocumentBeforeReplacement).toHaveBeenCalledOnce());
    expect(f.create).not.toHaveBeenCalled();
    expect(f.options.openDocumentAsTab).not.toHaveBeenCalled();
    allowSave(accepted);
    await act(async () => { await pending; });

    expect(f.events).toEqual(accepted ? ["save", "create", "open", "recovery"] : ["save"]);
    if (accepted) {
      expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ title: "数学.第1回" }), content: sigma().content }));
      expect(f.options.openDocumentAsTab).toHaveBeenCalledWith(expect.objectContaining({ fileId: "imported-file", metadata: expect.objectContaining({ title: "数学.第1回" }) }), f.options.tEditor("status.jsonImported"));
    }
  });

  it("reads the embedded host after decoding and adopts without creating a workspace file", async () => {
    const f = fixture();
    const file = new File([], "ホスト教材.json");
    let finishRead!: (source: string) => void;
    vi.spyOn(file, "text").mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    render(f.options);
    const pending = actions.importDocumentFile(file);
    f.options.embeddedHostRef.current = { document: sigma(), onChange: vi.fn() };
    finishRead(JSON.stringify(sigma()));
    await act(async () => { await pending; });

    expect(f.options.resetEditorDocument).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ title: "ホスト教材" }) }), undefined, null);
    expect(f.options.setActiveFileId).toHaveBeenCalledWith(expect.any(String));
    expect(f.options.announceRecovery).toHaveBeenCalledWith([]);
    expect(f.options.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.options.openDocumentAsTab).not.toHaveBeenCalled();
  });

  it("uses the desktop selected basename through the same import path and falls back to the web input", async () => {
    const f = fixture();
    const openSigmaDoc = vi.fn(async () => ({ filePath: "C:\\Documents\\選択した名前.sigmadoc.json", data: JSON.stringify(sigma()) }));
    const bridge = vi.spyOn(desktop, "getDesktopBridge").mockReturnValue({ file: { openSigmaDoc } } as unknown as NonNullable<ReturnType<typeof desktop.getDesktopBridge>>);
    render(f.options);
    await act(async () => { await actions.openDocumentViaDesktop(); });
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ title: "選択した名前" }) }));

    const input = document.createElement("input");
    const click = vi.spyOn(input, "click");
    actions.importInputRef.current = input;
    bridge.mockReturnValue(null);
    await act(async () => { await actions.openDocumentViaDesktop(); });
    expect(click).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledOnce();
  });
});
