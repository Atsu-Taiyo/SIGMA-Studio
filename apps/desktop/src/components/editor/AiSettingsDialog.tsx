"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Plus } from "lucide-react";

import { ChatPromptField } from "./ChatPromptField";
import { DesktopSettingsModal } from "./DesktopSettingsModal";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsField, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useAiConnection, useClaudeConnection, useGeminiConnection } from "@/lib/ai/ai-connection";
import { getAiModelPreferences } from "@/lib/ai/ai-model-preferences";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { composeSkillFile, parseSkillFile, skillSlugFromSourcePath } from "@/lib/ai/skill-frontmatter";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import { listWorkspaceOverview } from "@/lib/workspace-repository";
import type { DesktopAiResourceManifestEntry, DesktopAiResourcesAPI, DesktopAiResourceTree } from "@/types/desktop";
import { useT } from "@/lib/i18n/react";

import { getSettingsEntrySurfaceState } from "./settings-catalog";
import { useSettingsEntryFocus } from "./settings-entry-focus";

export interface AiSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** ダイアログを開いた瞬間のアクティブワークスペース。「ワークスペース」タブの初期選択に使う。 */
  activeWorkspaceId?: string | null;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

type NavSection = "ai-runtime" | "global-instructions" | "global-skills" | "workspace-instructions" | "workspace-skills";

const DESCRIPTION_MAX_LENGTH = 250;
const CONTENT_MAX_LENGTH = 12_000;

/**
 * AIの接続設定と、グローバル／ワークスペース単位の指示・スキル編集を一つの設定導線にまとめる。
 * 設定値やAIリソースの永続化方式、接続可否の判定そのものは担わず、desktop bridgeと各接続フックに委ねる。
 */
export function AiSettingsDialog({ open, onClose, activeWorkspaceId, focusEntryId }: AiSettingsDialogProps) {
  if (!open) {
    return null;
  }
  return <AiSettingsBody onClose={onClose} activeWorkspaceId={activeWorkspaceId} focusEntryId={focusEntryId} />;
}

