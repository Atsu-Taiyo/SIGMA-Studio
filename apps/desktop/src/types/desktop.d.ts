import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { AiEditPlanStep, AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import type { SigmaDocument } from "@/features/document";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { SigmaDocumentRecoveryIssue, SigmaDocumentSchemaFailure } from "@/lib/sigma-doc-schema";
import type { MaterialContent, MaterialItem } from "@/types/material";
import type { TemplateItem } from "@/types/template";
import type { DocumentVersion, DocumentVersionMetadata, DocumentVersionOrigin } from "@/lib/document-version-history";
import type { WorkspaceLayoutV2 } from "@/lib/workspace-tab-groups";

export interface DesktopAiEditChatAttachmentSummary {
  id: string;
  name: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  dataUrl?: string | null;
  sourceReferenceKey?: string | null;
}

export interface DesktopAiEditChatMentionedDocumentSummary {
  id: string;
  fileId: string;
  title: string;
  documentPath: string;
  revision: number;
}

export interface DesktopAiEditChatUserTurn {
  id: string;
  role: "user";
  documentIdentityKey: string;
  instruction: string;
  references: AiEditReference[];
  attachments: DesktopAiEditChatAttachmentSummary[];
  mentionedDocuments: DesktopAiEditChatMentionedDocumentSummary[];
  timestamp: number;
}

export interface DesktopAiEditChatAssistantTurn {
  id: string;
  role: "assistant";
  documentIdentityKey: string;
  references: AiEditReference[];
  events: AiEditRunEvent[];
  streamText: string;
  reasoningText: string;
  planSteps: AiEditPlanStep[];
  planExplanation: string | null;
  startedAt: number;
  endedAt: number | null;
  isRunning: boolean;
  result: AiEditRunResult | null;
  targetId: string | null;
  error: string | null;
  applied: boolean;
  dismissed: boolean;
  restored?: boolean;
}

export type DesktopAiEditChatTurn = DesktopAiEditChatUserTurn | DesktopAiEditChatAssistantTurn;

export interface DesktopAiEditChatRoom {
  version: 1;
  id: string;
  documentIdentityKey: string;
  title: string;
  agentThreadId: string | null;
  // The AI provider this conversation is bound to, captured from its first run.
  // Follow-up messages reuse it (only reasoning effort stays adjustable) so a
  // thread never switches providers mid-conversation. Undefined for rooms that
  // predate this field / have not run yet.
  provider?: AiProvider;
  createdAt: string;
  updatedAt: string;
  turns: DesktopAiEditChatTurn[];
}

export type DesktopAiEditChatRoomSaveResult =
  | { ok: true; room: DesktopAiEditChatRoom }
  | { ok: false; error: string };

export interface DesktopAiEditAPI {
  getGeneratedImage?(runId: string, imageId: string): Promise<{ dataUrl: string | null }>;

  run(
    payload: unknown,
    onEvent: (event: unknown) => void,
    /** Invoked synchronously with the IPC-level runId before run() resolves, so a caller can cancel this specific run later. */
    onRunId?: (runId: string) => void,
  ): Promise<unknown>;
  /** Requests cancellation of an in-flight run started via run()'s onRunId callback. */
  cancel?(runId: string): Promise<{ ok: boolean; cancelled: boolean }>;
  listChatRooms?(documentIdentityKey?: string): Promise<DesktopAiEditChatRoom[]>;
  saveChatRoom?(room: DesktopAiEditChatRoom): Promise<DesktopAiEditChatRoomSaveResult>;
  deleteChatRoom?(roomId: string): Promise<DesktopStorageResult>;
  deleteChatRoomsForDocument?(documentIdentityKey: string): Promise<DesktopStorageResult & { deletedRoomIds?: string[] }>;
}

export interface DesktopSettingsAPI {
  get(): Promise<{
    commandShortcuts?: unknown;
    customCommands?: unknown;
    hasCommandShortcuts?: boolean;
    hasCustomCommands?: boolean;
    aiAutoApplyVerifiedProposals?: boolean;
    aiWebSearchEnabled?: boolean;
    /** UIの表示言語。settings.jsonが正本。未設定はnullで、レンダラ側のOSロケール検出に委ねる。 */
    uiLocale?: "ja" | "en" | null;
  }>;
  setCommandShortcuts(value: unknown): Promise<DesktopStorageResult>;
  setCustomCommands(value: unknown): Promise<DesktopStorageResult>;
  setCommandConfig(value: {
    commandShortcuts?: unknown;
    customCommands?: unknown;
  }): Promise<DesktopStorageResult>;
  /** MCPサーバーが検証済みと報告した pending 提案を、baseRevisionが現在と一致する場合に限り自動承認する。既定false。 */
  setAiAutoApplyVerifiedProposals?(value: boolean): Promise<DesktopStorageResult>;
  /** AIエージェント (Codex/Claude/Antigravity) にWeb検索を許可する。既定true (未設定は有効扱い)。 */
  setAiWebSearchEnabled?(value: boolean): Promise<DesktopStorageResult>;
  /** UIの表示言語。既定(ja)を渡すとキーごと削除される。 */
  setUiLocale?(value: "ja" | "en"): Promise<DesktopStorageResult>;
  /** MCPの update_ai_settings tool等、他プロセス(MCPサーバー)からsettings.jsonが書き換えられた
   * ときにmainがfs.watch経由で検知して通知する。開いている設定画面の値を再取得させる用途。 */
  onAiSettingsChanged?(handler: () => void): () => void;
}

export interface DesktopCustomFont {
  id: string;
  displayName: string;
  fileName: string;
  cssFamily: string;
  importedAt: string;
  url: string;
}

export interface DesktopFontsResult extends DesktopStorageResult {
  fonts: DesktopCustomFont[];
  canceled?: boolean;
}

export interface DesktopFontsAPI {
  list(): Promise<DesktopFontsResult>;
  importFont(): Promise<DesktopFontsResult>;
  deleteFont(fontId: string): Promise<DesktopFontsResult>;
}

export type DesktopAiResourceProvider = "codex" | "claude" | "antigravity";
export type DesktopAiResourceKind = "instruction" | "skill";
export type DesktopAiResourceLoadMode = "always" | "auto" | "manual";

export interface DesktopAiResourceManifestEntry {
  id: string;
  kind: DesktopAiResourceKind;
  title: string;
  sourcePath: string;
  enabled: boolean;
  providers: DesktopAiResourceProvider[];
  loadMode: DesktopAiResourceLoadMode;
  description: string;
  tags: string[];
  /** null/undefined = グローバル(すべてのワークスペースで使用)。文字列 = そのワークスペースIDだけに適用。
   * skill・instruction のどちらもワークスペーススコープを持ちうる(2層: グローバル/ワークスペース)。 */
  workspaceId?: string | null;
  origin?: "official";
  bundledHash?: string;
  bundledTitle?: string;
  bundledDescription?: string;
  officialState?: "managed" | "modified";
  updatedAt: string;
}

export interface DesktopAiResourceTree {
  sourceRoot: string;
  codexRuntimeRoot: string;
  claudeRuntimeRoot: string;
  geminiRuntimeRoot: string;
  resources: DesktopAiResourceManifestEntry[];
}

export interface DesktopAiResourceFile {
  resource: DesktopAiResourceManifestEntry;
  content: string;
}

export interface DesktopAiResourcesAPI {
  getTree(): Promise<DesktopAiResourceTree>;
  readFile(resourceId: string): Promise<DesktopAiResourceFile>;
  saveFile(input: {
    resourceId: string;
    content: string;
    patch?: Partial<Pick<DesktopAiResourceManifestEntry, "title" | "description" | "enabled">>;
  }): Promise<DesktopAiResourceFile>;
  /** 「AIへの指示」の保存。ワークスペース指示は初回保存まで存在しないため、なければ新規作成する。 */
  saveInstruction(input: { workspaceId?: string | null; content: string }): Promise<DesktopAiResourceFile>;
  /** workspaceId省略/null = グローバルskill。指定時はそのワークスペース専用skillを作る。 */
  createSkill(input?: { name?: string; workspaceId?: string | null }): Promise<DesktopAiResourceFile>;
  deleteResource(resourceId: string): Promise<DesktopStorageResult>;
  /** リスト上の有効/無効スイッチ用の軽量トグル(本文には触れない)。 */
  setResourceEnabled(resourceId: string, enabled: boolean): Promise<DesktopAiResourceManifestEntry>;
  /** MCPの save_ai_resource/delete_ai_resource tool等、他プロセス(MCPサーバー)からリソースが
   * 変更されたときにmainがfs.watch経由で検知して通知する。開いているダイアログの再取得用途。 */
  onChanged(handler: () => void): () => void;
}

// electron/ai-skill-draft.ts の AiSkillDraftRequest/Result をミラーした型。スキル編集画面
// (AiSettingsDialog.tsx の SkillEditor)の「AIで下書き」用、ツールなしの一回きりの生成呼び出し。
export interface DesktopAiSkillDraftContext {
  title: string;
  description: string;
  /** 既存のスキル本文。空文字なら新規作成として扱う。 */
  currentContent: string;
}

export interface DesktopAiSkillDraftRequest {
  provider: AiProvider;
  prompt: string;
  context: DesktopAiSkillDraftContext;
}

export type DesktopAiSkillDraftResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** ストリーミング中に届く進捗イベント。今のところ生成中のテキスト断片(delta)のみ。 */
export interface DesktopAiSkillDraftEvent {
  kind: "delta";
  text: string;
}

export interface DesktopAiSkillDraftAPI {
  /**
   * onEvent: 生成中のテキスト断片をリアルタイムで受け取る(内容欄への逐次反映用)。
   * onRunId: IPC往復が始まる前に同期で呼ばれ、cancel()に渡すrunIdを渡す(aiEdit.runと同じ形)。
   * 戻り値は完了後の最終確定結果(サニタイズ済みテキスト)。
   */
  generate(
    request: DesktopAiSkillDraftRequest,
    onEvent?: (event: DesktopAiSkillDraftEvent) => void,
    onRunId?: (runId: string) => void,
  ): Promise<DesktopAiSkillDraftResult>;
  cancel(runId: string): Promise<{ ok: boolean; cancelled: boolean }>;
}

export type DesktopExternalDocument = { id: number; filePath: string } & (
  | { data: string; error?: never }
  | { error: string; data?: never }
);

export interface DesktopFileAPI {
  getPendingOpenDocument?(): Promise<DesktopExternalDocument | null>;
  acknowledgeOpenDocument?(id: number): Promise<void>;
  onOpenDocumentAvailable?(handler: () => void): () => void;
  openSigmaDoc(): Promise<{ filePath: string; data: string } | null>;
  openImportDocument?(): Promise<{ filePath: string; dataBase64: string } | null>;
  openImportOtherDocument?(): Promise<{ filePath: string; dataBase64: string } | null>;
  saveSigmaDoc(payload: { suggestedName?: string; data: string }): Promise<{ filePath: string } | null>;
  exportPdf?(payload: {
    suggestedName?: string;
    surfaceId: string;
    revision: number;
    pageCount: number;
    pageWidthMm: number;
    pageHeightMm: number;
  }): Promise<{ filePath: string; pageCount: number } | null>;
  /**
   * ダウンロードフォルダへそのまま書き出す。拡張子は main 側の許可リストで縛られている。
   * 名前が衝突したら `-2` を足すので、既存ファイルを上書きすることはない。
   */
  saveToDownloads?(payload: { fileName: string; dataBase64: string }): Promise<{ filePath: string }>;
  showInFolder?(filePath: string): Promise<{ ok: boolean }>;
}

export interface DesktopAiRenderAPI {
  getRenderDocument(renderId: string): Promise<SigmaDocument | null>;
}

export interface DesktopMaterialsAPI {
  listMaterials(): Promise<MaterialItem[]>;
  createMaterial(input: { name: string; content: MaterialContent } & Pick<MaterialItem, "description" | "tags" | "usage" | "visualConcepts" | "transformPolicy" | "ports">): Promise<MaterialItem>;
  renameMaterial(id: string, name: string): Promise<MaterialItem>;
  updateMaterialMetadata(id: string, input: Partial<Pick<MaterialItem, "name" | "description" | "tags" | "usage" | "visualConcepts" | "transformPolicy" | "ports" | "content">>): Promise<MaterialItem>;
  deleteMaterial(id: string): Promise<DesktopStorageResult>;
}

export interface DesktopTemplatesAPI {
  listTemplates(workspaceId?: string | null): Promise<TemplateItem[]>;
  createTemplate(input: { workspaceId: string; name: string; document: SigmaDocument }): Promise<TemplateItem>;
  renameTemplate(id: string, name: string): Promise<TemplateItem>;
  deleteTemplate(id: string): Promise<DesktopStorageResult>;
}

export interface DesktopCodexStatus {
  available: boolean;
  running: boolean;
  loggedIn: boolean;
  codexHome: string;
  codexBin: string;
  configuredCodexBin: string | null;
  account: {
    type: string;
    email?: string;
    planType?: string;
  } | null;
  error: string | null;
}

export interface DesktopAiReasoningEffortOption {
  id: string;
  description?: string;
}

/** A model currently advertised by the installed provider runtime. */
export interface DesktopAiModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: DesktopAiReasoningEffortOption[];
}

