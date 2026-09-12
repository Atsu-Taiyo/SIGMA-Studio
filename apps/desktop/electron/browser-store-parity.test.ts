import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalSigmaDocStore } from "./local-sigma-doc-store";
import { createBlankDocument } from "@/lib/blank-document";
import { createBrowserRuntime } from "@/lib/runtime/browser/browser-runtime";
import { createStorageChangeChannel } from "@/lib/runtime/browser/change-channel";
import { createMemoryStoreBackend } from "@/lib/runtime/browser/memory-backend";
import type { AppRuntime, WorkspaceOverview } from "@/lib/runtime/types";

/**
 * デスクトップ (fs) とブラウザ (IndexedDB) は保管層が別物で、台帳の書き換えも
 * それぞれのコードが持っている。**同じ操作列を流したら同じ形になる**ことを
 * ここで縛る。片方だけ直したときに落ちるのがこのテストの役目。
 *
 * ID と時刻は実装ごとに違うので、比較するのは「人が見る形」= 名前・入れ子・件数。
 */
interface ComparableOverview {
  activeWorkspaceName: string;
  workspaceNames: string[];
  folders: Array<{ name: string; parentFolderName: string | null; fileCount: number }>;
  files: Array<{ title: string; folderName: string | null }>;
}

function toComparable(overview: WorkspaceOverview): ComparableOverview {
  const folderNameById = new Map(overview.folders.map((folder) => [folder.id, folder.name]));
  return {
    activeWorkspaceName: overview.workspaces
      .find((workspace) => workspace.id === overview.activeWorkspaceId)?.name ?? "",
    workspaceNames: overview.workspaces.map((workspace) => workspace.name),
    folders: overview.folders.map((folder) => ({
      name: folder.name,
      parentFolderName: folder.parentFolderId ? folderNameById.get(folder.parentFolderId) ?? "" : null,
      fileCount: folder.fileCount,
    })),
    files: overview.files.map((file) => ({
      title: file.title,
      folderName: file.folderId ? folderNameById.get(file.folderId) ?? "" : null,
    })),
  };
}

/** どちらのストアも同じ順番で呼べるように、必要な操作だけを抜き出した窓口。 */
interface ParityStore {
  initialize(): Promise<void>;
  createDocument(title: string): Promise<string>;
  createFolder(workspaceId: string, name: string, parentFolderId: string | null): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  moveFileToFolder(workspaceId: string, fileId: string, folderId: string | null): Promise<void>;
  moveFileToWorkspace(fileId: string, workspaceId: string): Promise<void>;
  deleteFolder(workspaceId: string, folderId: string): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  overview(workspaceId?: string | null): Promise<WorkspaceOverview>;
}

function desktopParityStore(store: LocalSigmaDocStore): ParityStore {
  const readOverview = async (workspaceId?: string | null): Promise<WorkspaceOverview> => {
    const result = await store.getWorkspaceOverview(workspaceId);
    if (result.state !== "ready") {
      throw new Error(`desktop overview failed: ${JSON.stringify(result)}`);
    }
    return result.overview;
  };

  return {
    async initialize() {
      await store.initializeWorkspace({ initialDocument: createBlankDocument() });
    },
    async createDocument(title) {
      const created = await store.createDocument({ title });
      return created.file.fileId;
    },
    async createFolder(workspaceId, name, parentFolderId) {
      await store.createFolder(workspaceId, name, parentFolderId);
    },
    async createWorkspace(name) {
      await store.createWorkspace(name);
    },
    async renameWorkspace(workspaceId, name) {
      await store.renameWorkspace(workspaceId, name);
    },
    async moveFileToFolder(workspaceId, fileId, folderId) {
      await store.moveFileToFolder(workspaceId, fileId, folderId);
    },
    async moveFileToWorkspace(fileId, workspaceId) {
      await store.moveFileToWorkspace(fileId, workspaceId, null);
    },
    async deleteFolder(workspaceId, folderId) {
      await store.deleteFolder(workspaceId, folderId);
    },
    async deleteFile(fileId) {
      await store.deleteFile(fileId);
    },
    overview: readOverview,
  };
}

