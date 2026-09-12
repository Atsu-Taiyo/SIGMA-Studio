/**
 * 設定項目の索引。**WI-4 のコマンドパレットはこれを唯一の索引源にする**ので、
 * 「どのダイアログのどこにあるか」と「安定 ID」がここの責務。
 *
 * 決めごと:
 * - `id` は **永続する契約**。パレットの最近使った履歴やショートカット割り当てが
 *   これを保存するので、文言やファイル配置が変わっても書き換えない。
 * - `anchorId` は対応する `surface` のソースに `id="<anchorId>"` として実在すること
 *   (`settings-catalog.test.ts` がソース走査で固定する)。目印に日本語を使わないのは、
 *   i18n の各 WI が文言を差し替えても壊れないようにするため。
 * - 文言そのものは持たない。`labelKey` / `descriptionKey` / `keywordsKey` は
 *   `settings` namespace のキーで、表示側が `t()` で解決する。
 */

/** 設定項目が住んでいるダイアログ。パレットは「どれを開くか」をこれで決める。 */
export type SettingsSurfaceId =
  | "desktopApp"
  | "desktopAi"
  | "page"
  | "commands"
  | "aiResources"
  | "texEnvironment";

export interface SettingsEntryDefinition {
  /** 安定 ID。表示文言やファイル配置が変わっても不変。 */
  id: string;
  surface: SettingsSurfaceId;
  /** ダイアログ内のスクロール先 DOM id。無い場合はダイアログを開くだけ。 */
  anchorId?: string;
  /**
   * anchor を出すためにダイアログ側で先に選んでおく状態。
   * 折りたたみやタブの裏に居る項目は、これを見て開かないと **anchor が DOM に無い**。
   * 例: AI 設定のセクション id、ショートカット設定の `custom` パネル。
   */
  surfaceState?: string;
  /** `settings` namespace のキー。 */
  labelKey: string;
  descriptionKey?: string;
  /** 検索用の別名。日本語と英語の両方を1つの文字列に詰める。 */
  keywordsKey?: string;
}

