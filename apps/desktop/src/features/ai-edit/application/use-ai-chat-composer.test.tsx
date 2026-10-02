// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopDocumentMetadata, DesktopAiResourceManifestEntry } from "@/types/desktop";
import { useAiChatComposer, type AiChatComposerOptions, type AiChatComposerController } from "./use-ai-chat-composer";

vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: vi.fn() }));
let root: Root | null;
let container: HTMLDivElement;
let composer: AiChatComposerController;
let renders: number;
const pendingReaders: Reader[] = [];
class Reader extends EventTarget {
  result = "";
  aborted = false;
  readAsDataURL() { pendingReaders.push(this); }
  abort() { this.aborted = true; this.dispatchEvent(new Event("abort")); }
  finish() { this.result = "data:application/pdf;base64,JVBERg=="; this.dispatchEvent(new Event("load")); }
}
function options(overrides: Partial<AiChatComposerOptions> = {}): AiChatComposerOptions {
  return {
    document: createBlankDocument(), documentIdentityKey: "file-current", documentWorkspaceId: "workspace",
    selectedId: null, reference: null, overlaySelection: { selectedCount: 0, selectedShapeIds: [], selectedShapes: [], selectedAssets: {}, locked: false, hidden: false, grouped: false, canAlign: false, canDistribute: false, canStyleStroke: false, canStyleFill: false, canStyleLine: false, canStyleLineEndpoints: false, arrowheadStart: null, arrowheadEnd: null, fill: { kind: "none" } },
    provider: "chatgpt", refreshRuntimeModels: vi.fn(async () => undefined), ...overrides,
  };
}
function file(fileId: string, title = fileId): DesktopDocumentMetadata {
  return { fileId, title, workspaceId: "workspace", folderId: null, docId: fileId, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}
function mount(props = options()) {
  function Probe() {
    const current = useAiChatComposer(props);
    useLayoutEffect(() => { composer = current; renders++; });
    return null;
  }
  root!.render(<StrictMode><Probe /></StrictMode>);
}
function selectFile() {
  composer.view.handleAttachmentFiles([new File(["%PDF"], "worksheet.pdf", { type: "application/pdf" })] as unknown as FileList);
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal("FileReader", Reader);
  pendingReaders.length = 0;
  renders = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(getDesktopBridge).mockReturnValue({ storage: { listFiles: vi.fn(async () => []), loadDocument: vi.fn(async () => createBlankDocument()) } } as unknown as ReturnType<typeof getDesktopBridge>);
});
afterEach(() => { act(() => root?.unmount()); root = null; container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("aborts a pending file on reset and keeps the next room's instruction", async () => {
  await act(async () => mount());
  await act(async () => selectFile());
  const reader = pendingReaders[0];
  await act(async () => { composer.actions.resetComposerState(); composer.actions.setInstruction("新しい会話"); });
  expect(reader.aborted).toBe(true);
  await act(async () => reader.finish());
  expect(composer.draft.attachments).toEqual([]);
  expect(composer.draft.instruction).toBe("新しい会話");
  expect(composer.composerError).toBeNull();
});

it("aborts the live reader created after reset when the panel unmounts", async () => {
  await act(async () => mount());
  await act(async () => composer.actions.resetComposerState());
  await act(async () => selectFile());
  const reader = pendingReaders[0];
  await act(async () => { root!.unmount(); root = null; });
  const committedRenders = renders;
  expect(reader.aborted).toBe(true);
  await act(async () => reader.finish());
  expect(renders).toBe(committedRenders);
  expect(composer.draft.attachments).toEqual([]);
});

it("accepts a current PDF attachment and clears the submitted draft", async () => {
  await act(async () => mount());
  await act(async () => selectFile());
  await act(async () => pendingReaders[0].finish());
  expect(composer.draft.attachments).toMatchObject([{ name: "worksheet.pdf", mimeType: "application/pdf" }]);
  expect(composer.draft.instruction.length).toBeGreaterThan(0);
  await act(async () => composer.actions.clearComposerAfterSubmit());
  expect(composer.draft.instruction).toBe("");
  expect(composer.draft.attachments).toEqual([]);
});

it("loads picker candidates once per opening and filters without more IPC", async () => {
  const listFiles = vi.fn(async () => [file("a", "数学"), file("b", "物理")]);
  vi.mocked(getDesktopBridge).mockReturnValue({ storage: { listFiles } } as unknown as ReturnType<typeof getDesktopBridge>);
  await act(async () => mount());
  await act(async () => composer.view.toggleContextMenu());
  expect(listFiles).toHaveBeenCalledTimes(1);
  await act(async () => composer.view.setContextPickerQuery("数学"));
  expect(composer.view.contextPickerDocCandidates.map(item => item.fileId)).toEqual(["a"]);
  await act(async () => composer.view.setContextPickerQuery("物理"));
  expect(composer.view.contextPickerDocCandidates.map(item => item.fileId)).toEqual(["b"]);
  expect(listFiles).toHaveBeenCalledTimes(1);
});

it("rejects the old picker request after close and reopen", async () => {
  const old = Promise.withResolvers<DesktopDocumentMetadata[]>();
  const next = Promise.withResolvers<DesktopDocumentMetadata[]>();
  const listFiles = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  vi.mocked(getDesktopBridge).mockReturnValue({ storage: { listFiles } } as unknown as ReturnType<typeof getDesktopBridge>);
  await act(async () => mount());
  await act(async () => composer.view.toggleContextMenu());
  await act(async () => composer.view.toggleContextMenu());
  await act(async () => composer.view.toggleContextMenu());
  await act(async () => next.resolve([file("current")]));
  await act(async () => old.resolve([file("stale")]));
  expect(composer.view.contextPickerDocCandidates.map(item => item.fileId)).toEqual(["current"]);
});

it("does not add a referenced document whose read finishes after a room reset", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof createBlankDocument>>();
  const loadDocument = vi.fn(() => pending.promise);
  vi.mocked(getDesktopBridge).mockReturnValue({ storage: { loadDocument, listFiles: vi.fn(async () => [file("other")]) } } as unknown as ReturnType<typeof getDesktopBridge>);
  await act(async () => mount());
  let selection: Promise<void> | void;
  await act(async () => { selection = composer.view.selectContextPickerItem({ kind: "doc", candidate: file("other") }); });
  expect(loadDocument).toHaveBeenCalledWith("other");
  await act(async () => { composer.actions.resetComposerState(); composer.actions.setInstruction("別の依頼"); });
  await act(async () => { pending.resolve(createBlankDocument()); await selection; });
  expect(composer.draft.mentionedDocuments).toEqual([]);
  expect(composer.draft.instruction).toBe("別の依頼");
});

it("keeps only the latest resource refresh and workspace/provider eligible skills", async () => {
  const old = Promise.withResolvers<{ resources: DesktopAiResourceManifestEntry[] }>();
  const latest = Promise.withResolvers<{ resources: DesktopAiResourceManifestEntry[] }>();
  const skill = (id: string, workspaceId: string | null = null): DesktopAiResourceManifestEntry => ({ id, title: id, description: "", kind: "skill", enabled: true, workspaceId, providers: ["codex"], sourcePath: `${id}/SKILL.md`, loadMode: "manual", tags: [], updatedAt: "2026-01-01" });
  // StrictMode performs setup/cleanup/setup; both old calls settle after refresh.
  const getTree = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  vi.mocked(getDesktopBridge).mockReturnValue({ aiResources: { getTree } } as unknown as ReturnType<typeof getDesktopBridge>);
  await act(async () => mount());
  await act(async () => window.dispatchEvent(new Event("sigma-ai-resources-changed")));
  await act(async () => latest.resolve({ resources: [skill("global"), skill("local", "workspace"), skill("foreign", "other-workspace")] }));
  await act(async () => old.resolve({ resources: [skill("stale")] }));
  expect(composer.draft.aiResources.map(item => item.id)).toEqual(["global", "local"]);
  expect(composer.view.contextPickerSkillCandidates.map(item => item.id)).toEqual(["global", "local"]);
});