function AiSettingsBody({ onClose, activeWorkspaceId, focusEntryId }: { onClose: () => void; activeWorkspaceId?: string | null; focusEntryId?: string }) {
  const t = useT("settings");
  useSettingsEntryFocus(focusEntryId);
  const bridge = getDesktopBridge();
  // パレットから来たときは、その項目が住んでいるセクションから開く
  // (別セクションのままだと anchor が DOM に無く、スクロール先が見つからない)。
  const [section, setSection] = useState<NavSection>(
    () => (getSettingsEntrySurfaceState(focusEntryId) as NavSection | undefined) ?? "ai-runtime",
  );
  const [tree, setTree] = useState<DesktopAiResourceTree | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(activeWorkspaceId ?? null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);

  const refreshTree = useCallback(async () => {
    if (!bridge?.aiResources) {
      return null;
    }
    // getTree()のawaitを挟むため、effect本文から呼ばれてもsetTreeは常に非同期に走る。
    const next = await bridge.aiResources.getTree();
    setTree(next);
    return next;
  }, [bridge]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refreshTreeはawait後にsetStateする非同期関数
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    if (!bridge?.aiResources?.onChanged) {
      return;
    }
    return bridge.aiResources.onChanged(() => {
      void refreshTree();
    });
  }, [bridge, refreshTree]);

  useEffect(() => {
    let cancelled = false;
    listWorkspaceOverview(activeWorkspaceId ?? undefined)
      .then((result) => {
        if (cancelled || result.state !== "ready") {
          return;
        }
        const tabs = result.overview.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
        setWorkspaces(tabs);
        setSelectedWorkspaceId((current) => {
          if (current && tabs.some((tab) => tab.id === current)) {
            return current;
          }
          if (activeWorkspaceId && tabs.some((tab) => tab.id === activeWorkspaceId)) {
            return activeWorkspaceId;
          }
          return result.overview.activeWorkspaceId || tabs[0]?.id || null;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const globalInstruction = useMemo(
    () => tree?.resources.find((r) => r.kind === "instruction" && r.workspaceId == null) ?? null,
    [tree],
  );
  const workspaceInstruction = useMemo(
    () => tree?.resources.find((r) => r.kind === "instruction" && r.workspaceId === selectedWorkspaceId) ?? null,
    [tree, selectedWorkspaceId],
  );
  const globalSkills = useMemo(
    () => tree?.resources.filter((r) => r.kind === "skill" && r.workspaceId == null) ?? [],
    [tree],
  );
  const workspaceSkills = useMemo(
    () => tree?.resources.filter((r) => r.kind === "skill" && r.workspaceId === selectedWorkspaceId) ?? [],
    [tree, selectedWorkspaceId],
  );

  if (!bridge?.aiResources) {
    return null;
  }
  const aiResources = bridge.aiResources;

  const selectSection = (next: NavSection) => {
    setSection(next);
    setEditingSkillId(null);
  };

  const workspaceName = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.name ?? "";
  const selectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setEditingSkillId(null);
    setWorkspacePickerOpen(false);
  };

  return (
    <>
      <ModalFrame
        open
        onDismiss={onClose}
        size="lg"
        ariaLabel={t("ai.title")}
        surfaceClassName="ai-settings-dialog"
      >
        <ModalHeader title={t("ai.title")} onClose={onClose} />
        <ModalBody padding="none" scroll="hidden" className="ai-settings-body">
          <Stack as="aside" className="ai-settings-sidebar" gap="xl" aria-label={t("ai.navAria")}>
            <Stack className="ai-settings-nav-group" gap="xs">
              <p className="ai-settings-nav-caption">AI</p>
              <Button
                tone="ghost"
                size="sm"
                className={`ai-settings-nav-button ${section === "ai-runtime" ? "active" : ""}`}
                aria-pressed={section === "ai-runtime"}
                aria-current={section === "ai-runtime" ? "page" : undefined}
                onClick={() => selectSection("ai-runtime")}
              >
                {t("ai.connection")}
              </Button>
            </Stack>
            <Stack className="ai-settings-nav-group" gap="xs">
              <p className="ai-settings-nav-caption">{t("ai.scopeGlobal")}</p>
              <Button
                tone="ghost"
                size="sm"
                className={`ai-settings-nav-button ${section === "global-instructions" ? "active" : ""}`}
                aria-pressed={section === "global-instructions"}
                aria-current={section === "global-instructions" ? "page" : undefined}
                onClick={() => selectSection("global-instructions")}
              >
                {t("ai.instructions")}
              </Button>
              <Button
                tone="ghost"
                size="sm"
                className={`ai-settings-nav-button ${section === "global-skills" ? "active" : ""}`}
                aria-pressed={section === "global-skills"}
                aria-current={section === "global-skills" ? "page" : undefined}
                onClick={() => selectSection("global-skills")}
              >
                {t("ai.skills")}
              </Button>
            </Stack>

            <Stack className="ai-settings-nav-group" gap="xs">
              <p className="ai-settings-nav-caption">{t("ai.scopeWorkspace")}</p>
              {workspaces.length > 0 && (
                <Button
                  tone="secondary"
                  size="sm"
                  className="ai-settings-workspace-select"
                  aria-label={t("ai.targetWorkspace")}
                  onClick={() => setWorkspacePickerOpen(true)}
                >
                  <span>{workspaceName || t("ai.selectWorkspace")}</span>
                </Button>
              )}
              <Button
                tone="ghost"
                size="sm"
                className={`ai-settings-nav-button ${section === "workspace-instructions" ? "active" : ""}`}
                aria-pressed={section === "workspace-instructions"}
                aria-current={section === "workspace-instructions" ? "page" : undefined}
                onClick={() => selectSection("workspace-instructions")}
              >
                {t("ai.instructions")}
              </Button>
              <Button
                tone="ghost"
                size="sm"
                className={`ai-settings-nav-button ${section === "workspace-skills" ? "active" : ""}`}
                aria-pressed={section === "workspace-skills"}
                aria-current={section === "workspace-skills" ? "page" : undefined}
                onClick={() => selectSection("workspace-skills")}
              >
                {t("ai.skills")}
              </Button>
            </Stack>
          </Stack>

          <main className="ai-settings-content">
            {/* ツリー取得前にペインをマウントすると「指示なし=編集可の空」と区別できないため、
                取得完了(tree非null)までコンテンツは出さない(通常は一瞬)。 */}
            {tree === null ? <AiSettingsLoading /> : (
            <>
            {section === "ai-runtime" && (
              <DesktopSettingsModal
                open
                embedded
                mode="ai"
                focusEntryId={focusEntryId}
                onClose={onClose}
              />
            )}
            {section === "global-instructions" && (
              <InstructionPane
                key="global"
                id="ai-settings-global-instructions"
                title={t("ai.instructions")}
                description={t("ai.globalInstructionsDescription")}
                resource={globalInstruction}
                workspaceId={null}
                aiResources={aiResources}
                onSaved={refreshTree}
              />
            )}
            {section === "workspace-instructions" && (
              <InstructionPane
                key={`workspace-${selectedWorkspaceId ?? ""}`}
                title={workspaceName ? t("ai.instructionsScoped", { workspace: workspaceName }) : t("ai.instructions")}
                description={t("ai.workspaceInstructionsDescription")}
                resource={workspaceInstruction}
                workspaceId={selectedWorkspaceId}
                disabled={!selectedWorkspaceId}
                aiResources={aiResources}
                onSaved={refreshTree}
              />
            )}
            {section === "global-skills" && (
              <SkillsPane
                key="global-skills"
                id="ai-settings-global-skills"
                title={t("ai.skills")}
                skills={globalSkills}
                workspaceId={null}
                editingSkillId={editingSkillId}
                onEditingSkillIdChange={setEditingSkillId}
                aiResources={aiResources}
                onChanged={refreshTree}
              />
            )}
            {section === "workspace-skills" && (
              <SkillsPane
                key={`workspace-skills-${selectedWorkspaceId ?? ""}`}
                id="ai-settings-workspace-skills"
                title={workspaceName ? t("ai.skillsScoped", { workspace: workspaceName }) : t("ai.skills")}
                skills={workspaceSkills}
                workspaceId={selectedWorkspaceId}
                disabled={!selectedWorkspaceId}
                editingSkillId={editingSkillId}
                onEditingSkillIdChange={setEditingSkillId}
                aiResources={aiResources}
                onChanged={refreshTree}
              />
            )}
            </>
            )}
          </main>
        </ModalBody>
      </ModalFrame>
      {workspacePickerOpen && (
        <WorkspacePickerDialog
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelect={selectWorkspace}
          onClose={() => setWorkspacePickerOpen(false)}
        />
      )}
      <style>{AI_SETTINGS_STYLE}</style>
    </>
  );
}

/** ツリー取得後のペイン構造を保ったまま、初回待機中であることを伝える。 */
function AiSettingsLoading() {
  const t = useT("settings");
  return (
    <Stack className="ai-settings-loading" gap="lg" role="status" aria-label={t("ai.loading")} aria-busy="true">
      <Shimmer className="ai-settings-loading-title">{t("ai.loading")}</Shimmer>
      <Shimmer variant="surface" className="ai-settings-loading-line" />
      <Shimmer variant="surface" className="ai-settings-loading-surface" />
    </Stack>
  );
}

function notifyAiResourcesChanged(): void {
  window.dispatchEvent(new Event("sigma-ai-resources-changed"));
}

function InstructionPane({
  id,
  title,
  description,
  resource,
  workspaceId,
  disabled,
  aiResources,
  onSaved,
}: {
  /** 設定パレットのスクロール先 (`settings-catalog.ts` の anchorId)。 */
  id?: string;
  title: string;
  description: string;
  resource: DesktopAiResourceManifestEntry | null;
  workspaceId: string | null;
  disabled?: boolean;
  aiResources: DesktopAiResourcesAPI;
  onSaved: () => void;
}) {
  const t = useT("settings");
  const tCommon = useT("common");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  // ペインはAiSettingsBody側でツリー取得後にのみ(かつグローバル/ワークスペースごとのkeyで)
  // マウントされるため、mount時にresourceが無い = 保存前のワークスペース指示(空で編集可)。
  const [loading, setLoading] = useState(() => Boolean(resource));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 内容は1回だけ読み込む: ワークスペース指示の初回保存で resource が null→id に変わると
  // このeffectが再発火するが、そこで setContent すると保存後にユーザーが打った未保存の
  // 入力を巻き戻してしまう(保存成功時点で content/savedContent は既に正)。
  const hasLoadedRef = useRef(false);
  const resourceId = resource?.id ?? null;

  useEffect(() => {
    if (!resourceId || hasLoadedRef.current) {
      return;
    }
    let cancelled = false;
    aiResources.readFile(resourceId)
      .then((file) => {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setContent(file.content);
          setSavedContent(file.content);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("ai.error.loadInstructions"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // resourceIdだけを見る: ツリー再取得でresourceのオブジェクト同一性が変わっても再読込しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId]);

  const dirty = content !== savedContent;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await aiResources.saveInstruction({ workspaceId, content });
      hasLoadedRef.current = true;
      setSavedContent(saved.content);
      setSavedFlash(true);
      notifyAiResourcesChanged();
      onSaved();
      window.setTimeout(() => setSavedFlash(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.error.save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection id={id} className="ai-settings-pane" title={title} description={description}>
      {disabled ? (
        <p className="ai-settings-empty-hint">{t("ai.selectWorkspaceHint")}</p>
      ) : (
        <>
          <div className="ai-settings-textarea-wrap">
            <textarea
              className="ai-settings-textarea"
              value={content}
              disabled={loading}
              placeholder={t("ai.instructionsPlaceholder")}
              onChange={(event) => setContent(event.target.value)}
            />
            <span className="ai-settings-char-count">{content.length}</span>
          </div>
          {error && <SettingsStatus className="ai-settings-error" tone="error">{error}</SettingsStatus>}
          <Inline as="footer" className="ai-settings-footer" gap="md" justify="end">
            {savedFlash && <span className="ai-settings-saved-flash" role="status" aria-live="polite">{t("ai.saved")}</span>}
            <Button tone="primary" disabled={!dirty || saving || loading} onClick={() => void save()}>
              {saving ? t("ai.saving") : tCommon("actions.save")}
            </Button>
          </Inline>
        </>
      )}
    </SettingsSection>
  );
}

function SkillsPane({
  id,
  skills,
  workspaceId = null,
  disabled = false,
  title,
  editingSkillId,
  onEditingSkillIdChange,
  aiResources,
  onChanged,
}: {
  /** 設定パレットのスクロール先 (`settings-catalog.ts` の anchorId)。 */
  id?: string;
  skills: DesktopAiResourceManifestEntry[];
  /** 新規作成するスキルに紐づけるスコープ。null = グローバル、文字列 = そのワークスペース専用。 */
  workspaceId?: string | null;
  /** ワークスペースが未選択のときなど、このペインを操作不能にする(ワークスペース指示と同じ流儀)。 */
  disabled?: boolean;
  title?: string;
  editingSkillId: string | null;
  onEditingSkillIdChange: (id: string | null) => void;
  aiResources: DesktopAiResourcesAPI;
  onChanged: () => Promise<unknown> | void;
}) {
  const t = useT("settings");
  const tAi = useT("ai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 新規作成モード: 「スキルを追加」ではまだ何も作らず、空の編集ビューを開くだけ。
  // 実際の作成は編集ビューの保存時(名前必須)。←で戻ればディスクには何も残らない。
  const [creating, setCreating] = useState(false);

  if (disabled) {
    return (
      <SettingsSection id={id} className="ai-settings-pane" title={title}>
        <p className="ai-settings-empty-hint">{t("ai.selectWorkspaceHint")}</p>
      </SettingsSection>
    );
  }

  if (creating) {
    return (
      <SkillEditor
        key="new-skill"
        resource={null}
        workspaceId={workspaceId}
        aiResources={aiResources}
        onBack={() => setCreating(false)}
        onDeleted={() => setCreating(false)}
        onSaved={onChanged}
        onCreated={(id) => {
          setCreating(false);
          onEditingSkillIdChange(id);
        }}
      />
    );
  }

  const editing = editingSkillId ? skills.find((skill) => skill.id === editingSkillId) : null;
  if (editingSkillId && editing) {
    return (
      <SkillEditor
        key={editing.id}
        resource={editing}
        workspaceId={workspaceId}
        aiResources={aiResources}
        onBack={() => onEditingSkillIdChange(null)}
        onDeleted={() => {
          onEditingSkillIdChange(null);
          onChanged();
        }}
        onSaved={onChanged}
      />
    );
  }

  const toggleEnabled = async (resourceId: string, next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await aiResources.setResourceEnabled(resourceId, next);
      notifyAiResourcesChanged();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.error.toggle"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id={id}
      className="ai-settings-pane"
      title={title}
      actions={(
        <Button tone="primary" disabled={busy} onClick={() => setCreating(true)}>
          <Plus size={14} /> {t("ai.addSkill")}
        </Button>
      )}
    >
      {error && <SettingsStatus className="ai-settings-error" tone="error">{error}</SettingsStatus>}
      {skills.length === 0 ? (
        <div className="ai-settings-empty">
          <p>{t("ai.skillsEmpty")}</p>
          <Button tone="secondary" disabled={busy} onClick={() => setCreating(true)}>
            <Plus size={14} /> {t("ai.addSkill")}
          </Button>
        </div>
      ) : (
        <ul className="ai-settings-skill-list">
          {skills.map((skill) => {
            const display = resolveAiResourceDisplayMetadata(skill, tAi);
            return <li key={skill.id}>
              <button type="button" className="ai-settings-skill-row" onClick={() => onEditingSkillIdChange(skill.id)}>
                <span className="ai-settings-skill-row-title-line">
                  <span className="ai-settings-skill-row-title">{display.title || t("ai.skillUntitled")}</span>
                  {skill.origin === "official" && <span className="ai-settings-official-badge">{t("ai.official")}</span>}
                </span>
                <span className="ai-settings-skill-row-description">{display.description || t("ai.skillNoDescription")}</span>
              </button>
              <Switch
                className="ai-settings-switch-control"
                checked={skill.enabled}
                label={t("ai.skillToggle", { title: display.title || t("ai.skillUntitled"), state: skill.enabled ? t("ai.skillDisable") : t("ai.skillEnable") })}
                disabled={busy}
                onCheckedChange={(next) => void toggleEnabled(skill.id, next)}
              />
            </li>;
          })}
        </ul>
      )}
    </SettingsSection>
  );
}

function SkillEditor({
  resource,
  workspaceId = null,
  aiResources,
  onBack,
  onSaved,
  onDeleted,
  onCreated,
}: {
  /** null = 新規作成モード。保存して初めて createSkill でディスクに作られる。 */
  resource: DesktopAiResourceManifestEntry | null;
  /** 新規作成モードでのみ使う: 作るスキルのスコープ(null = グローバル)。既存スキルの
   * 編集ではスコープは変更できない(作成時に固定)ので無視される。 */
  workspaceId?: string | null;
  aiResources: DesktopAiResourcesAPI;
  onBack: () => void;
  onSaved: () => Promise<unknown> | void;
  onDeleted: () => void;
  /** 新規作成モードで保存が成功した後、作成されたスキルの編集モードへ切り替える。 */
  onCreated?: (id: string) => void;
}) {
  const t = useT("settings");
  const tCommon = useT("common");
  const isNew = resource === null;
  const isOfficial = resource?.origin === "official";
  const [title, setTitle] = useState(resource?.title ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [content, setContent] = useState("");
  const [savedTitle, setSavedTitle] = useState(resource?.title ?? "");
  const [savedDescription, setSavedDescription] = useState(resource?.description ?? "");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // frontmatterのname(=各provider CLIがスキルを登録する内部slug)と、name/description以外の
  // 既存frontmatter行(MCPのsave_ai_resourceが書いた追加キー等)。UIには見せず、保存時に
  // composeSkillFileでそのまま書き戻す。slugのフォールバックはsourcePathから導出する
  // (idの文字列プレフィックスには依存しない)。
  const skillMetaRef = useRef<{ slug: string; extraFrontmatterLines: string[] }>({
    slug: resource ? (skillSlugFromSourcePath(resource.sourcePath) ?? resource.id) : "",
    extraFrontmatterLines: [],
  });
  // 新規モードで createSkill 成功後に本文保存が失敗した場合の再試行用。
  // 2回目の保存で二重にスキルを作らないよう、作成済みidを覚えておく。
  const createdIdRef = useRef<string | null>(null);
  const resourceId = resource?.id ?? null;

  // AI下書き機能: プロバイダ選択UIは出さず(シンプルさ優先)、モデル設定で選ばれている
  // プロバイダが接続済みならそれを、そうでなければ接続済みの最初のプロバイダを自動選択する。
  const bridge = getDesktopBridge();
  const aiConnection = useAiConnection();
  const claudeConnection = useClaudeConnection();
  const geminiConnection = useGeminiConnection();
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  // 実行中の下書き生成のrunId。ai-skill-draft:cancel に渡す。onRunIdはIPC往復開始前に
  // 同期で呼ばれるので、停止ボタンを押した直後でも必ず値が入っている。
  const draftRunIdRef = useRef<string | null>(null);
  // ユーザーが停止ボタンを押したことを覚えておくフラグ。キャンセルによる失敗結果
  // (result.ok===false)をタイムアウト等の本物のエラーと区別して、エラー表示を抑制するため。
  const draftCancelledRef = useRef(false);
  const contentTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const connectedProviders = useMemo(() => {
    const providers: AiProvider[] = [];
    if (aiConnection.state.kind === "loggedIn") providers.push("chatgpt");
    if (claudeConnection.state.kind === "loggedIn") providers.push("claude");
    if (geminiConnection.state.kind === "loggedIn") providers.push("antigravity");
    return providers;
  }, [aiConnection.state.kind, claudeConnection.state.kind, geminiConnection.state.kind]);

  const draftProvider = useMemo<AiProvider | null>(() => {
    if (connectedProviders.length === 0) {
      return null;
    }
    const preferred = getAiModelPreferences().provider;
    return connectedProviders.includes(preferred) ? preferred : connectedProviders[0];
  }, [connectedProviders]);

  const generateDraft = async () => {
    const trimmedPrompt = draftPrompt.trim();
    if (!trimmedPrompt || !draftProvider || !bridge?.aiSkillDraft) {
      return;
    }
    // 改訂時: 現在の本文はプロンプトのコンテキストとして送るので、まずスナップショットを
    // 取ってから、ストリーミング開始と同時に画面上はクリアして生成結果だけを逐次表示する。
    const currentContentSnapshot = content;
    // 失敗時(および1文字も届く前の中止時)は、クリアした既存本文を元に戻す。
    // 中止で部分テキストが届いている場合だけは、ユーザーが意図的に止めた結果として残す。
    let receivedDelta = false;
    const settleFailure = (error: string | null) => {
      if (draftCancelledRef.current) {
        if (!receivedDelta) {
          setContent(currentContentSnapshot);
        }
        return;
      }
      setContent(currentContentSnapshot);
      if (error) {
        setDraftError(error);
      }
    };
    setDraftBusy(true);
    setDraftError(null);
    draftCancelledRef.current = false;
    setContent("");
    try {
      const result = await bridge.aiSkillDraft.generate(
        {
          provider: draftProvider,
          prompt: trimmedPrompt,
          context: { title, description, currentContent: currentContentSnapshot },
        },
        (event) => {
          if (event.kind === "delta") {
            receivedDelta = true;
            setContent((current) => current + event.text);
          }
        },
        (runId) => {
          draftRunIdRef.current = runId;
        },
      );
      if (result.ok) {
        setContent(result.text);
      } else {
        settleFailure(result.error);
      }
    } catch (err) {
      settleFailure(err instanceof Error ? err.message : t("ai.error.draft"));
    } finally {
      setDraftBusy(false);
      draftRunIdRef.current = null;
    }
  };

  const cancelDraft = () => {
    draftCancelledRef.current = true;
    setDraftError(null);
    const runId = draftRunIdRef.current;
    if (runId && bridge?.aiSkillDraft?.cancel) {
      void bridge.aiSkillDraft.cancel(runId);
    }
  };

  // 生成中はストリーミングで伸びていく内容欄を常に末尾まで見せる。
  useEffect(() => {
    if (draftBusy && contentTextareaRef.current) {
      contentTextareaRef.current.scrollTop = contentTextareaRef.current.scrollHeight;
    }
  }, [content, draftBusy]);

  // SkillEditorは呼び出し側でスキルごとのkey付きで再マウントされるため、
  // 本文の読込はマウント時の1回だけでよい(effect内での同期setStateも不要になる)。
  useEffect(() => {
    if (!resourceId) {
      return;
    }
    let cancelled = false;
    aiResources.readFile(resourceId)
      .then((file) => {
        if (cancelled) {
          return;
        }
        const parsed = parseSkillFile(file.content);
        skillMetaRef.current = {
          slug: parsed.name ?? skillMetaRef.current.slug,
          extraFrontmatterLines: parsed.extraFrontmatterLines,
        };
        const fileDescription = parsed.description?.trim();
        if (fileDescription) {
          // SKILL.mdは各CLIが直接読む正本。旧manifestとの不一致や外部編集があっても、
          // 本文だけの保存で詳しいdescriptionをtitleへ戻さない。
          setDescription(fileDescription);
          setSavedDescription(fileDescription);
        }
        setContent(parsed.body);
        setSavedContent(parsed.body);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("ai.error.loadSkills"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId]);

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const dirty = title !== savedTitle || description !== savedDescription || content !== savedContent;
  const hasRequiredFields = trimmedTitle.length > 0 && trimmedDescription.length > 0;
  const canSave = isNew ? hasRequiredFields : dirty && hasRequiredFields;

  const saveExisting = async (targetResourceId: string) => {
    const composed = composeSkillFile({
      name: skillMetaRef.current.slug,
      description: trimmedDescription,
      body: content,
      extraFrontmatterLines: skillMetaRef.current.extraFrontmatterLines,
    });
    const saved = await aiResources.saveFile({
      resourceId: targetResourceId,
      content: composed,
      patch: { title: trimmedTitle, description: trimmedDescription },
    });
    const parsed = parseSkillFile(saved.content);
    skillMetaRef.current = {
      slug: parsed.name ?? skillMetaRef.current.slug,
      extraFrontmatterLines: parsed.extraFrontmatterLines,
    };
    setSavedTitle(saved.resource.title);
    setSavedDescription(saved.resource.description);
    setSavedContent(parsed.body);
  };

  const save = async () => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        let createdId = createdIdRef.current;
        if (!createdId) {
          // ここで初めてディスク上に作成する。名前が英数字ならそのままslugに、日本語等で
          // slug化できなければ内部slugは自動生成(ユーザーに見えるのは title のみ)。
          const slugCandidate = toSkillSlug(trimmedTitle);
          const created = await aiResources.createSkill(
            slugCandidate ? { name: slugCandidate, workspaceId } : { workspaceId },
          );
          createdId = created.resource.id;
          createdIdRef.current = createdId;
          skillMetaRef.current = {
            slug: skillSlugFromSourcePath(created.resource.sourcePath) ?? created.resource.id,
            extraFrontmatterLines: [],
          };
        }
        await saveExisting(createdId);
        notifyAiResourcesChanged();
        // ツリー再取得を待ってから編集モードへ切り替える(skills propに新スキルが載る前に
        // 遷移すると一覧へフォールバックしてちらつくため)。
        await onSaved();
        onCreated?.(createdId);
        return;
      }
      await saveExisting(resourceId!);
      setSavedFlash(true);
      notifyAiResourcesChanged();
      void onSaved();
      window.setTimeout(() => setSavedFlash(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.error.save"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!resource) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await aiResources.deleteResource(resource.id);
      notifyAiResourcesChanged();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ai.error.delete"));
    } finally {
      setBusy(false);
      setDeleteConfirmOpen(false);
    }
  };

  return (
    <>
    <Stack className="ai-settings-pane ai-settings-skill-editor" gap="lg">
      <Inline className="ai-settings-editor-title-row" gap="sm" align="center">
        <IconButton tone="ghost" size="sm" label={t("ai.backToSkills")} onClick={onBack}>
          <ChevronLeft size={17} />
        </IconButton>
        <input
          className="ai-settings-title-input"
          value={title}
          disabled={loading}
          autoFocus={isNew}
          placeholder={isNew ? t("ai.skillNamePlaceholderNew") : t("ai.skillNamePlaceholder")}
          onChange={(event) => setTitle(event.target.value)}
        />
        {isOfficial && <span className="ai-settings-official-badge">{t("ai.official")}</span>}
      </Inline>

      <SettingsField
        className="ai-settings-field"
        label={t("ai.skillDescription")}
        htmlFor="ai-settings-skill-description"
        meta={`${description.length}/${DESCRIPTION_MAX_LENGTH}`}
      >
        <input
          id="ai-settings-skill-description"
          className="ai-settings-description-input"
          value={description}
          disabled={loading}
          required
          aria-required="true"
          maxLength={DESCRIPTION_MAX_LENGTH}
          placeholder={t("ai.skillDescriptionPlaceholder")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </SettingsField>

      <SettingsField className="ai-settings-field ai-settings-skill-draft" label={t("ai.skillDraft")}>
        <ChatPromptField
          className="ai-settings-skill-draft-field"
          value={draftPrompt}
          onChange={setDraftPrompt}
          onSubmit={() => void generateDraft()}
          onCancel={cancelDraft}
          busy={draftBusy}
          disabled={loading || !draftProvider}
          placeholder={t("ai.skillDraftPlaceholder")}
          ariaLabel={t("ai.instructions")}
        />
        {!draftProvider && <p className="ai-settings-empty-hint ai-settings-skill-draft-hint">{t("ai.skillDraftNoProvider")}</p>}
        {draftError && <SettingsStatus className="ai-settings-error" tone="error">{draftError}</SettingsStatus>}
      </SettingsField>

      <SettingsField
        className="ai-settings-field ai-settings-field-grow"
        label={t("ai.skillBody")}
        htmlFor="ai-settings-skill-content"
        meta={`${content.length}/${CONTENT_MAX_LENGTH}`}
      >
        <textarea
          id="ai-settings-skill-content"
          ref={contentTextareaRef}
          className="ai-settings-textarea"
          value={content}
          disabled={loading}
          readOnly={draftBusy}
          maxLength={CONTENT_MAX_LENGTH}
          placeholder={t("ai.skillBodyPlaceholder")}
          onChange={(event) => setContent(event.target.value)}
        />
      </SettingsField>

      {error && <SettingsStatus className="ai-settings-error" tone="error">{error}</SettingsStatus>}

      <Inline as="footer" className="ai-settings-footer" gap="md" justify="end">
        {!isNew && (
          <Button
            tone="danger"
            disabled={busy || saving || isOfficial}
            title={isOfficial ? t("ai.skillDeleteBlocked") : undefined}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            {tCommon("actions.delete")}
          </Button>
        )}
        <span className="ai-settings-footer-spacer" />
        {isNew && trimmedTitle.length === 0 && (
          <span className="ai-settings-validation-hint">{t("ai.skillNameRequired")}</span>
        )}
        {trimmedTitle.length > 0 && trimmedDescription.length === 0 && (
          <span className="ai-settings-validation-hint">{t("ai.skillDescriptionRequired")}</span>
        )}
        {savedFlash && <span className="ai-settings-saved-flash" role="status" aria-live="polite">{t("ai.saved")}</span>}
        <Button tone="primary" disabled={!canSave || saving || loading} onClick={() => void save()}>
          {saving ? t("ai.saving") : tCommon("actions.save")}
        </Button>
      </Inline>
    </Stack>
    {deleteConfirmOpen && resource && (
      <ConfirmDialog
        title={t("ai.skillDeleteTitle")}
        message={t("ai.skillDeleteMessage", { title: title || resource.title })}
        okLabel={t("ai.skillDeleteOk")}
        destructive
        busy={busy}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void remove()}
      />
    )}
    </>
  );
}

function WorkspacePickerDialog({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onClose,
}: {
  workspaces: { id: string; name: string }[];
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const t = useT("settings");
  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="sm"
      layer="nested"
      ariaLabel={t("ai.selectWorkspace")}
      surfaceClassName="ai-settings-modal"
    >
      <ModalHeader title={t("ai.selectWorkspace")} onClose={onClose} />
      <ModalBody padding="none" className="ai-settings-workspace-list" role="listbox" aria-label={t("ai.targetWorkspace")}>
          {workspaces.map((workspace) => (
            <Button
              key={workspace.id}
              tone="ghost"
              role="option"
              aria-selected={workspace.id === selectedWorkspaceId}
              className={`ai-settings-workspace-option ${workspace.id === selectedWorkspaceId ? "selected" : ""}`}
              onClick={() => onSelect(workspace.id)}
            >
              <span>{workspace.name}</span>
            </Button>
          ))}
      </ModalBody>
    </ModalFrame>
  );
}

function ConfirmDialog({
  title,
  message,
  okLabel,
  destructive,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  okLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tCommon = useT("common");
  const dismiss = () => {
    if (!busy) {
      onCancel();
    }
  };
  return (
    <ModalFrame
      open
      onDismiss={dismiss}
      size="sm"
      layer="nested"
      ariaLabel={title}
      surfaceClassName="ai-settings-modal ai-settings-confirm-modal"
    >
      <ModalHeader title={title} onClose={dismiss} />
      <ModalBody padding="lg">
        <Stack gap="lg">
        <p className="ai-settings-confirm-message">{message}</p>
        <Inline as="footer" className="ai-settings-modal-footer" gap="sm" justify="end">
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            {tCommon("actions.cancel")}
          </Button>
          <Button tone={destructive ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {okLabel}
          </Button>
        </Inline>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}

// store側 normalizeResourceName と同じ規則で、タイトルからslug候補を作る。
// 日本語タイトル等でslug化できない場合は空文字を返し、createSkill側の自動命名に任せる。
function toSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const AI_SETTINGS_STYLE = `
.ai-settings-dialog { height: min(620px, 90vh); }
.ai-settings-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px minmax(0,1fr); overflow: hidden; }
.ai-settings-sidebar { min-height: 0; overflow: auto; border-right: 1px solid var(--border-subtle,#e5e5e5); background: var(--surface-soft,#f7f7f7); padding: var(--space-lg) var(--space-md); align-content: start; }
.ai-settings-nav-caption { margin: var(--space-none) var(--space-sm); color: var(--text-muted,#8a8a8a); font-size: 11px; font-weight: 600; line-height: 1.5; }
.ai-settings-nav-button { width: 100%; min-width: 0; justify-content: flex-start; text-align: left; }
.ai-settings-workspace-select { align-self: stretch; min-width: 0; margin-inline: var(--space-sm); justify-content: flex-start; text-align: left; }
.ai-settings-workspace-select span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-settings-content { min-height: 0; overflow: auto; padding: var(--space-xl) var(--space-2xl); }
.ai-settings-loading { min-height: 100%; padding: var(--space-xl) var(--space-2xl); }
.ai-settings-loading-title { width: min(220px, 56%); }
.ai-settings-loading-line { width: min(360px, 82%); height: 16px; border-radius: var(--radius-control); }
.ai-settings-loading-surface { flex: 1; min-height: 260px; border-radius: var(--radius-panel); }
.ai-settings-pane { min-height: 100%; display: flex; flex-direction: column; gap: var(--space-lg); }
.ai-settings-textarea-wrap { position: relative; flex: 1; min-height: 260px; display: flex; }
.ai-settings-textarea { flex: 1; width: 100%; resize: none; border: 1px solid var(--border,#dadada); border-radius: var(--radius-control); padding: var(--space-md) var(--space-lg); font: 13.5px/1.75 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif; color: var(--text-primary,#111); background: var(--background,#fff); }
.ai-settings-textarea:focus { outline: none; border-color: var(--accent,#1f5eff); }
.ai-settings-char-count { color: var(--text-muted,#8a8a8a); font-size: 11px; font-weight: 550; }
.ai-settings-textarea-wrap > .ai-settings-char-count { position: absolute; right: 12px; bottom: 10px; background: var(--background,#fff); padding: 1px var(--space-xs); border-radius: 999px; }
.ai-settings-footer-spacer { flex: 1; }
.ai-settings-saved-flash { color: var(--success,#247a3d); font-size: 12px; font-weight: 550; }
.ai-settings-validation-hint { color: var(--text-muted,#8a8a8a); font-size: 12px; }
.ai-settings-error { margin: var(--space-none); color: var(--danger,#b42318); font-size: 12px; }
.ai-settings-empty-hint { color: var(--text-muted,#8a8a8a); font-size: 13px; margin: var(--space-sm) var(--space-none); }
.ai-settings-empty { flex: 1; display: grid; place-items: center; gap: var(--space-lg); text-align: center; padding: var(--space-3xl) var(--space-xl); }
.ai-settings-empty p { max-width: 40ch; margin: var(--space-none); color: var(--text-secondary,#555); font-size: 13px; line-height: 1.7; }
.ai-settings-skill-list { list-style: none; margin: var(--space-none); padding: var(--space-none); display: grid; gap: var(--space-xs); }
.ai-settings-skill-list li { display: flex; align-items: center; gap: var(--space-sm); border-radius: var(--radius-control); }
.ai-settings-skill-list li:hover { background: var(--surface-soft,#f7f7f7); }
.ai-settings-skill-row { flex: 1; min-width: 0; display: grid; gap: var(--space-xs); border: 0; background: transparent; text-align: left; padding: var(--space-md); cursor: pointer; border-radius: var(--radius-control); }
.ai-settings-skill-row-title-line { min-width: 0; display: flex; align-items: center; gap: var(--space-sm); }
.ai-settings-skill-row-title { color: var(--text-primary,#111); font-size: 13.5px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-settings-official-badge { flex-shrink: 0; display: inline-flex; align-items: center; height: 18px; padding: var(--space-none) var(--space-sm); border: 1px solid var(--border,#dadada); border-radius: 999px; color: var(--text-secondary,#555); background: var(--surface-soft,#f7f7f7); font-size: 10px; font-weight: 650; line-height: 1; }
.ai-settings-skill-row-description { color: var(--text-muted,#8a8a8a); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-settings-switch-control { margin-right: var(--space-sm); }
.ai-settings-title-input { flex: 1; border: 0; background: transparent; font-size: 20px; font-weight: 650; color: var(--text-primary,#111); padding: var(--space-xs) 2px; }
.ai-settings-title-input:focus { outline: none; }
.ai-settings-field-grow { flex: 1; min-height: 0; grid-template-rows: auto minmax(0,1fr); }
.ai-settings-field-label-row { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; font-weight: 600; color: var(--text-secondary,#555); }
.ai-settings-description-input { height: 36px; border: 1px solid var(--border,#dadada); border-radius: var(--radius-control); padding: var(--space-none) var(--space-md); font-size: 13px; color: var(--text-primary,#111); background: var(--background,#fff); }
.ai-settings-description-input:focus { outline: none; border-color: var(--accent,#1f5eff); }
.ai-settings-skill-editor .ai-settings-field-grow .ai-settings-textarea { min-height: 220px; }
.ai-settings-skill-draft-field { padding: var(--space-sm); border-radius: var(--radius-panel); }
.ai-settings-skill-draft-field .ai-chat-input { width: 100%; overflow-y: auto; padding: var(--space-none) 2px; border: 0; border-radius: 0; background: transparent; color: var(--text-primary,#111); font-size: 13.5px; line-height: 1.55; resize: none; }
.ai-settings-skill-draft-field .ai-chat-input::placeholder { color: var(--text-muted,#8a8a8a); }
.ai-settings-skill-draft-field .ai-chat-input:focus-visible { outline: none; }
.ai-settings-skill-draft-hint { margin: var(--space-none); }
.ai-settings-modal { max-height: min(520px, 82vh); }
.ai-settings-workspace-list { min-height: 0; overflow: auto; padding: var(--space-sm); display: grid; gap: var(--space-xs); }
.ai-settings-workspace-option { min-width: 0; width: 100%; text-align: left; padding: var(--space-sm) var(--space-md); }
.ai-settings-workspace-option:hover { background: var(--surface-soft,#f7f7f7); }
.ai-settings-workspace-option.selected { background: var(--surface-muted,#f1f1f1); color: var(--text-primary,#111); }
.ai-settings-workspace-option span { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-settings-confirm-message { margin: var(--space-none); color: var(--text-primary,#111); font-size: 13px; line-height: 1.7; }
.ai-settings-modal-footer { width: 100%; }
@media (max-width: 720px) {
  .ai-settings-body { grid-template-columns: minmax(148px, 38%) minmax(0, 1fr); }
  .ai-settings-content { padding: var(--space-lg); }
}
`;