function browserParityStore(runtime: AppRuntime): ParityStore {
  const readOverview = async (workspaceId?: string | null): Promise<WorkspaceOverview> => {
    const result = await runtime.workspace.listOverview(workspaceId);
    if (result.state !== "ready") {
      throw new Error(`browser overview failed: ${JSON.stringify(result)}`);
    }
    return result.overview;
  };

  return {
    async initialize() {
      await runtime.library.initializeWorkspace();
    },
    async createDocument(title) {
      return (await runtime.library.createDocument({ title })).fileId;
    },
    async createFolder(workspaceId, name, parentFolderId) {
      await runtime.workspace.createFolder(workspaceId, name, parentFolderId);
    },
    async createWorkspace(name) {
      await runtime.workspace.createWorkspace(name);
    },
    async renameWorkspace(workspaceId, name) {
      await runtime.workspace.renameWorkspace(workspaceId, name);
    },
    async moveFileToFolder(workspaceId, fileId, folderId) {
      await runtime.workspace.moveFileToFolder(workspaceId, fileId, folderId);
    },
    async moveFileToWorkspace(fileId, workspaceId) {
      await runtime.workspace.moveFileToWorkspace(fileId, workspaceId, null);
    },
    async deleteFolder(workspaceId, folderId) {
      await runtime.workspace.deleteFolder(workspaceId, folderId);
    },
    async deleteFile(fileId) {
      await runtime.library.deleteFile(fileId);
    },
    overview: readOverview,
  };
}

/**
 * 台帳を一巡させる操作列。返すのは最後の overview。
 *
 * 起動時に自動生成される 1 件目の教材だけは題名の既定値が実装ごとに違う
 * (desktop は "サンプル教材"、web は空文書の題名) ので、比較の前に落とす。
 */
async function runOperationSequence(store: ParityStore): Promise<ComparableOverview> {
  await store.initialize();
  const seeded = (await store.overview()).files.map((file) => file.fileId);

  const first = await store.overview();
  const workspaceId = first.activeWorkspaceId;
  const fileId = await store.createDocument("一次関数");
  await store.createFolder(workspaceId, "単元1", null);
  const withFolder = await store.overview(workspaceId);
  const folderId = withFolder.folders[0].id;
  await store.createFolder(workspaceId, "小テスト", folderId);
  await store.moveFileToFolder(workspaceId, fileId, folderId);

  await store.createWorkspace("2つ目");
  const withSecond = await store.overview();
  const secondWorkspaceId = withSecond.activeWorkspaceId;
  await store.renameWorkspace(secondWorkspaceId, "教材棚");

  const spare = await store.createDocument("移動する教材");
  await store.moveFileToWorkspace(spare, workspaceId);
  await store.deleteFile(spare);

  const nested = (await store.overview(workspaceId)).folders
    .find((folder) => folder.name === "小テスト");
  await store.deleteFolder(workspaceId, nested?.id ?? "");

  const overview = await store.overview(workspaceId);
  return toComparable({
    ...overview,
    files: overview.files.filter((file) => !seeded.includes(file.fileId)),
  });
}

