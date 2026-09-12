// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayShape, ParagraphNode, SigmaDocument } from "@/features/document";
import { createEmptyEditorDocument } from "@/lib/blank-document";
import { createTranslator } from "@/lib/i18n";
import type { MaterialRepository } from "@/lib/runtime/types";
import type { MaterialContent, MaterialItem } from "@/types/material";
import { FLUSH_OVERLAY_CHANGES_EVENT } from "../page-overlay-types";
import { MaterialLibraryDialogs } from "./material-library-dialogs";
import { useMaterialLibraryController, type MaterialLibraryController, type MaterialLibraryControllerOptions } from "./use-material-library-controller";

const NOW = "2026-09-09T00:00:00Z";
const tEditor = createTranslator("ja", "editor");
const tWorkspace = createTranslator("ja", "workspace");
let root: Root;
let container: HTMLDivElement;
let controller: MaterialLibraryController;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({ options, showDialogs = false }: { options: MaterialLibraryControllerOptions; showDialogs?: boolean }) {
  const result = useMaterialLibraryController(options);
  useLayoutEffect(() => { controller = result; });
  return showDialogs ? <MaterialLibraryDialogs controller={result} /> : null;
}

function render(options: MaterialLibraryControllerOptions) {
  act(() => root.render(<Probe options={options} />));
}

async function load(options: MaterialLibraryControllerOptions) {
  render(options);
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
}

function paragraph(id: string, text = id): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

