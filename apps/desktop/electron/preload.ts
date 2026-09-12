import { contextBridge, ipcRenderer } from "electron";

type AiEditEvent = unknown;

let runCounter = 0;

const desktopAPI = {
  isDesktop: true as const,
  platform: process.platform,

  app: {
    getInfo(): Promise<{ version: string; releaseUrl: string }> {
      return ipcRenderer.invoke("app:get-info");
    },
    openLatestReleasePage(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("app:open-latest-release-page");
    },
    getEditorPreferences(): Promise<unknown> {
      return ipcRenderer.invoke("app:get-editor-preferences");
    },
    saveEditorPreferences(preferences: unknown): Promise<unknown> {
      return ipcRenderer.invoke("app:save-editor-preferences", preferences);
    },
    onCloseRequested(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("app:close-requested", listener);
      return () => ipcRenderer.removeListener("app:close-requested", listener);
    },
    acknowledgeCloseRequest(): Promise<boolean> {
      return ipcRenderer.invoke("app:close-ack");
    },
    notifyCloseReady(): Promise<boolean> {
      return ipcRenderer.invoke("app:close-ready");
    },
    cancelCloseRequest(): Promise<boolean> {
      return ipcRenderer.invoke("app:close-cancel");
    },
  },

  updater: {
    getStatus(): Promise<unknown> {
      return ipcRenderer.invoke("app-updater:get-status");
    },
    checkForUpdates(): Promise<unknown> {
      return ipcRenderer.invoke("app-updater:check");
    },
    downloadUpdate(): Promise<unknown> {
      return ipcRenderer.invoke("app-updater:download");
    },
    quitAndInstall(): Promise<unknown> {
      return ipcRenderer.invoke("app-updater:quit-and-install");
    },
    onStatusChange(handler: (status: unknown) => void): () => void {
      const listener = (_: unknown, status: unknown) => handler(status);
      ipcRenderer.on("app-updater:status-changed", listener);
      return () => ipcRenderer.removeListener("app-updater:status-changed", listener);
    },
  },

  inputSource: {
    switchToAscii(): Promise<unknown> {
      return ipcRenderer.invoke("input-source:switch-to-ascii");
    },
    restore(restoreToken: string): Promise<unknown> {
      return ipcRenderer.invoke("input-source:restore", restoreToken);
    },
  },

  shell: {
    openExternal(url: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("shell:open-external", url);
    },
  },

  settings: {
    get(): Promise<unknown> {
      return ipcRenderer.invoke("settings:get");
    },
    setCommandShortcuts(value: unknown): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-command-shortcuts", value);
    },
    setCustomCommands(value: unknown): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-custom-commands", value);
    },
    setCommandConfig(value: unknown): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-command-config", value);
    },
    setAiAutoApplyVerifiedProposals(value: boolean): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-ai-auto-apply-verified-proposals", value);
    },
    setAiWebSearchEnabled(value: boolean): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-ai-web-search-enabled", value);
    },
    setUiLocale(value: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke("settings:set-ui-locale", value);
    },
    onAiSettingsChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("ai-settings:changed", listener);
      return () => ipcRenderer.removeListener("ai-settings:changed", listener);
    },
  },

  fonts: {
    list(): Promise<unknown> {
      return ipcRenderer.invoke("fonts:list");
    },
    importFont(): Promise<unknown> {
      return ipcRenderer.invoke("fonts:import");
    },
    deleteFont(fontId: string): Promise<unknown> {
      return ipcRenderer.invoke("fonts:delete", fontId);
    },
  },

  codex: {
    getStatus(): Promise<unknown> {
      return ipcRenderer.invoke("codex:get-status");
    },
    listModels(): Promise<unknown> {
      return ipcRenderer.invoke("codex:list-models");
    },
    setBin(path: string | null): Promise<unknown> {
      return ipcRenderer.invoke("codex:set-bin", path);
    },
    selectBin(): Promise<unknown> {
      return ipcRenderer.invoke("codex:select-bin");
    },
    login(): Promise<unknown> {
      return ipcRenderer.invoke("codex:login");
    },
    openInstallPage(): Promise<unknown> {
      return ipcRenderer.invoke("codex:open-install-page");
    },
    logout(): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke("codex:logout");
    },
    onStatusChange(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("codex:status-changed", listener);
      return () => ipcRenderer.removeListener("codex:status-changed", listener);
    },
  },

  claude: {
    getStatus(): Promise<unknown> {
      return ipcRenderer.invoke("claude:get-status");
    },
    listModels(): Promise<unknown> {
      return ipcRenderer.invoke("claude:list-models");
    },
    setBin(path: string | null): Promise<unknown> {
      return ipcRenderer.invoke("claude:set-bin", path);
    },
    selectBin(): Promise<unknown> {
      return ipcRenderer.invoke("claude:select-bin");
    },
    openInstallPage(): Promise<unknown> {
      return ipcRenderer.invoke("claude:open-install-page");
    },
    onStatusChange(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("claude:status-changed", listener);
      return () => ipcRenderer.removeListener("claude:status-changed", listener);
    },
  },

  gemini: {
    getStatus(): Promise<unknown> {
      return ipcRenderer.invoke("gemini:get-status");
    },
    listModels(): Promise<unknown> {
      return ipcRenderer.invoke("gemini:list-models");
    },
    setBin(path: string | null): Promise<unknown> {
      return ipcRenderer.invoke("gemini:set-bin", path);
    },
    selectBin(): Promise<unknown> {
      return ipcRenderer.invoke("gemini:select-bin");
    },
    openInstallPage(): Promise<unknown> {
      return ipcRenderer.invoke("gemini:open-install-page");
    },
    onStatusChange(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("gemini:status-changed", listener);
      return () => ipcRenderer.removeListener("gemini:status-changed", listener);
    },
  },

  aiEdit: {
    getGeneratedImage(runId: string, imageId: string): Promise<{ dataUrl: string | null }> {
      return ipcRenderer.invoke("ai-edit:generated-image", runId, imageId);
    },
    run(
      payload: unknown,
      onEvent: (event: AiEditEvent) => void,
      onRunId?: (runId: string) => void,
    ): Promise<unknown> {
      const runId = `r${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
      // Handed to the caller synchronously, before the IPC round-trip even
      // starts, so a stop/cancel action taken immediately after calling run()
      // always has a valid runId to pass to cancel().
      onRunId?.(runId);
      const channel = `ai-edit:event:${runId}`;
      const listener = (_: unknown, event: AiEditEvent) => {
        onEvent(event);
      };
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke("ai-edit:run", runId, payload).finally(() => {
        ipcRenderer.removeListener(channel, listener);
      });
    },
    cancel(runId: string): Promise<{ ok: boolean; cancelled: boolean }> {
      return ipcRenderer.invoke("ai-edit:cancel", runId);
    },
    listChatRooms(documentIdentityKey?: string): Promise<unknown> {
      return ipcRenderer.invoke("ai-edit:list-chat-rooms", documentIdentityKey);
    },
    saveChatRoom(room: unknown): Promise<unknown> {
      return ipcRenderer.invoke("ai-edit:save-chat-room", room);
    },
    deleteChatRoom(roomId: string): Promise<unknown> {
      return ipcRenderer.invoke("ai-edit:delete-chat-room", roomId);
    },
  },

  aiSkillDraft: {
    generate(
      payload: unknown,
      onEvent?: (event: { kind: "delta"; text: string }) => void,
      onRunId?: (runId: string) => void,
    ): Promise<unknown> {
      const runId = `sd${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
      // 呼び出し側へIPC往復前に同期で渡す。ai-edit.run と同じ理由: run開始直後に停止操作が
      // 来てもcancel()に渡すrunIdが必ずある状態にするため。
      onRunId?.(runId);
      const channel = `ai-skill-draft:event:${runId}`;
      const listener = (_: unknown, event: { kind: "delta"; text: string }) => {
        onEvent?.(event);
      };
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke("ai-skill-draft:generate", runId, payload).finally(() => {
        ipcRenderer.removeListener(channel, listener);
      });
    },
    cancel(runId: string): Promise<{ ok: boolean; cancelled: boolean }> {
      return ipcRenderer.invoke("ai-skill-draft:cancel", runId);
    },
  },

  aiResources: {
    getTree(): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:get-tree");
    },
    readFile(resourceId: string): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:read-file", resourceId);
    },
    saveFile(input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:save-file", input);
    },
    saveInstruction(input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:save-instruction", input);
    },
    createSkill(input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:create-skill", input);
    },
    deleteResource(resourceId: string): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:delete", resourceId);
    },
    setResourceEnabled(resourceId: string, enabled: boolean): Promise<unknown> {
      return ipcRenderer.invoke("ai-resources:set-enabled", resourceId, enabled);
    },
    onChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on("ai-resources:changed", listener);
      return () => ipcRenderer.removeListener("ai-resources:changed", listener);
    },
  },

  file: {
    openSigmaDoc(): Promise<{ filePath: string; data: string } | null> {
      return ipcRenderer.invoke("file:open-sigma-doc");
    },
    openImportDocument(): Promise<{ filePath: string; dataBase64: string } | null> {
      return ipcRenderer.invoke("file:open-import-document");
    },
    openImportOtherDocument(): Promise<{ filePath: string; dataBase64: string } | null> {
      return ipcRenderer.invoke("file:open-import-other-document");
    },
    saveSigmaDoc(payload: { suggestedName?: string; data: string }): Promise<{ filePath: string } | null> {
      return ipcRenderer.invoke("file:save-sigma-doc", payload);
    },
    exportPdf(payload: {
      suggestedName?: string;
      surfaceId: string;
      revision: number;
      pageCount: number;
      pageWidthMm: number;
      pageHeightMm: number;
    }): Promise<{ filePath: string; pageCount: number } | null> {
      return ipcRenderer.invoke("file:export-pdf", payload);
    },
    saveToDownloads(payload: { fileName: string; dataBase64: string }): Promise<{ filePath: string }> {
      return ipcRenderer.invoke("file:save-to-downloads", payload);
    },
    showInFolder(filePath: string): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke("file:show-in-folder", filePath);
    },
  },

  aiRender: {
    getRenderDocument(renderId: string): Promise<unknown> {
      return ipcRenderer.invoke("ai-render:get-document", renderId);
    },
  },

  materials: {
    listMaterials(): Promise<unknown> {
      return ipcRenderer.invoke("materials:list");
    },
    createMaterial(input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("materials:create", input);
    },
    renameMaterial(id: string, name: string): Promise<unknown> {
      return ipcRenderer.invoke("materials:rename", id, name);
    },
    updateMaterialMetadata(id: string, input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("materials:update-metadata", id, input);
    },
    deleteMaterial(id: string): Promise<unknown> {
      return ipcRenderer.invoke("materials:delete", id);
    },
  },

  templates: {
    listTemplates(workspaceId?: string | null): Promise<unknown> {
      return ipcRenderer.invoke("templates:list", workspaceId ?? null);
    },
    createTemplate(input: unknown): Promise<unknown> {
      return ipcRenderer.invoke("templates:create", input);
    },
    renameTemplate(id: string, name: string): Promise<unknown> {
      return ipcRenderer.invoke("templates:rename", id, name);
    },
    deleteTemplate(id: string): Promise<unknown> {
      return ipcRenderer.invoke("templates:delete", id);
    },
  },

  storage: {
    initializeWorkspace(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:initialize-workspace", payload);
    },
    listFiles(): Promise<unknown> {
      return ipcRenderer.invoke("storage:list-files");
    },
    loadDocument(fileId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:load-document", fileId);
    },
    loadDocumentWithRecovery(fileId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:load-document-with-recovery", fileId);
    },
    saveDocument(fileId: string, document: unknown, options: { expectedRevision: number; origin?: "user" | "ai" | "restore-backup" | "tab-switch" | "app-close" }): Promise<unknown> {
      return ipcRenderer.invoke("storage:save-document", fileId, document, options);
    },
    listDocumentVersions(fileId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:list-document-versions", fileId);
    },
    getDocumentVersion(fileId: string, versionId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:get-document-version", fileId, versionId);
    },
    captureDocumentVersion(fileId: string, document: unknown, options: { expectedRevision: number; origin: "user" | "ai" | "restore-backup" | "tab-switch" | "app-close" }): Promise<unknown> {
      return ipcRenderer.invoke("storage:capture-document-version", fileId, document, options);
    },
    createDocument(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:create-document", payload);
    },
    createFileFromDocument(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:create-file-from-document", payload);
    },
    duplicateFile(fileId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:duplicate-file", fileId);
    },
    deleteFile(fileId: string, options?: { expectedRevision: number }): Promise<unknown> {
      return ipcRenderer.invoke("storage:delete-file", fileId, options);
    },
    saveWorkspace(state: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:save-workspace", state);
    },
    getWorkspaceOverview(workspaceId?: string | null): Promise<unknown> {
      return ipcRenderer.invoke("storage:get-workspace-overview", workspaceId);
    },
    createWorkspace(name: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:create-workspace", name);
    },
    renameWorkspace(workspaceId: string, name: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:rename-workspace", workspaceId, name);
    },
    deleteWorkspace(workspaceId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:delete-workspace", workspaceId);
    },
    createFolder(workspaceId: string, name: string, parentFolderId?: string | null): Promise<unknown> {
      return ipcRenderer.invoke("storage:create-folder", workspaceId, name, parentFolderId);
    },
    updateFolder(workspaceId: string, folderId: string, patch: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:update-folder", workspaceId, folderId, patch);
    },
    deleteFolder(workspaceId: string, folderId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:delete-folder", workspaceId, folderId);
    },
    moveFileToFolder(workspaceId: string, fileId: string, folderId?: string | null): Promise<unknown> {
      return ipcRenderer.invoke("storage:move-file-to-folder", workspaceId, fileId, folderId);
    },
    moveFileToWorkspace(fileId: string, targetWorkspaceId: string, folderId?: string | null): Promise<unknown> {
      return ipcRenderer.invoke("storage:move-file-to-workspace", fileId, targetWorkspaceId, folderId);
    },
    getDataDir(): Promise<{ path: string }> {
      return ipcRenderer.invoke("storage:get-data-dir");
    },
    listMcpEditProposals(rawOptions?: unknown): Promise<unknown> {
      return ipcRenderer.invoke("storage:list-mcp-edit-proposals", rawOptions);
    },
    beginMcpProposalRun(roomId: string, fileId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:begin-mcp-proposal-run", roomId, fileId);
    },
    completeMcpProposalRun(snapshotId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:complete-mcp-proposal-run", snapshotId);
    },
    rollbackMcpProposalRun(snapshotId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:rollback-mcp-proposal-run", snapshotId);
    },
    approveMcpEditProposal(proposalId: string, options?: { force?: boolean }): Promise<unknown> {
      return ipcRenderer.invoke("storage:approve-mcp-edit-proposal", proposalId, options);
    },
    approveMcpEditProposals(proposalIds: string[], options?: { force?: boolean }): Promise<unknown> {
      return ipcRenderer.invoke("storage:approve-mcp-edit-proposals", proposalIds, options);
    },
    rejectMcpEditProposal(proposalId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:reject-mcp-edit-proposal", proposalId);
    },
    rejectMcpEditProposals(proposalIds: string[], reason?: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:reject-mcp-edit-proposals", { proposalIds, reason });
    },
    rebaseMcpEditProposal(proposalId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:rebase-mcp-edit-proposal", proposalId);
    },
    restoreMcpEditProposal(proposalId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:restore-mcp-edit-proposal", proposalId);
    },
    revertMcpEditProposal(proposalId: string): Promise<unknown> {
      return ipcRenderer.invoke("storage:revert-mcp-edit-proposal", proposalId);
    },
    markMcpEditProposalsReverted(proposalIds: string[]): Promise<unknown> {
      return ipcRenderer.invoke("storage:mark-mcp-edit-proposals-reverted", proposalIds);
    },
    markMcpEditProposalsReapplied(proposalIds: string[]): Promise<unknown> {
      return ipcRenderer.invoke("storage:mark-mcp-edit-proposals-reapplied", proposalIds);
    },
    onChange(handler: (event: unknown) => void): () => void {
      const listener = (_: unknown, event: unknown) => handler(event);
      ipcRenderer.on("storage:changed", listener);
      return () => ipcRenderer.removeListener("storage:changed", listener);
    },
  },

  workspacePreview: {
    get(fileId: string, revision: number): Promise<string | null> {
      return ipcRenderer.invoke("workspace-preview:get", { fileId, revision });
    },
    put(fileId: string, revision: number, dataUrl: string): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke("workspace-preview:put", { fileId, revision, dataUrl });
    },
  },

  onMenuAction(handler: (action: string) => void): () => void {
    const listener = (_: unknown, action: string) => handler(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);

export type DesktopAPI = typeof desktopAPI;