export interface DesktopAiModelCatalog {
  models: DesktopAiModelOption[];
}

export type DesktopCodexLoginResult =
  | {
      ok: true;
      authUrl?: string;
      loginId?: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface DesktopCodexAPI {
  getStatus(): Promise<DesktopCodexStatus>;
  listModels?(): Promise<DesktopAiModelCatalog>;
  setBin(path: string | null): Promise<DesktopCodexStatus>;
  selectBin(): Promise<{ canceled: true } | { canceled: false; status: DesktopCodexStatus }>;
  login(): Promise<DesktopCodexLoginResult>;
  openInstallPage(): Promise<{ ok: boolean; error?: string }>;
  logout(): Promise<{ ok: boolean }>;
  onStatusChange(handler: () => void): () => void;
}

export interface DesktopClaudeStatus {
  available: boolean;
  running: boolean;
  loggedIn: boolean;
  claudeBin: string;
  configuredClaudeBin: string | null;
  account: {
    apiKeySource: string;
  } | null;
  error: string | null;
}

export interface DesktopClaudeAPI {
  getStatus(): Promise<DesktopClaudeStatus>;
  listModels?(): Promise<DesktopAiModelCatalog>;
  setBin(path: string | null): Promise<DesktopClaudeStatus>;
  selectBin(): Promise<{ canceled: true } | { canceled: false; status: DesktopClaudeStatus }>;
  openInstallPage(): Promise<{ ok: boolean; error?: string }>;
  onStatusChange(handler: () => void): () => void;
}

export interface DesktopGeminiStatus {
  available: boolean;
  loggedIn: boolean;
  geminiBin: string;
  configuredGeminiBin: string | null;
  account: {
    type: string;
  } | null;
  error: string | null;
}

export interface DesktopGeminiAPI {
  getStatus(): Promise<DesktopGeminiStatus>;
  listModels?(): Promise<DesktopAiModelCatalog>;
  setBin(path: string | null): Promise<DesktopGeminiStatus>;
  selectBin(): Promise<{ canceled: true } | { canceled: false; status: DesktopGeminiStatus }>;
  openInstallPage(): Promise<{ ok: boolean; error?: string }>;
  onStatusChange(handler: () => void): () => void;
}

export interface DesktopShellAPI {
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
}

export interface DesktopAppInfo {
  version: string;
  releaseUrl: string;
}

export interface DesktopEditorPreferences {
  fontFamily: string | null;
}

export interface DesktopEditorPreferencesSaveResult extends DesktopStorageResult {
  preferences: DesktopEditorPreferences;
}

export interface DesktopAppAPI {
  getInfo(): Promise<DesktopAppInfo>;
  openLatestReleasePage(): Promise<{ ok: boolean; error?: string }>;
  getEditorPreferences?(): Promise<DesktopEditorPreferences>;
  saveEditorPreferences?(preferences: { fontFamily?: string | null }): Promise<DesktopEditorPreferencesSaveResult>;
  onCloseRequested?(handler: () => void): () => void;
  acknowledgeCloseRequest?(): Promise<boolean>;
  notifyCloseReady?(): Promise<boolean>;
  cancelCloseRequest?(): Promise<boolean>;
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  releaseUrl: string;
  supported: boolean;
  availableVersion?: string;
  releaseName?: string | null;
  releaseDate?: string;
  progress?: DesktopUpdateProgress;
  error?: string;
}

export interface DesktopUpdaterAPI {
  getStatus(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  quitAndInstall(): Promise<{ ok: true } | { ok: false; error: string }>;
  onStatusChange(handler: (status: DesktopUpdateState) => void): () => void;
}

export type DesktopInputSourceSwitchResult =
  | { ok: true; platform: NodeJS.Platform; restoreToken?: string }
  | { ok: false; error: string; platform: NodeJS.Platform; skipped?: boolean };

export type DesktopInputSourceRestoreResult =
  | { ok: true; platform: NodeJS.Platform; restored: boolean }
  | { ok: false; error: string; platform: NodeJS.Platform; skipped?: boolean };

export interface DesktopInputSourceAPI {
  switchToAscii(): Promise<DesktopInputSourceSwitchResult>;
  restore(restoreToken: string): Promise<DesktopInputSourceRestoreResult>;
}

export interface DesktopDocumentMetadata {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  fileId: string;
  workspaceId: string;
  folderId: string | null;
  docId: string;
  title: string;
  documentPath?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspaceState {
  openFileIds: string[];
  activeFileId: string;
  layout?: WorkspaceLayoutV2;
}

export interface DesktopStorageResult {
  ok: boolean;
  error?: string;
  /** saveDocument の楽観ロック失敗時のみ: "revision-mismatch"。 */
  code?: "revision-mismatch";
  /** code === "revision-mismatch" のとき、実際に格納されていた revision。 */
  currentRevision?: number;
  /** saveDocument 成功時のみ: 保存直後のファイル revision。 */
  revision?: number;
  /** 通常保存に伴うバージョン履歴の記録有無。 */
  versionCaptured?: boolean;
  /** 正本保存は成功したが、履歴サイドカー記録だけが失敗した場合の詳細。 */
  versionCaptureError?: string;
  /** 正本削除は成功したが、履歴サイドカー掃除だけが失敗した場合の詳細。 */
  versionCleanupError?: string;
}

export type DesktopStorageChangeEvent =
  | {
      type: "documentVersion";
      fileId: string;
      change: "captured" | "pruned";
      timestamp: number;
    }
  | {
      type: "document";
      fileId: string;
      change: "changed" | "deleted";
      timestamp: number;
      /** 検証済み提案の自動承認による変更なら、その承認を1手のundoへ関連付けるID群。 */
      autoAppliedProposalIds?: string[];
    }
  | {
      type: "workspace";
      timestamp: number;
    }
  | {
      type: "library";
      timestamp: number;
    }
  | {
      type: "watcher";
      scope: "documents" | "library" | "mcpProposal";
      change: "failed" | "recovered";
      timestamp: number;
    }
  | {
      type: "mcpProposal";
      proposalId?: string;
      change: "changed";
      timestamp: number;
      /** 検証済み自動承認 (aiAutoApplyVerifiedProposals) によって承認された変更であることを示す。 */
      autoApplied?: boolean;
      /** 却下時: 一括で却下された proposalId 群 (単一却下でも1件の配列)。 */
      rejectedProposalIds?: string[];
      /** 却下理由 (存在する場合)。 */
      rejectedReason?: string;
    };

export interface DesktopWorkspaceSummary {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopFolderSummary {
  sharingPending?: boolean;
  sharing?: import("@/lib/runtime/shared-catalog").LibrarySharingMetadata;
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export type DesktopWorkspaceFileSummary = DesktopDocumentMetadata;

// "reverted": 承認済み提案を revertMcpEditProposal で巻き戻した後の終端状態。
export type DesktopMcpEditProposalStatus = "pending" | "approved" | "rejected" | "reverted";

export interface DesktopMcpEditProposalListOptions {
  status?: DesktopMcpEditProposalStatus | "all";
  fileId?: string;
  resolvedLimit?: number;
}

// electron/local-sigma-doc-proposal-store.ts の McpEditProposalProvider をミラーした型。
// renderer側 (この .d.ts) は electron モジュールを import できないため、値集合を手動で
// 同期させる必要がある。electron側の union を変更したら、ここも合わせて更新すること。
export type DesktopMcpEditProposalProvider = "claude" | "chatgpt" | "antigravity";
export type DesktopMcpEditProposalConflictReason =
  | "content-stale"
  | "anchor-missing"
  | "asset-collision"
  | "replay-failed";

// electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalVerification をミラー。
export interface DesktopMcpEditProposalVerification {
  validationOk: boolean;
  previewSource?: string;
}

export interface DesktopMcpEditProposalHistoryEntry {
  action: "revised" | "rejected" | "withdrawn" | "reproposed";
  at: string;
  reason?: string;
  runId?: string;
  turnId?: string;
}

// electron/local-sigma-doc-proposal-store.ts の AiSourceReference をミラーした型。
// renderer側 (この .d.ts) は electron モジュールを import できないため、値集合を手動で
// 同期させる必要がある (2箇所が上限)。electron側の union を変更したら、ここも合わせて更新すること。
export type DesktopAiSourceReference =
  | { type: "document"; fileId: string; title?: string; blockId?: string; note?: string }
  | { type: "web"; url: string; title?: string }
  | { type: "webSearch"; query: string }
  | { type: "material"; materialId: string; name?: string };

export interface DesktopMcpEditProposalSummary {
  proposalId: string;
  groupId?: string;
  groupMemberIds?: string[];
  groupPosition?: number;
  fileId: string;
  baseRevision: number;
  baseDocId: string;
  title: string;
  summary: string;
  plan: string[];
  warnings: string[];
  changedIds: string[];
  provider: DesktopMcpEditProposalProvider | null;
  /** Insert toolが要求した元図形ID。delete+insertを1つの論理置換として扱うための要約値。 */
  requestedShapeId?: string;
  draft: AiEditSessionDraft;
  status: DesktopMcpEditProposalStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolutionMessage?: string;
  // 帰属情報 (ai-edit:run の runId / チャットのroomId・turnId / 任意のセッションラベル)。
  // すべて任意 — 外部CLI経由など判別できないケースがある。
  runId?: string;
  roomId?: string;
  turnId?: string;
  sessionLabel?: string;
  // MCPサーバーが報告した検証結果 (今回のバッチではストアが往復させるだけ)。
  verification?: DesktopMcpEditProposalVerification;
  // status === "rejected" のときの却下理由・日時。
  rejectedReason?: string;
  rejectedAt?: string;
  // rebaseMcpEditProposal で再適用された場合、巻き戻し前の baseRevision。
  rebasedFrom?: number;
  // status === "approved" のとき、保存直後のファイルrevision。Phase 2以降、revertは
  // 現在のrevisionがこれと一致しなくても選択的revertで成功しうる (main側のgetRevertPlan/
  // buildSelectiveRevertDocument参照) — この値はもう「revertできる/できない」の唯一の
  // 判定材料ではなく、「同じ1回の保存を共有した承認バッチ」を特定するためのキーとして使われる。
  appliedRevision?: number;
  // status === "approved" のとき、適用直前／直後のSigmaDocから切り出した実差分。
  // チャットの適用結果はsummary文ではなく、このノードスナップショットだけを表示する。
  appliedDiff?: AiAppliedDocumentDiff;
  // 検証済み自動承認 (aiAutoApplyVerifiedProposals設定) によって承認された場合 true。
  autoApplied?: boolean;
  // Phase 1: Agentic RAG。この編集が参照した過去教材・素材・Webページ (存在する場合のみ)。
  sourceReferences?: DesktopAiSourceReference[];
  // electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalTouchedBlock/Conflict を
  // ミラー。承認/自動rebaseの鮮度判定に使う (旧レコードには存在しない)。
  touchedBlocks?: { id: string; baseHash: string | null }[];
  // electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalRequestSelection をミラー。
  // 「依頼時の選択範囲」スナップショット。新しい提案では監査情報、精密判定できない旧提案では
  // 衝突判定のフォールバックとして使われる (さらに古いレコードには存在しない)。
  requestSelection?: { blockIds: string[]; hashes: Record<string, string>; capturedRevision: number };
  conflict?: {
    blockIds: string[];
    detectedAtRevision: number;
    reason?: DesktopMcpEditProposalConflictReason;
  };
  invalidReason?: string;
  history?: DesktopMcpEditProposalHistoryEntry[];
}

export interface DesktopWorkspaceOverview {
  catalog?: import("@/lib/runtime/shared-catalog").SharedCatalogStatus;
  activeWorkspaceId: string;
  workspaces: DesktopWorkspaceSummary[];
  folders: DesktopFolderSummary[];
  files: DesktopWorkspaceFileSummary[];
}

export type DesktopWorkspaceOverviewResult =
  | { state: "error"; error: string }
  | { state: "ledger-schema-error"; failure: LedgerSchemaFailure }
  | { state: "ready"; overview: DesktopWorkspaceOverview };

export interface DesktopFileCreateResult {
  file: DesktopDocumentMetadata;
  document: SigmaDocument;
  recoveryIssues?: SigmaDocumentRecoveryIssue[];
  recoveryBackupPath?: string;
}

export type DesktopMcpEditProposalActionResult =
  | {
      ok: true;
      proposal: unknown;
      file?: DesktopDocumentMetadata;
      document?: SigmaDocument;
    }
  | {
      ok: false;
      error: string;
      /** 承認直前の鮮度確認で、対象ブロックが実際に変更されていたことを検出した場合のみ。 */
      code?: "conflict";
      /** code === "conflict" のとき、実際に変更が検出されたブロック/overlay図形ID。 */
      conflictBlockIds?: string[];
      conflictReason?: DesktopMcpEditProposalConflictReason;
    };

export type DesktopMcpEditProposalsActionResult =
  | {
      ok: true;
      file?: DesktopDocumentMetadata;
      document?: SigmaDocument;
      versionCaptured?: boolean;
      versionCaptureError?: string;
      /** Proposals that failed to (re-)apply during a batch approve and were left pending. */
      failed?: {
        proposalId: string;
        error: string;
        conflictBlockIds?: string[];
        conflictReason?: DesktopMcpEditProposalConflictReason;
      }[];
    }
  | {
      ok: false;
      error: string;
      code?: "conflict";
      conflictBlockIds?: string[];
      conflictReason?: DesktopMcpEditProposalConflictReason;
    };

export type DesktopMcpEditProposalsRejectResult =
  | {
      ok: true;
      proposals: unknown[];
      failed: { proposalId: string; error: string }[];
    }
  | {
      ok: false;
      error: string;
    };

export type DesktopMcpEditProposalRebaseResult =
  | { ok: true; proposal: DesktopMcpEditProposalSummary }
  | { ok: false; reason: string };

export type DesktopMcpEditProposalRestoreResult =
  | { ok: true; proposal: DesktopMcpEditProposalSummary }
  | { ok: false; error: string };

// Phase 2: 承認直後のrevisionと現在のrevisionが一致していなくても、AIが触ったブロック/図形
// 自体がその後無編集なら、mainが選択的revert (現在のドキュメントを土台に触られた範囲だけ戻す)
// で成功させる。呼び出し側はどちらのmodeで戻ったかを区別する必要はなく、ok/reasonだけを見ればよい。
export type DesktopMcpEditProposalRevertResult =
  | { ok: true; proposal: unknown }
  | { ok: false; reason: string };

export interface DesktopStorageAPI {
  renameDocument?(workspaceId: string, fileId: string, name: string): Promise<import("@/lib/runtime/types").WorkspaceOverviewResult>;
  initializeWorkspace(payload: {
    initialDocument: SigmaDocument;
  }): Promise<
    | { ok: true; state: DesktopWorkspaceState }
    | { ok: false; ledgerError: LedgerSchemaFailure }
  >;
  listFiles(): Promise<DesktopDocumentMetadata[]>;
  loadDocument(fileId: string): Promise<SigmaDocument | null>;
  loadDocumentWithRecovery?(fileId: string): Promise<
    | {
        ok: true;
        document: SigmaDocument;
        revision: number;
        recoveryIssues: SigmaDocumentRecoveryIssue[];
        recoveryBackupPath?: string;
      }
    | {
        ok: false;
        error: string;
        failureKind?: "missing" | "json" | "schema" | "io";
        failures?: SigmaDocumentSchemaFailure[];
        documentPath?: string;
        title?: string;
      }
  >;
  saveDocument(
    fileId: string,
    document: SigmaDocument,
    options: { expectedRevision: number; origin?: DocumentVersionOrigin },
  ): Promise<DesktopStorageResult>;
  listDocumentVersions(fileId: string): Promise<DocumentVersionMetadata[]>;
  getDocumentVersion(fileId: string, versionId: string): Promise<DocumentVersion | null>;
  captureDocumentVersion(
    fileId: string,
    document: SigmaDocument,
    options: { expectedRevision: number; origin: DocumentVersionOrigin },
  ): Promise<{ ok: boolean; version?: DocumentVersionMetadata; error?: string }>;
  createDocument(payload?: {
    title?: string;
    workspaceId?: string | null;
    folderId?: string | null;
  }): Promise<DesktopFileCreateResult>;
  createFileFromDocument(payload: {
    document: SigmaDocument;
    workspaceId?: string | null;
    folderId?: string | null;
  }): Promise<DesktopFileCreateResult>;
  duplicateFile(fileId: string): Promise<DesktopFileCreateResult>;
  deleteFile(fileId: string, options?: { expectedRevision: number }): Promise<DesktopStorageResult>;
  saveWorkspace(state: DesktopWorkspaceState): Promise<DesktopStorageResult>;
  getWorkspaceOverview(workspaceId?: string | null): Promise<DesktopWorkspaceOverviewResult>;
  createWorkspace(name: string): Promise<DesktopWorkspaceOverviewResult>;
  renameWorkspace(workspaceId: string, name: string): Promise<DesktopWorkspaceOverviewResult>;
  deleteWorkspace(workspaceId: string): Promise<DesktopWorkspaceOverviewResult>;
  createFolder(
    workspaceId: string,
    name: string,
    parentFolderId?: string | null,
  ): Promise<DesktopWorkspaceOverviewResult>;
  updateFolder(
    workspaceId: string,
    folderId: string,
    patch: { name?: string; parentFolderId?: string | null },
  ): Promise<DesktopWorkspaceOverviewResult>;
  deleteFolder(workspaceId: string, folderId: string): Promise<DesktopWorkspaceOverviewResult>;
  moveFileToFolder(
    workspaceId: string,
    fileId: string,
    folderId?: string | null,
  ): Promise<DesktopWorkspaceOverviewResult>;
  moveFileToWorkspace(
    fileId: string,
    targetWorkspaceId: string,
    folderId?: string | null,
  ): Promise<DesktopWorkspaceOverviewResult>;
  getDataDir(): Promise<{ path: string }>;
  listMcpEditProposals(options?: DesktopMcpEditProposalListOptions): Promise<DesktopMcpEditProposalSummary[]>;
  beginMcpProposalRun?(roomId: string, fileId: string): Promise<{ ok: true; snapshotId: string } | { ok: false; error: string }>;
  completeMcpProposalRun?(snapshotId: string): Promise<{ ok: boolean }>;
  rollbackMcpProposalRun?(snapshotId: string): Promise<{ ok: boolean }>;
  approveMcpEditProposal(
    proposalId: string,
    options?: { force?: boolean },
  ): Promise<DesktopMcpEditProposalActionResult>;
  approveMcpEditProposals(
    proposalIds: string[],
    options?: { force?: boolean },
  ): Promise<DesktopMcpEditProposalsActionResult>;
  rejectMcpEditProposal(proposalId: string): Promise<DesktopMcpEditProposalActionResult>;
  /** 理由つきで複数件をまとめて却下する。既存の単体版 (rejectMcpEditProposal) はそのまま残っている。 */
  rejectMcpEditProposals?(proposalIds: string[], reason?: string): Promise<DesktopMcpEditProposalsRejectResult>;
  /** stale (baseRevisionが古い) 提案を、現在のドキュメントに対して再適用できるか試す。 */
  rebaseMcpEditProposal?(proposalId: string): Promise<DesktopMcpEditProposalRebaseResult>;
  /** 却下(rejected)・差し戻し(reverted)済みdraftが現在の教材と競合しない場合だけpendingとして復活させる。 */
  restoreMcpEditProposal?(proposalId: string): Promise<DesktopMcpEditProposalRestoreResult>;
  /** 承認直後のrevisionから教材が変更されていない場合に限り、承認前のドキュメントへ戻す。 */
  revertMcpEditProposal?(proposalId: string): Promise<DesktopMcpEditProposalRevertResult>;
  /** エディタのundoがAI適用を巻き戻した際のストア整合: approved → reverted (ドキュメントは触らない)。 */
  markMcpEditProposalsReverted?(proposalIds: string[]): Promise<{ ok: boolean; transitioned?: string[]; skipped?: string[] }>;
  /** エディタのredoがAI適用をやり直した際のストア整合: reverted → approved (ドキュメントは触らない)。 */
  markMcpEditProposalsReapplied?(proposalIds: string[]): Promise<{ ok: boolean; transitioned?: string[]; skipped?: string[] }>;
  onChange(handler: (event: DesktopStorageChangeEvent) => void): () => void;
}

export interface DesktopWorkspacePreviewAPI {
  get(fileId: string, revision: number): Promise<string | null>;
  put(fileId: string, revision: number, dataUrl: string): Promise<{ ok: boolean }>;
}

export interface DesktopAPI {
  sharedCatalog?: import("@/lib/runtime/shared-catalog").SharedCatalogBridge;
  collaboration?: import("@/features/collaboration/model/bridge").CollaborationBridge;
  isDesktop: true;
  platform: NodeJS.Platform;
  app: DesktopAppAPI;
  updater?: DesktopUpdaterAPI;
  shell: DesktopShellAPI;
  settings?: DesktopSettingsAPI;
  fonts?: DesktopFontsAPI;
  codex: DesktopCodexAPI;
  claude?: DesktopClaudeAPI;
  gemini?: DesktopGeminiAPI;
  aiEdit: DesktopAiEditAPI;
  aiResources?: DesktopAiResourcesAPI;
  aiSkillDraft?: DesktopAiSkillDraftAPI;
  file: DesktopFileAPI;
  aiRender?: DesktopAiRenderAPI;
  inputSource?: DesktopInputSourceAPI;
  materials: DesktopMaterialsAPI;
  templates: DesktopTemplatesAPI;
  storage: DesktopStorageAPI;
  workspacePreview?: DesktopWorkspacePreviewAPI;
  onMenuAction(handler: (action: string) => void): () => void;
}

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}