describe("browser store parity with the desktop store", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-parity-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("produces the same workspace shape for the same operation sequence", async () => {
    const desktop = await runOperationSequence(desktopParityStore(new LocalSigmaDocStore(userDataDir)));
    const browser = await runOperationSequence(browserParityStore(createBrowserRuntime({
      backend: createMemoryStoreBackend(),
      channel: createStorageChangeChannel(),
      persistent: true,
    })));

    expect(browser).toEqual(desktop);
    expect(desktop.files).toEqual([{ title: "一次関数", folderName: "単元1" }]);
    expect(desktop.folders).toEqual([{ name: "単元1", parentFolderName: null, fileCount: 1 }]);
    expect(desktop.workspaceNames).toEqual(expect.arrayContaining(["教材棚"]));
  });

  it("keeps desktop and browser version list/get/capture behavior aligned", async () => {
    const desktopStore = new LocalSigmaDocStore(userDataDir);
    const desktopState = await desktopStore.initializeWorkspace({ initialDocument: createBlankDocument("版") });
    const desktopFile = (await desktopStore.listFiles()).find((file) => file.fileId === desktopState.activeFileId)!;
    const desktopDocument = (await desktopStore.loadDocument(desktopFile.fileId))!;
    const desktopChanged = { ...desktopDocument, metadata: { title: "版2" } };
    const desktopSaved = await desktopStore.saveDocument(desktopFile.fileId, desktopChanged, {
      expectedRevision: desktopFile.revision,
      origin: "ai",
    });
    await desktopStore.captureDocumentVersion(desktopFile.fileId, desktopChanged, {
      expectedRevision: desktopSaved.revision!,
      origin: "restore-backup",
    });

    const browser = createBrowserRuntime({
      backend: createMemoryStoreBackend(),
      channel: createStorageChangeChannel(),
      persistent: true,
    });
    const browserState = await browser.library.initializeWorkspace();
    if (!browserState.ok) throw new Error("browser initialization failed");
    const browserFile = (await browser.library.listFiles()).find((file) => file.fileId === browserState.state.activeFileId)!;
    const browserDocument = (await browser.library.loadDocument(browserFile.fileId))!;
    const browserChanged = { ...browserDocument, metadata: { title: "版2" } };
    const browserSaved = await browser.library.saveDocument(browserFile.fileId, browserChanged, {
      expectedRevision: browserFile.revision,
      origin: "ai",
    });
    await browser.library.captureDocumentVersion(browserFile.fileId, browserChanged, {
      expectedRevision: browserSaved.revision!,
      origin: "restore-backup",
    });

    const desktopUnchanged = await desktopStore.saveDocument(desktopFile.fileId, structuredClone(desktopChanged), {
      expectedRevision: desktopSaved.revision!,
      origin: "ai",
    });
    const browserUnchanged = await browser.library.saveDocument(browserFile.fileId, structuredClone(browserChanged), {
      expectedRevision: browserSaved.revision!,
      origin: "ai",
    });
    expect(await desktopStore.listDocumentVersions(desktopFile.fileId)).toHaveLength(2);
    expect(await browser.library.listDocumentVersions(browserFile.fileId)).toHaveLength(2);

    // Both implementations must compact at the same boundary and retain the same
    // newest 200 entries. Forced restore backups let this exercise pruning without
    // changing either store's document revision between captures.
    for (let index = 0; index < 199; index += 1) {
      await desktopStore.captureDocumentVersion(desktopFile.fileId, desktopChanged, {
        expectedRevision: desktopUnchanged.revision!,
        origin: "restore-backup",
      });
      await browser.library.captureDocumentVersion(browserFile.fileId, browserChanged, {
        expectedRevision: browserUnchanged.revision!,
        origin: "restore-backup",
      });
    }

    const desktopVersions = await desktopStore.listDocumentVersions(desktopFile.fileId);
    const browserVersions = await browser.library.listDocumentVersions(browserFile.fileId);
    expect(desktopVersions).toHaveLength(200);
    expect(browserVersions).toHaveLength(200);
    expect(browserVersions.map(({ origin, revision }) => ({ origin, revision })))
      .toEqual(desktopVersions.map(({ origin, revision }) => ({ origin, revision })));
    expect((await browser.library.getDocumentVersion(browserFile.fileId, browserVersions[0]!.versionId))?.document.metadata.title)
      .toBe((await desktopStore.getDocumentVersion(desktopFile.fileId, desktopVersions[0]!.versionId))?.document.metadata.title);

    await desktopStore.deleteFile(desktopFile.fileId);
    await browser.library.deleteFile(browserFile.fileId);
    expect(await desktopStore.listDocumentVersions(desktopFile.fileId)).toEqual([]);
    expect(await browser.library.listDocumentVersions(browserFile.fileId)).toEqual([]);
  });

  it("keeps boundary capture semantics aligned after an unversioned autosave", async () => {
    const desktopStore = new LocalSigmaDocStore(userDataDir);
    const desktopState = await desktopStore.initializeWorkspace({ initialDocument: createBlankDocument("initial") });
    const desktopFile = (await desktopStore.listFiles()).find((file) => file.fileId === desktopState.activeFileId)!;
    const browser = createBrowserRuntime({
      backend: createMemoryStoreBackend(),
      channel: createStorageChangeChannel(),
      persistent: true,
    });
    const browserState = await browser.library.initializeWorkspace();
    if (!browserState.ok) throw new Error("browser initialization failed");
    const browserFile = (await browser.library.listFiles()).find((file) => file.fileId === browserState.state.activeFileId)!;

    const desktopFirst = await desktopStore.saveDocument(desktopFile.fileId, createBlankDocument("version"), { expectedRevision: desktopFile.revision, origin: "ai" });
    const browserFirst = await browser.library.saveDocument(browserFile.fileId, createBlankDocument("version"), { expectedRevision: browserFile.revision, origin: "ai" });
    const desktopAutosave = await desktopStore.saveDocument(desktopFile.fileId, createBlankDocument("autosave"), { expectedRevision: desktopFirst.revision!, origin: "user" });
    const browserAutosave = await browser.library.saveDocument(browserFile.fileId, createBlankDocument("autosave"), { expectedRevision: browserFirst.revision!, origin: "user" });
    const desktopBoundary = await desktopStore.saveDocument(desktopFile.fileId, createBlankDocument("autosave"), { expectedRevision: desktopAutosave.revision!, origin: "tab-switch" });
    const browserBoundary = await browser.library.saveDocument(browserFile.fileId, createBlankDocument("autosave"), { expectedRevision: browserAutosave.revision!, origin: "tab-switch" });

    expect({ captured: browserBoundary.versionCaptured, origins: (await browser.library.listDocumentVersions(browserFile.fileId)).map((version) => version.origin) })
      .toEqual({ captured: desktopBoundary.versionCaptured, origins: (await desktopStore.listDocumentVersions(desktopFile.fileId)).map((version) => version.origin) });
  });
});
