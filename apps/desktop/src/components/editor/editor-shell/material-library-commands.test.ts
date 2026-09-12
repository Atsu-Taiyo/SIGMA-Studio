import { describe, expect, it, vi } from "vitest";

import type { MaterialRepository } from "@/lib/runtime/types";
import type { MaterialContent, MaterialItem } from "@/types/material";
import {
  createLibraryMaterial,
  deleteLibraryMaterial,
  loadMaterialLibrary,
  updateLibraryMaterial,
} from "./material-library-commands";
import { createEmptyMaterialMetadataDraft } from "./material-metadata-draft";

function content(): MaterialContent {
  return {
    blocks: [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text: "body" }] }],
    overlaySnapshot: { version: 1, shapes: [], assets: {} },
  };
}

function material(id: string, overrides: Partial<MaterialItem> = {}): MaterialItem {
  return {
    id, version: 1, name: id, content: content(),
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(initial: MaterialItem[] = []) {
  const state = { materials: initial, loading: false, error: "previous error" as string | null, locale: "ja" };
  const events: string[] = [];
  const repository = {
    listMaterials: vi.fn<MaterialRepository["listMaterials"]>(),
    createMaterial: vi.fn<MaterialRepository["createMaterial"]>(),
    renameMaterial: vi.fn<MaterialRepository["renameMaterial"]>(),
    updateMaterialMetadata: vi.fn<MaterialRepository["updateMaterialMetadata"]>(),
    deleteMaterial: vi.fn<MaterialRepository["deleteMaterial"]>(),
  } satisfies MaterialRepository;
  const ports = {
    getRepository: vi.fn(() => { events.push("repository"); return repository; }),
    setMaterials(value: MaterialItem[] | ((current: MaterialItem[]) => MaterialItem[])) {
      events.push("materials");
      state.materials = typeof value === "function" ? value(state.materials) : value;
    },
    setLoading(loading: boolean) { events.push(`loading:${loading}`); state.loading = loading; },
    setError(error: string | null) { events.push(`error:${error}`); state.error = error; },
    translate: (key: string) => `${state.locale}:${key}`,
    onCreated: vi.fn(() => { events.push(`created:${state.locale}`); }),
    onUpdated: vi.fn(() => { events.push(`updated:${state.locale}`); }),
    closeEditing: vi.fn(() => { events.push("closeEditing"); }),
    closeMenu: vi.fn(() => { events.push("closeMenu"); }),
  };
  return { state, events, repository, ports };
}

const edit = (value: MaterialContent = content(), name = " updated ") => ({
  draft: { ...createEmptyMaterialMetadataDraft(), name }, content: value,
});

describe("material library commands", () => {
  it("loads the current repository without changing the visible list before completion", async () => {
    const old = material("old");
    const loaded = material("loaded");
    const h = harness([old]);
    const pending = deferred<MaterialItem[]>();
    h.repository.listMaterials.mockReturnValue(pending.promise);

    const loading = loadMaterialLibrary(h.ports);
    expect(h.state).toMatchObject({ materials: [old], loading: true, error: "previous error" });
    expect(h.events).toEqual(["loading:true", "repository"]);

    pending.resolve([loaded, material("official_tex_box_hidden"), material("hidden", { source: "official" })]);
    await loading;
    expect(h.state).toMatchObject({ materials: [loaded], loading: false, error: null });
    expect(h.events).toEqual(["loading:true", "repository", "materials", "error:null", "loading:false"]);
  });

  it("creates normalized metadata, prepends the saved item and reconciles the latest list", async () => {
    const old = material("same", { name: "old" });
    const saved = material("same", { name: "saved" });
    const concurrent = material("concurrent");
    const h = harness([old]);
    const pending = deferred<MaterialItem>();
    h.repository.createMaterial.mockReturnValue(pending.promise);
    const source = content();
    const creating = createLibraryMaterial({
      content: source, requestedName: "  ", fallbackName: () => "fallback",
      metadataDraft: { ...createEmptyMaterialMetadataDraft(), description: " description ", aliases: "a, b、a", visualConcepts: "box, 箱" },
    }, h.ports);

    expect(h.repository.createMaterial).toHaveBeenCalledWith({
      name: "fallback", description: "description", usage: { aliases: ["a", "b"] },
      visualConcepts: ["box", "箱"], content: source,
    });
    expect(h.state.materials).toEqual([old]);
    h.state.materials = [concurrent, old, material("official_tex_box_hidden")];
    h.state.locale = "en";
    pending.resolve(saved);

    expect(await creating).toBe(saved);
    expect(h.state.materials).toEqual([saved, concurrent]);
    expect(h.events).toEqual(["loading:true", "repository", "materials", "error:null", "created:en", "loading:false"]);
  });

  it("infers scale permissions and attachment ports only for content with shapes", async () => {
    const h = harness();
    h.repository.createMaterial.mockResolvedValue(material("created"));
    const source = content();
    source.overlaySnapshot.shapes = [{
      id: "image", type: "image", x: 10, y: 20,
      props: { assetId: "asset", w: 100, h: 40 },
    }];
    await createLibraryMaterial({ content: source, requestedName: "  drawing  ", fallbackName: () => "fallback" }, h.ports);
    const input = h.repository.createMaterial.mock.calls[0][0];
    expect(input.name).toBe("drawing");
    expect(input.transformPolicy).toEqual({ scale: true, rotate: false });
    expect(input.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "leftEnd", x: 10, y: 40 }),
      expect.objectContaining({ kind: "rightEnd", x: 110, y: 40 }),
    ]));
  });

  it("flushes and reads edits synchronously, updates the latest list, then closes the editor", async () => {
    const old = material("edited");
    const concurrent = material("concurrent");
    const h = harness([old]);
    const pending = deferred<MaterialItem>();
    h.repository.updateMaterialMetadata.mockReturnValue(pending.promise);
    let latestContent = old.content;
    const flushedContent = content();
    flushedContent.blocks[0].id = "flushed";
    const readEdit = vi.fn(() => {
      h.events.push("flush");
      latestContent = flushedContent;
      return edit(latestContent);
    });
    const updating = updateLibraryMaterial(old, readEdit, h.ports);

    expect(readEdit).toHaveBeenCalledOnce();
    expect(h.events).toEqual(["flush", "loading:true", "repository"]);
    expect(h.repository.updateMaterialMetadata).toHaveBeenCalledWith(old.id, {
      name: "updated", content: flushedContent, description: "", usage: {}, visualConcepts: [],
    });
    expect(h.ports.closeEditing).not.toHaveBeenCalled();
    h.state.materials = [concurrent, old];
    const saved = material(old.id, { content: flushedContent });
    pending.resolve(saved);
    await updating;
    expect(h.state.materials).toEqual([concurrent, saved]);
    expect(h.events).toEqual([
      "flush", "loading:true", "repository", "materials", "closeEditing", "closeMenu", "error:null", "updated:ja", "loading:false",
    ]);
  });

  it.each(["rename", "delete"] as const)("protects official items during %s before reading edits or storage", async (command) => {
    for (const official of [material("official_tex_box_legacy"), material("official", { source: "official" })]) {
      const h = harness([official]);
      const readEdit = vi.fn(() => edit());
      if (command === "rename") await updateLibraryMaterial(official, readEdit, h.ports);
      else await deleteLibraryMaterial(official, h.ports);
      expect(readEdit).not.toHaveBeenCalled();
      expect(h.ports.getRepository).not.toHaveBeenCalled();
      expect(h.state.materials).toEqual([official]);
      expect(h.events).toEqual(command === "rename"
        ? ["error:ja:status.officialMaterialRename", "closeEditing", "closeMenu"]
        : ["error:ja:status.officialMaterialDelete", "closeMenu"]);
    }
  });

  it.each(["blank name", "empty content"])("retains the editor and skips storage for %s", async (invalid) => {
    const h = harness();
    const empty: MaterialContent = { blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } };
    const readEdit = vi.fn(() => invalid === "blank name" ? edit(content(), "  ") : edit(empty));
    await updateLibraryMaterial(material("edited"), readEdit, h.ports);
    expect(readEdit).toHaveBeenCalledOnce();
    expect(h.ports.getRepository).not.toHaveBeenCalled();
    expect(h.ports.closeEditing).not.toHaveBeenCalled();
    expect(h.events).toEqual(invalid === "blank name" ? [] : ["error:ja:status.materialNeedsContent"]);
  });

  it("retains menu and content while deleting, and removes only the requested item after success", async () => {
    const deleted = material("deleted");
    const kept = material("kept");
    const h = harness([deleted]);
    const pending = deferred<{ ok: true }>();
    h.repository.deleteMaterial.mockReturnValue(pending.promise);
    const deleting = deleteLibraryMaterial(deleted, h.ports);
    expect(h.ports.closeMenu).not.toHaveBeenCalled();
    expect(h.state.materials).toEqual([deleted]);
    h.state.materials = [kept, deleted];
    pending.resolve({ ok: true });
    await deleting;
    expect(h.repository.deleteMaterial).toHaveBeenCalledWith(deleted.id);
    expect(h.state.materials).toEqual([kept]);
    expect(h.events).toEqual(["loading:true", "repository", "materials", "closeMenu", "error:null", "loading:false"]);
  });

  it.each([
    ["load", "status.materialsLoadFailed"],
    ["create", "status.materialSaveFailed"],
    ["update", "status.materialSaveFailed"],
    ["delete", "status.materialDeleteFailed"],
  ] as const)("preserves state after %s failure and resolves fallback text in the completion locale", async (command, errorKey) => {
    for (const failure of ["unknown error", new Error("repository error")]) {
      const old = material("old");
      const h = harness([old]);
      const pending = deferred<never>();
      h.repository.listMaterials.mockReturnValue(pending.promise);
      h.repository.createMaterial.mockReturnValue(pending.promise);
      h.repository.updateMaterialMetadata.mockReturnValue(pending.promise);
      h.repository.deleteMaterial.mockReturnValue(pending.promise);
      const result = command === "load" ? loadMaterialLibrary(h.ports)
        : command === "create" ? createLibraryMaterial({ content: content(), requestedName: "new", fallbackName: () => "fallback" }, h.ports)
          : command === "update" ? updateLibraryMaterial(old, () => edit(), h.ports)
            : deleteLibraryMaterial(old, h.ports);
      h.state.locale = "en";
      pending.reject(failure);
      if (command === "create") expect(await result).toBeNull();
      else await result;
      expect(h.state).toMatchObject({ materials: [old], loading: false, error: failure instanceof Error ? failure.message : `en:${errorKey}` });
      expect(h.ports.closeEditing).not.toHaveBeenCalled();
      expect(h.ports.closeMenu).not.toHaveBeenCalled();
      expect(h.ports.onCreated).not.toHaveBeenCalled();
      expect(h.ports.onUpdated).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "", "cannot delete"])("preserves a failed deletion result with error %s", async (error) => {
    const old = material("old");
    const h = harness([old]);
    h.repository.deleteMaterial.mockResolvedValue({ ok: false, error });
    await deleteLibraryMaterial(old, h.ports);
    expect(h.state).toMatchObject({ materials: [old], loading: false, error: error ?? "ja:status.materialDeleteFailed" });
    expect(h.ports.closeMenu).not.toHaveBeenCalled();
  });

  it("handles runtime lookup failures after setting loading and preserves the list", async () => {
    const old = material("old");
    const h = harness([old]);
    h.ports.getRepository.mockImplementation(() => { throw new Error("runtime unavailable"); });
    await loadMaterialLibrary(h.ports);
    expect(h.state).toMatchObject({ materials: [old], loading: false, error: "runtime unavailable" });
    expect(h.events).toEqual(["loading:true", "error:runtime unavailable", "loading:false"]);
  });
});