function rectangle(id: string, w = 20): Extract<OverlayShape, { type: "geo" }> {
  return {
    id, type: "geo", x: 40, y: 60, rotation: 0,
    props: { w, h: 30, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" },
  };
}

function content(text = "素材本文"): MaterialContent {
  return { blocks: [paragraph("source", text)], overlaySnapshot: { version: 1, shapes: [], assets: {} } };
}

function material(id = "saved", overrides: Partial<MaterialItem> = {}): MaterialItem {
  return { id, version: 1, name: id, content: content(), createdAt: NOW, updatedAt: NOW, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(initial: MaterialItem[] = []) {
  const documentRef = { current: {
    ...structuredClone(createEmptyEditorDocument()),
    content: [paragraph("first"), paragraph("second")],
  } as SigmaDocument };
  const selectedIdRef = { current: "first" as string | null };
  const overlaySelectionRef: MaterialLibraryControllerOptions["overlaySelectionRef"] = {
    current: { selectedShapes: [], selectedAssets: {} },
  };
  const materialBlockSelectionRef = { current: null as string | null };
  const repository = {
    listMaterials: vi.fn<MaterialRepository["listMaterials"]>().mockResolvedValue(initial),
    createMaterial: vi.fn<MaterialRepository["createMaterial"]>(),
    renameMaterial: vi.fn<MaterialRepository["renameMaterial"]>(),
    updateMaterialMetadata: vi.fn<MaterialRepository["updateMaterialMetadata"]>(),
    deleteMaterial: vi.fn<MaterialRepository["deleteMaterial"]>().mockResolvedValue({ ok: true }),
  } satisfies MaterialRepository;
  let currentRepository: MaterialRepository = repository;
  const events: string[] = [];
  const commitDocumentChange = vi.fn<MaterialLibraryControllerOptions["commitDocumentChange"]>((change) => {
    events.push("commit");
    documentRef.current = typeof change === "function" ? change(documentRef.current) : change;
    return true;
  });
  const options: MaterialLibraryControllerOptions = {
    documentRef, selectedIdRef, overlaySelectionRef, materialBlockSelectionRef,
    commitDocumentChange,
    setSelectedId: vi.fn(() => { events.push("selection"); }),
    setSelectedInlineMath: vi.fn(() => { events.push("inline"); }),
    setStatusMessage: vi.fn(() => { events.push("status"); }),
    blockMutationPorts: { now: () => NOW, createId: (prefix) => `${prefix}-generated` },
    tEditor, tWorkspace,
    getRepository: () => currentRepository,
  };
  return { options, repository, documentRef, selectedIdRef, overlaySelectionRef, materialBlockSelectionRef, commitDocumentChange, events,
    setRepository(next: MaterialRepository) { currentRepository = next; },
  };
}

function menuEvent() {
  const button = document.createElement("button");
  button.getBoundingClientRect = () => ({ right: 300, bottom: 100 }) as DOMRect;
  return { currentTarget: button, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Parameters<MaterialLibraryController["openMaterialActionMenu"]>[0];
}

describe("mounted material library controller", () => {
  it("defers initial loading, retains pending state and reads the repository at operation time", async () => {
    const f = fixture();
    const pending = deferred<MaterialItem[]>();
    const loaded = material("loaded");
    f.repository.listMaterials.mockReturnValue(pending.promise);
    render(f.options);
    expect(f.repository.listMaterials).not.toHaveBeenCalled();
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(controller.materialsLoading).toBe(true);
    expect(controller.materials).toEqual([]);
    await act(async () => { pending.resolve([loaded]); await pending.promise; });
    expect(controller.materials).toEqual([loaded]);
    expect(controller.materialsLoading).toBe(false);

    const switched = { ...f.repository, listMaterials: vi.fn().mockResolvedValue([material("switched")]) };
    f.setRepository(switched);
    await act(async () => { await controller.refreshMaterials(); });
    expect(switched.listMaterials).toHaveBeenCalledOnce();
    expect(controller.materials.map((item) => item.id)).toEqual(["switched"]);
  });

  it("captures the current document and overlay refs, then clears drafts only after saving succeeds", async () => {
    const f = fixture();
    await load(f.options);
    act(() => {
      controller.setMaterialNameDraft("  保存名  ");
      controller.setMaterialDescriptionDraft(" 用途 ");
    });
    f.documentRef.current = { ...f.documentRef.current, content: [paragraph("first", "最新本文")] };
    f.materialBlockSelectionRef.current = "first";
    f.overlaySelectionRef.current = { selectedShapes: [rectangle("latest", 112)], selectedAssets: {} };
    const saving = deferred<MaterialItem>();
    f.repository.createMaterial.mockReturnValue(saving.promise);
    let work!: Promise<void>;
    act(() => { work = controller.saveSelectedMaterial(); });
    expect(controller.materialsLoading).toBe(true);
    expect(controller.materialNameDraft).toBe("  保存名  ");
    const input = f.repository.createMaterial.mock.calls[0][0];
    expect(input).toMatchObject({ name: "保存名", description: "用途", content: {
      blocks: [paragraph("first", "最新本文")], overlaySnapshot: { shapes: [{ id: "latest", props: { w: 112 } }] },
    } });
    expect(input.content.blocks[0]).not.toBe(f.documentRef.current.content[0]);
    const saved = material("saved", { ...input });
    await act(async () => { saving.resolve(saved); await work; });
    expect(controller.materials).toEqual([saved]);
    expect(controller.materialNameDraft).toBe("");
    expect(controller.materialDescriptionDraft).toBe("");
    expect(f.options.setStatusMessage).toHaveBeenCalledWith(tEditor("status.materialSaved"));

    act(() => controller.setMaterialNameDraft("再試行"));
    f.repository.createMaterial.mockRejectedValue(new Error("storage unavailable"));
    await act(async () => { await controller.saveSelectedMaterial(); });
    expect(controller.materialNameDraft).toBe("再試行");
    expect(controller.materialError).toBe("storage unavailable");
    expect(controller.materials).toEqual([saved]);
    expect(controller.materialsLoading).toBe(false);
  });

  it("keeps the add dialog's captured blocks through selection changes and failed saves", async () => {
    const f = fixture();
    await load(f.options);
    act(() => controller.openMaterialAddDialog(null, ["second", "first"]));
    expect(controller.materialAddContent?.blocks.map((block) => block.id)).toEqual(["first", "second"]);
    const captured = controller.materialAddContent;
    f.documentRef.current = { ...f.documentRef.current, content: [paragraph("elsewhere")] };
    f.selectedIdRef.current = "elsewhere";
    act(() => controller.setMaterialAddName("二つの本文"));
    f.repository.createMaterial.mockRejectedValueOnce(new Error("retry"));
    await act(async () => { await controller.confirmMaterialAddDialog(); });
    expect(controller.materialAddDialogOpen).toBe(true);
    expect(controller.materialAddContent).toBe(captured);
    expect(controller.materialAddName).toBe("二つの本文");
    f.repository.createMaterial.mockImplementationOnce(async (input) => material("added", input));
    await act(async () => { await controller.confirmMaterialAddDialog(); });
    expect(f.repository.createMaterial.mock.calls[1][0].content).toBe(captured);
    expect(controller.materialAddDialogOpen).toBe(false);
    expect(controller.materialAddContent).toBeNull();
    expect(controller.materialAddName).toBe("");
    expect(f.commitDocumentChange).not.toHaveBeenCalled();
  });

  it("flushes material edits and reads synchronous content updates before awaiting persistence", async () => {
    const original = material();
    const f = fixture([original]);
    await load(f.options);
    act(() => controller.startEditingMaterial(original));
    expect(controller.materialEditingOpenRef.current).toBe(true);
    expect(controller.materialEditingContent).toEqual(original.content);
    expect(controller.materialEditingContent).not.toBe(original.content);
    act(() => controller.setMaterialEditingDraft({ ...controller.materialEditingDraft, name: "変更後" }));
    const flushed = { ...content("flush 済み本文"), overlaySnapshot: { version: 1 as const, shapes: [rectangle("resized", 112)], assets: {} } };
    const updateContent = controller.updateMaterialEditingContent;
    const flush = () => updateContent(flushed);
    window.addEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flush);
    const pending = deferred<MaterialItem>();
    f.repository.updateMaterialMetadata.mockReturnValue(pending.promise);
    let saving!: Promise<void>;
    try {
      act(() => { saving = controller.renameMaterial(original); });
      expect(f.repository.updateMaterialMetadata).toHaveBeenCalledWith(original.id, expect.objectContaining({ name: "変更後", content: flushed }));
      expect(f.repository.updateMaterialMetadata.mock.calls[0][1].content).toBe(flushed);
      expect(controller.materialEditingOpenRef.current).toBe(true);
      expect(controller.materialsLoading).toBe(true);
      const updated = material(original.id, { name: "変更後", content: flushed });
      await act(async () => { pending.resolve(updated); await saving; });
      expect(controller.materials).toEqual([updated]);
      expect(controller.materialEditingOpenRef.current).toBe(false);
      expect(controller.materialEditingContent).toBeNull();
      expect(controller.materialEditingItem).toBeNull();
      expect(controller.materialsLoading).toBe(false);
      // The editor surface may flush on unmount. It must not reopen the closed draft.
      act(() => updateContent(content("遅れて届いた内容")));
      expect(controller.materialEditingContent).toBeNull();
      expect(f.options.setStatusMessage).toHaveBeenCalledWith(tEditor("status.materialUpdated"));
    } finally {
      window.removeEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flush);
    }
  });

  it("retains an editing session on persistence failure and rejects official edits before opening it", async () => {
    const original = material();
    const f = fixture([original]);
    await load(f.options);
    act(() => controller.startEditingMaterial(material("official_tex_box_example")));
    expect(controller.materialEditingOpenRef.current).toBe(false);
    expect(controller.materialError).toBe(tEditor("status.officialMaterialRename"));
    act(() => controller.startEditingMaterial(original));
    const edited = content("保存待ち");
    act(() => controller.updateMaterialEditingContent(edited));
    f.repository.updateMaterialMetadata.mockRejectedValue(new Error("retry update"));
    await act(async () => { await controller.renameMaterial(original); });
    expect(controller.materialEditingOpenRef.current).toBe(true);
    expect(controller.materialEditingContent).toBe(edited);
    expect(controller.materialEditingItem).toBe(original);
    expect(controller.materialError).toBe("retry update");
    act(() => { controller.closeMaterialEditing(); controller.updateMaterialEditingContent(content("unmount")); });
    expect(controller.materialEditingContent).toBeNull();
  });

  it("uses selection inside the commit callback and preserves remapped overlay anchors", async () => {
    const f = fixture();
    await load(f.options);
    const source = content("挿入本文");
    source.overlaySnapshot.shapes.push({ ...rectangle("figure"), anchor: { type: "block", blockId: "source", dy: 5 } });
    const original = structuredClone(source);
    f.commitDocumentChange.mockImplementation((change) => {
      f.events.push("commit");
      f.selectedIdRef.current = "second";
      f.documentRef.current = { ...f.documentRef.current, metadata: { ...f.documentRef.current.metadata, title: "到着した更新" } };
      f.documentRef.current = typeof change === "function" ? change(f.documentRef.current) : change;
      return true;
    });
    act(() => controller.insertContentAt(source, null, { x: 24, y: 30 }));
    const inserted = f.documentRef.current.content[2];
    expect(f.documentRef.current.content.map((block) => block.id)).toEqual(["first", "second", inserted.id]);
    expect(inserted).toMatchObject({ type: "paragraph", children: [{ text: "挿入本文" }] });
    expect(inserted.id).not.toBe("source");
    expect(f.documentRef.current.pageLayout?.overlay?.overlaySnapshot?.shapes).toMatchObject([{ anchor: { type: "block", blockId: inserted.id, dy: 5 } }]);
    expect(f.documentRef.current.metadata.title).toBe("到着した更新");
    expect(f.selectedIdRef.current).toBe(inserted.id);
    expect(f.events).toEqual(["commit", "selection", "inline", "status"]);
    expect(source).toEqual(original);
  });

  it("replaces slash triggers, closes the insert dialog and waits for successful deletion", async () => {
    const saved = material();
    const f = fixture([saved]);
    await load(f.options);
    act(() => controller.insertMaterialAt(saved, "first", { x: 0, y: 0 }));
    expect(f.documentRef.current.content.map((block) => block.id)).not.toContain("first");
    expect(f.documentRef.current.content.at(-1)?.id).toBe("second");
    act(() => { controller.setMaterialLibraryOpen(true); controller.openMaterialActionMenu(menuEvent(), saved); });
    act(() => controller.insertMaterialFromDialog(saved));
    expect(controller.materialLibraryOpen).toBe(false);
    expect(controller.materialActionMenu).toBeNull();
    act(() => controller.openMaterialActionMenu(menuEvent(), saved));
    const pending = deferred<Awaited<ReturnType<MaterialRepository["deleteMaterial"]>>>();
    f.repository.deleteMaterial.mockReturnValue(pending.promise);
    let deleting!: Promise<void>;
    act(() => { deleting = controller.deleteMaterial(saved); });
    expect(controller.materials).toEqual([saved]);
    expect(controller.materialActionMenu?.materialId).toBe(saved.id);
    await act(async () => { pending.resolve({ ok: true }); await deleting; });
    expect(controller.materials).toEqual([]);
    expect(controller.materialActionMenu).toBeNull();
  });

  it("captures DOM text selection and preserves the previous block when the anchor is missing", async () => {
    const f = fixture();
    await load(f.options);
    container.innerHTML = '<p data-sigma-doc-id="second"><span>本文</span></p><p data-sigma-doc-id="missing">missing</p>';
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(container.querySelector("span")!);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(controller.captureMaterialBlockSelectionFromDom()).toBe("second");
    expect(f.materialBlockSelectionRef.current).toBe("second");
    range.selectNodeContents(container.querySelectorAll("p")[1]);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(controller.captureMaterialBlockSelectionFromDom()).toBe("second");
    selection.removeAllRanges();
    expect(controller.captureMaterialBlockSelectionFromDom()).toBe("second");
    f.selectedIdRef.current = null;
    f.materialBlockSelectionRef.current = null;
    act(() => controller.openMaterialAddDialog());
    expect(controller.materialAddDialogOpen).toBe(false);
    expect(controller.materialError).toBe(tEditor("status.selectMaterialSource"));
    expect(f.options.setStatusMessage).toHaveBeenCalledWith(tEditor("status.selectMaterialSource"));
  });

  it("closes action menus on global events and unregisters listeners after closing", async () => {
    const f = fixture([material()]);
    await load(f.options);
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const saved = material();
    for (const event of [new Event("resize"), new Event("click"), new KeyboardEvent("keydown", { key: "Escape" }), new Event("scroll")]) {
      const mouse = menuEvent();
      act(() => controller.openMaterialActionMenu(mouse, saved));
      expect(mouse.preventDefault).toHaveBeenCalledOnce();
      expect(mouse.stopPropagation).toHaveBeenCalledOnce();
      expect(controller.materialActionMenu).toEqual({ materialId: saved.id, x: 112, y: 106 });
      act(() => window.dispatchEvent(event));
      expect(controller.materialActionMenu).toBeNull();
    }
    const tracked = new Set(["click", "resize", "scroll", "keydown"]);
    expect(remove.mock.calls.filter(([type]) => tracked.has(type))).toEqual(add.mock.calls.filter(([type]) => tracked.has(type)));
    act(() => controller.openMaterialActionMenu(menuEvent(), saved));
    act(() => controller.openMaterialActionMenu(menuEvent(), saved));
    expect(controller.materialActionMenu).toBeNull();
  });

  it("renders library filtering and routes menu insertion through the document commit", async () => {
    const f = fixture([material("target", { name: "図の素材", description: "用途" }), material("other")]);
    act(() => root.render(<Probe options={f.options} showDialogs />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    act(() => { controller.setMaterialLibraryOpen(true); controller.setMaterialSearch("図の素材"); });
    expect(container.querySelectorAll(".material-library-item")).toHaveLength(1);
    expect(container.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe(tEditor("material.title"));
    const menu = container.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!;
    act(() => menu.click());
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const insert = container.querySelector<HTMLButtonElement>("[role=menu] button")!;
    expect(insert).not.toBeNull();
    act(() => insert.click());
    expect(f.commitDocumentChange).toHaveBeenCalledOnce();
    expect(container.querySelector(".material-library-dialog")).toBeNull();
    expect(controller.materialLibraryOpen).toBe(false);
  });

  it("submits the add dialog with Enter and cancels with Escape without saving", async () => {
    const f = fixture();
    f.repository.createMaterial.mockImplementation(async (input) => material("created", input));
    act(() => root.render(<Probe options={f.options} showDialogs />));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    act(() => controller.openMaterialAddDialog("first"));
    act(() => controller.setMaterialAddName("キーで追加"));
    const input = container.querySelector<HTMLInputElement>(".material-add-name-field input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(f.repository.createMaterial).toHaveBeenCalledWith(expect.objectContaining({ name: "キーで追加" }));
    expect(controller.materialAddDialogOpen).toBe(false);
    expect(container.querySelector(".material-add-dialog")).toBeNull();
    act(() => controller.openMaterialAddDialog("first"));
    const cancelInput = container.querySelector<HTMLInputElement>(".material-add-name-field input")!;
    act(() => cancelInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(controller.materialAddDialogOpen).toBe(false);
    expect(controller.materialAddContent).toBeNull();
    expect(f.repository.createMaterial).toHaveBeenCalledOnce();
  });
});