export const SETTINGS_ENTRIES: readonly SettingsEntryDefinition[] = [
  // --- アプリ設定 (DesktopSettingsModal, mode="app") ---
  {
    id: "settings.app.language",
    surface: "desktopApp",
    anchorId: "desktop-settings-language-row",
    labelKey: "language.label",
    descriptionKey: "language.description",
    keywordsKey: "catalog.keywords.language",
  },
  {
    id: "settings.app.fonts",
    surface: "desktopApp",
    anchorId: "desktop-settings-font-add",
    labelKey: "app.font.add",
    descriptionKey: "app.font.addDescription",
    keywordsKey: "catalog.keywords.fonts",
  },
  {
    id: "settings.app.version",
    surface: "desktopApp",
    anchorId: "desktop-settings-app-version",
    labelKey: "app.update.version",
    keywordsKey: "catalog.keywords.update",
  },
  {
    id: "settings.app.dataDir",
    surface: "desktopApp",
    anchorId: "desktop-settings-data-dir",
    labelKey: "app.localData.path",
    keywordsKey: "catalog.keywords.dataDir",
  },
  // --- AI 設定 (DesktopSettingsModal, mode="ai") ---
  {
    id: "settings.ai.agents",
    surface: "desktopAi",
    anchorId: "desktop-settings-ai-agents",
    labelKey: "provider.section",
    keywordsKey: "catalog.keywords.aiAgents",
  },
  {
    id: "settings.ai.autoApply",
    surface: "desktopAi",
    anchorId: "desktop-settings-auto-apply",
    labelKey: "provider.autoApply.label",
    descriptionKey: "provider.autoApply.description",
    keywordsKey: "catalog.keywords.autoApply",
  },
  {
    id: "settings.ai.webSearch",
    surface: "desktopAi",
    anchorId: "desktop-settings-web-search",
    labelKey: "provider.webSearch.label",
    descriptionKey: "provider.webSearch.description",
    keywordsKey: "catalog.keywords.webSearch",
  },
  // --- ページ設定 (PageSettingsDialog) ---
  {
    id: "settings.page.paper",
    surface: "page",
    anchorId: "page-settings-paper",
    labelKey: "page.paperSize",
    keywordsKey: "catalog.keywords.paper",
  },
  {
    id: "settings.page.margins",
    surface: "page",
    anchorId: "page-settings-margins",
    labelKey: "page.margins",
    keywordsKey: "catalog.keywords.margins",
  },
  {
    id: "settings.page.columns",
    surface: "page",
    anchorId: "page-settings-columns",
    labelKey: "page.columns",
    keywordsKey: "catalog.keywords.columns",
  },
  {
    id: "settings.page.header",
    surface: "page",
    anchorId: "page-settings-header",
    labelKey: "page.header",
    keywordsKey: "catalog.keywords.header",
  },
  {
    id: "settings.page.footer",
    surface: "page",
    anchorId: "page-settings-footer",
    labelKey: "page.footer",
    keywordsKey: "catalog.keywords.footer",
  },
  {
    id: "settings.page.math",
    surface: "page",
    anchorId: "page-settings-math",
    labelKey: "page.math",
    descriptionKey: "page.fractionSameSize",
    keywordsKey: "catalog.keywords.math",
  },
  // --- ショートカット設定 (CommandSettingsDialog) ---
  {
    id: "settings.commands.shortcuts",
    surface: "commands",
    anchorId: "command-shortcuts-table",
    labelKey: "commands.title",
    keywordsKey: "catalog.keywords.shortcuts",
  },
  {
    id: "settings.commands.custom",
    surface: "commands",
    anchorId: "custom-command-panel",
    // 既定では畳まれている。開かないと anchor が存在しない。
    surfaceState: "custom-open",
    labelKey: "commands.customCommand",
    keywordsKey: "catalog.keywords.customCommand",
  },
  // --- AI リソース (AiSettingsDialog) ---
  {
    id: "settings.aiResources.globalInstructions",
    surface: "aiResources",
    anchorId: "ai-settings-global-instructions",
    surfaceState: "global-instructions",
    labelKey: "ai.instructions",
    descriptionKey: "ai.globalInstructionsDescription",
    keywordsKey: "catalog.keywords.instructions",
  },
  {
    id: "settings.aiResources.globalSkills",
    surface: "aiResources",
    anchorId: "ai-settings-global-skills",
    surfaceState: "global-skills",
    labelKey: "ai.skills",
    keywordsKey: "catalog.keywords.skills",
  },
  {
    id: "settings.aiResources.workspaceSkills",
    surface: "aiResources",
    anchorId: "ai-settings-workspace-skills",
    surfaceState: "workspace-skills",
    labelKey: "ai.skills",
    keywordsKey: "catalog.keywords.skills",
  },
  // --- TeX 環境設定 (TexEnvironmentSettingsDialog) ---
  {
    id: "settings.tex.preamble",
    surface: "texEnvironment",
    anchorId: "tex-preamble-label",
    labelKey: "tex.preamble",
    descriptionKey: "tex.description",
    keywordsKey: "catalog.keywords.texPreamble",
  },
];

/**
 * `desktopApp` / `desktopAi` は同じ `DesktopSettingsModal` の別モード。
 * どちらで開くかをパレット側がハードコードせずに済むよう、ここで機械可読にしておく。
 */
export const SETTINGS_SURFACE_DESKTOP_MODE: Readonly<Partial<Record<SettingsSurfaceId, "app" | "ai">>> = {
  desktopApp: "app",
  desktopAi: "ai",
};

/** `surface` → その面のソースファイル (テストが `anchorId` の実在を確かめる先)。 */
export const SETTINGS_SURFACE_SOURCES: Readonly<Record<SettingsSurfaceId, string>> = {
  desktopApp: "src/components/editor/DesktopSettingsModal.tsx",
  desktopAi: "src/components/editor/DesktopSettingsModal.tsx",
  page: "src/components/editor/PageSettingsDialog.tsx",
  commands: "src/components/editor/CommandSettingsDialog.tsx",
  aiResources: "src/components/editor/AiSettingsDialog.tsx",
  texEnvironment: "src/components/editor/TexEnvironmentSettingsDialog.tsx",
};

/** `focusEntryId` からダイアログ側が先に選ぶべき状態を引く。 */
export function getSettingsEntrySurfaceState(entryId: string | undefined): string | undefined {
  return entryId === undefined ? undefined : findSettingsEntry(entryId)?.surfaceState;
}

export function findSettingsEntry(id: string): SettingsEntryDefinition | undefined {
  return SETTINGS_ENTRIES.find((entry) => entry.id === id);
}

export function getSettingsEntriesForSurface(
  surface: SettingsSurfaceId,
): readonly SettingsEntryDefinition[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.surface === surface);
}
