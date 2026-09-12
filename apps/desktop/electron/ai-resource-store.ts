import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { composeSkillFile, parseSkillFile } from "@/lib/ai/skill-frontmatter";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

const DATA_DIR_NAME = "data";
const AI_RESOURCE_DIR_NAME = "ai-agent-config";
const MANIFEST_FILE_NAME = "manifest.json";
const SYNC_MANIFEST_FILE_NAME = ".sync-manifest.json";

// 固定id: グローバル指示は常に1本だけ存在する(readManifestが無ければ挿入する)。
// ワークスペース指示は `workspace-instructions:<workspaceId>` で、初回保存まで
// manifest に存在しない(空扱い)。
export const GLOBAL_INSTRUCTIONS_ID = "global-instructions";
export const OFFICIAL_IMAGE_MATERIAL_SKILL_ID = "official-image-material";
export const OFFICIAL_GRAPH_SKILL_ID = "official-graph";
const ALL_PROVIDERS: AiResourceProvider[] = ["codex", "claude", "antigravity"];

export type AiResourceKind = "instruction" | "skill";
export type AiResourceProvider = "codex" | "claude" | "antigravity";
export type AiResourceLoadMode = "always" | "auto" | "manual";
export type AiResourceOrigin = "official";
export type AiResourceOfficialState = "managed" | "modified";

export interface AiResourceManifestEntry {
  id: string;
  kind: AiResourceKind;
  title: string;
  sourcePath: string;
  enabled: boolean;
  providers: AiResourceProvider[];
  loadMode: AiResourceLoadMode;
  description: string;
  tags: string[];
  /** null/undefined = グローバル(すべてのワークスペースで使用)。文字列 = そのワークスペースIDだけに適用。
   * skill・instruction のどちらもワークスペーススコープを持ちうる(2層: グローバル/ワークスペース)。 */
  workspaceId?: string | null;
  /** アプリ同梱リソースだけに付く所有権。未設定のエントリはすべてユーザー管理。 */
  origin?: AiResourceOrigin;
  /** 最後にアプリが書き込んだ同梱本文のSHA-256。手編集検知と安全な更新判定に使う。 */
  bundledHash?: string;
  /** 最後にアプリが適用した同梱タイトル。異なる現在値はユーザー編集として保持する。 */
  bundledTitle?: string;
  /** 最後にアプリが適用した同梱説明。異なる現在値はユーザー編集として保持する。 */
  bundledDescription?: string;
  /** modified は、本文が bundledHash と一致せずアプリ更新で上書きしない状態。 */
  officialState?: AiResourceOfficialState;
  updatedAt: string;
}

export interface AiResourceTree {
  sourceRoot: string;
  codexRuntimeRoot: string;
  claudeRuntimeRoot: string;
  geminiRuntimeRoot: string;
  resources: AiResourceManifestEntry[];
}

export interface AiResourceFile {
  resource: AiResourceManifestEntry;
  content: string;
}

/**
 * ミューテーション系APIの返り値。runtimeChanged は、この操作の結果いずれかのproviderの
 * runtime投影ファイル(AGENTS.md/CLAUDE.md/skillsディレクトリ)が実際に書き換わったか。
 * 呼び出し側(main.ts)はこれが true のときだけAIランタイムを再起動すればよい
 * (プロンプト注入だけで届くワークスペースリソースの変更では再起動不要)。
 */
export interface AiResourceMutationResult extends AiResourceFile {
  runtimeChanged: boolean;
}

export interface AiResourceContextItem {
  id: string;
  kind: AiResourceKind;
  title: string;
  loadMode: AiResourceLoadMode;
  description: string;
  tags: string[];
  content?: string;
}

export interface AiResourceRunContext {
  provider: AiResourceProvider;
  /** グローバル指示 + 対象ワークスペースの指示。本文は常に注入する。 */
  always: AiResourceContextItem[];
  /** コンポーザーで明示的に選ばれたリソース。本文を注入する。 */
  explicit: AiResourceContextItem[];
}

interface AiResourceManifestFile {
  version: 1;
  resources: AiResourceManifestEntry[];
}

// Tracks, per (provider, workspaceScope) target, a content fingerprint of
// everything the last syncToRuntimeTargets() call actually wrote there
// (target path + hash of its written body, across every enabled resource
// projected to that provider×workspace directory). syncToRuntimeTargets()
// recomputes this fingerprint on every call and skips all rm/write filesystem
// work for a target whose fingerprint is unchanged (Finding: syncToRuntimeTargets
// used to unconditionally rm-and-rewrite AGENTS.md/CLAUDE.md and the whole
// skills tree for every provider on every single ai-edit:run turn, even when
// nothing had changed). Keys are `"<provider>::<workspaceId|global>"`
// (see syncTargetKey) since each workspace now gets its own union-projected
// directory alongside the global fallback one.
interface AiResourceSyncTargetEntry {
  hash: string;
  syncedAt: string;
}
interface AiResourceSyncManifestFile {
  version: 1;
  targets: Record<string, AiResourceSyncTargetEntry>;
}

interface ProviderTargetFingerprint {
  target: string;
  hash: string;
}

// フォールバック(workspaceId未解決のrun用)の固定ルートディレクトリ名。ワークスペーススコープの
// runは代わりに `agent-workspaces/<workspaceId>/<provider>` を使う(agentWorkspaceRootRelative)。
const PROVIDER_FALLBACK_ROOT_NAME: Record<AiResourceProvider, string> = {
  codex: "codex-agent-workspace",
  claude: "claude-agent-home",
  antigravity: "antigravity-agent-workspace",
};
const AGENT_WORKSPACES_DIR_NAME = "agent-workspaces";

/* eslint-disable no-restricted-syntax -- Canonical AI-facing metadata is persisted and must not follow the UI locale. */
const GLOBAL_INSTRUCTIONS_ENTRY: Omit<AiResourceManifestEntry, "updatedAt"> = {
  id: GLOBAL_INSTRUCTIONS_ID,
  kind: "instruction",
  title: "グローバル指示",
  sourcePath: "instructions/global.md",
  enabled: true,
  providers: ALL_PROVIDERS,
  loadMode: "always",
  description: "すべてのワークスペースで、AIが常に従う指示です。",
  tags: [],
  workspaceId: null,
};

interface OfficialSkillDefinition {
  id: string;
  title: string;
  sourcePath: string;
  description: string;
  tags: string[];
  bundledPath: string;
}

const OFFICIAL_SKILL_DEFINITIONS: OfficialSkillDefinition[] = [
  {
    id: OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
    title: "画像からSigma Studio教材を作成",
    sourcePath: "skills/sigma-image-material-reconstruction/SKILL.md",
    description: "画像、写真、スクリーンショット、手書きラフを基に、本文・数式・表・グラフ・図形・注記を編集可能なSigma Studio教材として再構成するときに使う。",
    tags: ["画像", "教材再構成", "OCR", "図形"],
    bundledPath: "sigma-image-material-reconstruction/SKILL.md",
  },
  {
    id: OFFICIAL_GRAPH_SKILL_ID,
    title: "グラフを挿入・更新する",
    sourcePath: "skills/sigma-graph-editing/SKILL.md",
    description: "Sigma Studio教材で関数グラフ、座標平面、数直線、領域図を挿入・更新し、軸・曲線・点・ラベルまで検証するときに使う。",
    tags: ["グラフ", "Graph2D", "関数", "座標"],
    bundledPath: "sigma-graph-editing/SKILL.md",
  },
];
/* eslint-enable no-restricted-syntax */

export interface LocalAiResourceStoreOptions {
  /** bundled updateを再現するテスト用。指定しないidはリポジトリ同梱SKILL.mdを読む。 */
  officialSkillContentOverrides?: Partial<Record<string, string>>;
  /** bundled metadata updateを再現するテスト用。 */
  officialSkillMetadataOverrides?: Partial<Record<string, { title?: string; description?: string }>>;
}

interface OfficialSkillBundle {
  definition: OfficialSkillDefinition;
  content: string;
  hash: string;
}

export class LocalAiResourceStore {
  private readonly dataDir: string;
  private readonly sourceRoot: string;
  private readonly manifestPath: string;
  private readonly syncManifestPath: string;
  private readonly codexRuntimeRoot: string;
  private readonly claudeRuntimeRoot: string;
  private readonly geminiRuntimeRoot: string;
  private readonly officialSkillContentOverrides: Partial<Record<string, string>>;
  private readonly officialSkillMetadataOverrides: Partial<Record<string, { title?: string; description?: string }>>;
  private officialSkillBundlesPromise?: Promise<OfficialSkillBundle[]>;
  private officialSkillsSeedPromise?: Promise<void>;

  constructor(userDataPath: string, options: LocalAiResourceStoreOptions = {}) {
    this.dataDir = path.join(userDataPath, DATA_DIR_NAME);
    this.sourceRoot = path.join(this.dataDir, AI_RESOURCE_DIR_NAME);
    this.manifestPath = path.join(this.sourceRoot, MANIFEST_FILE_NAME);
    this.syncManifestPath = path.join(this.sourceRoot, SYNC_MANIFEST_FILE_NAME);
    this.codexRuntimeRoot = path.join(this.dataDir, PROVIDER_FALLBACK_ROOT_NAME.codex);
    this.claudeRuntimeRoot = path.join(this.dataDir, PROVIDER_FALLBACK_ROOT_NAME.claude);
    this.geminiRuntimeRoot = path.join(this.dataDir, PROVIDER_FALLBACK_ROOT_NAME.antigravity);
    this.officialSkillContentOverrides = options.officialSkillContentOverrides ?? {};
    this.officialSkillMetadataOverrides = options.officialSkillMetadataOverrides ?? {};
  }

  async getTree(): Promise<AiResourceTree> {
    const manifest = await this.readManifest();
    return {
      sourceRoot: this.sourceRoot,
      codexRuntimeRoot: this.codexRuntimeRoot,
      claudeRuntimeRoot: this.claudeRuntimeRoot,
      geminiRuntimeRoot: this.geminiRuntimeRoot,
      resources: manifest.resources,
    };
  }

  async readFile(resourceId: string): Promise<AiResourceFile> {
    const manifest = await this.readManifest();
    const resource = manifest.resources.find((item) => item.id === resourceId);
    if (!resource) {
      throw new Error(ta("desktop.resource.notFound"));
    }
    const content = await this.readResourceContent(resource);
    return { resource, content };
  }

  async saveFile(input: {
    resourceId: string;
    content: string;
    patch?: Partial<Pick<AiResourceManifestEntry, "title" | "description" | "enabled">>;
  }): Promise<AiResourceMutationResult> {
    const manifest = await this.readManifest();
    const index = manifest.resources.findIndex((item) => item.id === input.resourceId);
    if (index < 0) {
      throw new Error(ta("desktop.resource.notFound"));
    }
    const current = manifest.resources[index];
    let patched = normalizeEntry({
      ...current,
      ...input.patch,
      updatedAt: new Date().toISOString(),
    });
    const normalizedContent = patched.kind === "skill"
      ? normalizeSkillContent(patched, input.content, input.patch?.description)
      : { content: input.content, description: patched.description };
    if (patched.kind === "skill") {
      patched = normalizeEntry({ ...patched, description: normalizedContent.description });
    }
    const next = current.origin === "official"
      ? normalizeEntry({
          ...patched,
          officialState: current.bundledHash !== undefined && sha256(normalizedContent.content) === current.bundledHash
            ? "managed"
            : "modified",
        })
      : patched;
    const filePath = this.resolveSourcePath(next.sourcePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, normalizedContent.content, "utf8");
    manifest.resources[index] = next;
    await this.writeManifest(manifest);
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { resource: next, content: normalizedContent.content, runtimeChanged };
  }

  /**
   * 「AIへの指示」の保存入口。グローバル/ワークスペースとも同じ形: manifest に指示エントリが
   * 無ければ遅延作成する(旧manifestの旧ID指示が読み込み時に捨てられた直後でも、グローバル指示は
   * readManifest が必ず補完するため通常ここでの新規作成はワークスペース指示のみ)。
   */
  async saveInstruction(input: { workspaceId?: string | null; content: string }): Promise<AiResourceMutationResult> {
    const manifest = await this.readManifest();
    const workspaceId = input.workspaceId ?? null;
    const id = workspaceId ? `workspace-instructions:${workspaceId}` : GLOBAL_INSTRUCTIONS_ID;
    const existing = manifest.resources.find((item) => item.id === id);
    if (existing) {
      return this.saveFile({ resourceId: id, content: input.content });
    }
    const entry = normalizeEntry({
      ...(workspaceId
        ? {
            id,
            // eslint-disable-next-line no-restricted-syntax -- Persisted/model-facing canonical metadata.
            title: "ワークスペースの指示",
            sourcePath: `instructions/workspaces/${workspaceId}.md`,
            description: "",
            workspaceId,
          }
        : GLOBAL_INSTRUCTIONS_ENTRY),
      kind: "instruction",
      enabled: true,
      providers: ALL_PROVIDERS,
      loadMode: "always",
      tags: [],
      updatedAt: new Date().toISOString(),
    });
    const filePath = this.resolveSourcePath(entry.sourcePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.content, "utf8");
    manifest.resources.push(entry);
    await this.writeManifest(manifest);
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { resource: entry, content: input.content, runtimeChanged };
  }

  /**
   * skillはグローバル(workspaceId省略/null)またはワークスペーススコープ(workspaceId指定)で
   * 作成する。いずれも全プロバイダ(codex/claude/antigravity)向けに作成し、loadModeは内部的に
   * "auto" 固定(UIには出さない)。name省略時は "skill" ベースで一意な名前を生成する。
   * 名前は全スコープ横断で一意にする(投影先がプロバイダごとにフラットな名前空間のため、
   * 同名のグローバルskillとワークスペースskillが同じ投影パスを取り合うことはできない)。
   */
  async createSkill(input: { name?: string; workspaceId?: string | null } = {}): Promise<AiResourceMutationResult> {
    const manifest = await this.readManifest();
    const trimmedName = input.name?.trim();
    let base = "skill";
    if (trimmedName) {
      const normalized = normalizeResourceName(trimmedName);
      if (!normalized) {
        throw new Error(ta("desktop.resource.invalidSkillName"));
      }
      base = normalized;
    }
    const workspaceId = typeof input.workspaceId === "string" && input.workspaceId.trim()
      ? input.workspaceId.trim()
      : undefined;
    const { name, id, sourcePath } = uniqueSkillName(base, manifest, workspaceId);
    const entry = normalizeEntry({
      id,
      kind: "skill",
      title: name,
      sourcePath,
      enabled: true,
      providers: ALL_PROVIDERS,
      loadMode: "auto",
      description: name,
      tags: [],
      workspaceId,
      updatedAt: new Date().toISOString(),
    });
    const content = composeSkillFile({ name, description: entry.description, body: "" });
    await fs.mkdir(path.dirname(this.resolveSourcePath(sourcePath)), { recursive: true });
    await fs.writeFile(this.resolveSourcePath(sourcePath), content, "utf8");
    manifest.resources.push(entry);
    await this.writeManifest(manifest);
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { resource: entry, content, runtimeChanged };
  }

  /** リスト上の有効/無効スイッチ用: 本文には触れずmanifestのenabledだけを更新して同期する。 */
  async setResourceEnabled(
    resourceId: string,
    enabled: boolean,
  ): Promise<{ resource: AiResourceManifestEntry; runtimeChanged: boolean }> {
    const manifest = await this.readManifest();
    const index = manifest.resources.findIndex((item) => item.id === resourceId);
    if (index < 0) {
      throw new Error(ta("desktop.resource.notFound"));
    }
    const next = normalizeEntry({ ...manifest.resources[index], enabled, updatedAt: new Date().toISOString() });
    manifest.resources[index] = next;
    await this.writeManifest(manifest);
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { resource: next, runtimeChanged };
  }

  /**
   * MCPの save_ai_resource tool向けのcreate-or-update入口。resourceIdではなくkind+nameで
   * 引くため、id/sourcePathの組み立てルールはcreateSkillと揃えてある。skillは常にアプリ
   * 全体スコープなので、ここでの操作は常にそのままグローバルなskillを対象にする。
   */
  async saveManagedResource(input: {
    kind: AiResourceKind;
    name: string;
    title?: string;
    body: string;
    enabled?: boolean;
  }): Promise<AiResourceMutationResult> {
    if (input.kind === "instruction") {
      return this.saveManagedInstruction(input);
    }
    return this.saveManagedSkill(input);
  }

  private async saveManagedInstruction(input: { name: string; title?: string; body: string; enabled?: boolean }): Promise<AiResourceMutationResult> {
    const id = input.name.trim();
    // ワークスペース指示(workspace-instructions:<ws>)を含む他のinstruction idは
    // MCPからは操作させない(「グローバルのみ操作」契約)。
    if (id !== GLOBAL_INSTRUCTIONS_ID) {
      throw new Error(ta("desktop.resource.instructionUpdateRestricted", { id: GLOBAL_INSTRUCTIONS_ID }));
    }
    const patch: Partial<Pick<AiResourceManifestEntry, "title" | "enabled">> = {};
    if (input.title !== undefined) {
      patch.title = input.title;
    }
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled;
    }
    return this.saveFile({ resourceId: id, content: input.body, patch });
  }

  private async saveManagedSkill(input: { name: string; title?: string; body: string; enabled?: boolean }): Promise<AiResourceMutationResult> {
    const name = normalizeResourceName(input.name);
    if (!name) {
      throw new Error(ta("desktop.resource.invalidSkillName"));
    }
    const manifest = await this.readManifest();
    const existing = manifest.resources.find((item) => item.kind === "skill" && item.id === `skill-${name}`);
    // MCPは「グローバルのみ操作」契約: skill名は全スコープ横断で一意なので、同名がワークスペース
    // スキルとして存在する場合、黙って更新する(他ワークスペースのスキルを書き換えうる)ことも
    // 黙って `-2` サフィックスの別名グローバルスキルを作ることもせず、明示的に拒否する。
    if (existing && existing.workspaceId != null) {
      throw new Error(ta("desktop.resource.workspaceSkillExists", { name }));
    }
    if (existing) {
      const patch: Partial<Pick<AiResourceManifestEntry, "title" | "enabled">> = {};
      if (input.title !== undefined) {
        patch.title = input.title;
      }
      if (input.enabled !== undefined) {
        patch.enabled = input.enabled;
      }
      return this.saveFile({ resourceId: existing.id, content: input.body, patch });
    }
    const { name: uniqueName, id, sourcePath } = uniqueSkillName(name, manifest);
    const title = input.title?.trim() || uniqueName;
    const entry = normalizeEntry({
      id,
      kind: "skill",
      title,
      sourcePath,
      enabled: input.enabled !== false,
      providers: ALL_PROVIDERS,
      loadMode: "auto",
      description: title,
      tags: [],
      updatedAt: new Date().toISOString(),
    });
    const rawContent = input.body.trim() || composeSkillFile({
      name: uniqueName,
      description: title,
      body: `# ${uniqueName}\n`,
    });
    const normalizedContent = normalizeSkillContent(entry, rawContent);
    const savedEntry = normalizeEntry({ ...entry, description: normalizedContent.description });
    await fs.mkdir(path.dirname(this.resolveSourcePath(savedEntry.sourcePath)), { recursive: true });
    await fs.writeFile(this.resolveSourcePath(savedEntry.sourcePath), normalizedContent.content, "utf8");
    manifest.resources.push(savedEntry);
    await this.writeManifest(manifest);
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { resource: savedEntry, content: normalizedContent.content, runtimeChanged };
  }

  /** MCPの delete_ai_resource tool向け。instructionは削除対象外。 */
  async deleteManagedResourceByName(kind: AiResourceKind, name: string): Promise<{ ok: true; runtimeChanged: boolean }> {
    if (kind === "instruction") {
      throw new Error(ta("desktop.resource.instructionDeleteForbidden"));
    }
    const normalized = normalizeResourceName(name);
    const id = `skill-${normalized}`;
    const manifest = await this.readManifest();
    const resource = manifest.resources.find((item) => item.id === id);
    if (!resource) {
      throw new Error(ta("desktop.resource.notFound"));
    }
    // saveManagedSkill と同じ「グローバルのみ操作」契約: ワークスペーススキルはMCPから削除させない。
    if (resource.workspaceId != null) {
      throw new Error(ta("desktop.resource.workspaceSkillDeleteForbidden", { name: normalized }));
    }
    return this.deleteResource(id);
  }

  async deleteResource(resourceId: string): Promise<{ ok: true; runtimeChanged: boolean }> {
    const manifest = await this.readManifest();
    const resource = manifest.resources.find((item) => item.id === resourceId);
    if (!resource) {
      return { ok: true, runtimeChanged: false };
    }
    if (resource.origin === "official") {
      throw new Error(ta("desktop.resource.officialDeleteForbidden"));
    }
    const filePath = this.resolveSourcePath(resource.sourcePath);
    if (resource.kind === "skill") {
      // skillはSKILL.md単体ではなくディレクトリ単位で削除する(references/等の同居ファイルを
      // 想定した先回り。現状SKILL.md以外は作らないが、将来supporting filesが増えても
      // 取り残さないようにする)。
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    } else {
      await fs.rm(filePath, { force: true });
    }
    await this.writeManifest({
      version: 1,
      resources: manifest.resources.filter((item) => item.id !== resourceId),
    });
    const runtimeChanged = await this.syncToRuntimeTargets();
    return { ok: true, runtimeChanged };
  }

  /**
   * Projects enabled resources onto each (provider, workspaceScope) runtime
   * target directory: the fixed fallback directories (codex-agent-workspace /
   * claude-agent-home / antigravity-agent-workspace, used when a run's
   * workspaceId can't be resolved) plus one `agent-workspaces/<workspaceId>/
   * <provider>` directory per workspace, each getting the *union* of global
   * resources and that workspace's own resources. Differential: for each
   * requested (provider, workspaceScope) pair, first recomputes a content
   * fingerprint of what would be written and compares it against the
   * fingerprint recorded from the last sync (persisted in
   * `.sync-manifest.json` under the source root, keyed by
   * `"<provider>::<workspaceId|global>"`). If unchanged, that target's
   * rm/write filesystem work is skipped entirely (the common case on every
   * ai-edit:run turn, where nothing was edited between turns).
   *
   * `options.providers` narrows which providers to (re)sync; omitted/empty
   * means all three. `options.workspaceIds` narrows which workspace scopes to
   * (re)sync (`null` = the fallback directories); omitted/empty means the
   * fallback scope plus every workspace that already has a materialized
   * `agent-workspaces/<workspaceId>` directory on disk (so a global resource
   * edit re-projects into every workspace directory that's ever been used,
   * without this store needing to know the full list of workspace ids that
   * exist app-wide). Returns true when at least one target's runtime files
   * were actually rewritten (callers use this to decide whether the warmed AI
   * runtimes need a restart).
   */
  async syncToRuntimeTargets(
    options: { providers?: AiResourceProvider[]; workspaceIds?: (string | null)[] } = {},
  ): Promise<boolean> {
    const manifest = await this.readManifest();
    const targetProviders = options.providers && options.providers.length > 0
      ? Array.from(new Set(options.providers))
      : ALL_PROVIDERS;
    const targetWorkspaceIds = options.workspaceIds && options.workspaceIds.length > 0
      ? Array.from(new Set(options.workspaceIds))
      : [null, ...await this.listExistingAgentWorkspaceIds()];

    const syncManifest = await this.readSyncManifest();
    let syncManifestChanged = false;
    for (const provider of targetProviders) {
      for (const workspaceId of targetWorkspaceIds) {
        const key = syncTargetKey(provider, workspaceId);
        const fingerprints = await this.computeProviderFingerprints(manifest, provider, workspaceId);
        const hash = hashFingerprints(fingerprints);
        if (syncManifest.targets[key]?.hash === hash) {
          continue;
        }
        await this.writeProviderRuntimeTargets(provider, manifest, workspaceId);
        syncManifest.targets[key] = { hash, syncedAt: new Date().toISOString() };
        syncManifestChanged = true;
      }
    }
    if (syncManifestChanged) {
      await this.writeSyncManifest(syncManifest);
    }
    return syncManifestChanged;
  }

  /** ディスク上に実在する `agent-workspaces/<workspaceId>` ディレクトリ名を列挙する(無ければ空)。 */
  private async listExistingAgentWorkspaceIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.dataDir, AGENT_WORKSPACES_DIR_NAME), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async computeProviderFingerprints(
    manifest: AiResourceManifestFile,
    provider: AiResourceProvider,
    workspaceId: string | null,
  ): Promise<ProviderTargetFingerprint[]> {
    const fingerprints: ProviderTargetFingerprint[] = [];
    for (const resource of manifest.resources) {
      if (!resource.enabled || !resource.providers.includes(provider)) {
        continue;
      }
      const target = deriveRuntimeTarget(resource, provider, workspaceId);
      if (!target) {
        continue;
      }
      const content = await this.readResourceContent(resource).catch(() => "");
      if (!content) {
        continue;
      }
      fingerprints.push({ target, hash: sha256(content) });
    }
    fingerprints.sort((a, b) => a.target.localeCompare(b.target));
    return fingerprints;
  }

  private async writeProviderRuntimeTargets(
    provider: AiResourceProvider,
    manifest: AiResourceManifestFile,
    workspaceId: string | null,
  ): Promise<void> {
    const runtimeRoot = this.getAgentWorkspaceDir(provider, workspaceId);
    await fs.mkdir(runtimeRoot, { recursive: true });
    // 消してよいのは各ルート直下の AGENTS.md/CLAUDE.md と skills サブツリーだけ。
    // ワークスペース用ディレクトリ(agent-workspaces/<ws>/<provider>)でも丸ごとrmは絶対にしない:
    // codexの永続作業ファイル、antigravityのmcp_config.json・添付ファイルなどが同居するため
    // (フォールバックディレクトリ向けの既存の注意書きと同じ理由が、ワークスペース用にも
    // そのまま当てはまる)。
    if (provider === "codex") {
      await fs.rm(path.join(runtimeRoot, "AGENTS.md"), { force: true });
      await fs.rm(path.join(runtimeRoot, ".agents", "skills"), { recursive: true, force: true });
    } else if (provider === "claude") {
      await fs.rm(path.join(runtimeRoot, "CLAUDE.md"), { force: true });
      await fs.rm(path.join(runtimeRoot, ".claude", "skills"), { recursive: true, force: true });
    } else {
      // Antigravity CLI は作業ディレクトリ直下の AGENTS.md と .agents/skills を
      // ネイティブ認識する。同じ .agents 配下の mcp_config.json
      // (gemini-settings-config.ts が書くMCP起動設定)を巻き込むと編集自体が壊れるため、
      // .agents 全体のrmは絶対にしない。
      await fs.rm(path.join(runtimeRoot, "AGENTS.md"), { force: true });
      await fs.rm(path.join(runtimeRoot, ".agents", "skills"), { recursive: true, force: true });
    }

    for (const resource of manifest.resources) {
      if (!resource.enabled || !resource.providers.includes(provider)) {
        continue;
      }
      const target = deriveRuntimeTarget(resource, provider, workspaceId);
      if (!target) {
        continue;
      }
      const content = await this.readResourceContent(resource).catch(() => "");
      if (!content) {
        continue;
      }
      const targetPath = safeJoin(this.dataDir, target);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }
  }

  private async readSyncManifest(): Promise<AiResourceSyncManifestFile> {
    try {
      const raw = await fs.readFile(this.syncManifestPath, "utf8");
      return normalizeSyncManifest(JSON.parse(raw) as unknown);
    } catch {
      return { version: 1, targets: {} };
    }
  }

  private async writeSyncManifest(manifest: AiResourceSyncManifestFile): Promise<void> {
    await fs.mkdir(this.sourceRoot, { recursive: true });
    const tmpPath = `${this.syncManifestPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest), "utf8");
    await fs.rename(tmpPath, this.syncManifestPath);
  }

  /**
   * workspaceIdが渡された場合、グローバル(workspaceId未設定)リソース + そのワークスペースIDに
   * 一致するリソースのみを対象にする。省略/nullの場合はグローバルリソースのみ(呼び出し元が
   * どのドキュメントのworkspaceIdか分からない場合のフォールバック)。
   *
   * skillのauto読み込み(instruction文言とのキーワード一致による自動注入)は廃止した。
   * 本文が確実に届く経路は always(グローバル/ワークスペース指示)と explicit(コンポーザーで
   * 明示的に選んだリソース)の2つだけにし、残りはCodex/Claude/Antigravityの
   * ネイティブskill探索(syncToRuntimeTargetsで投影したファイル)に委ねる。
   */
  async buildRunContext(
    provider: AiResourceProvider,
    explicitResourceIds: string[],
    workspaceId?: string | null,
  ): Promise<AiResourceRunContext> {
    const manifest = await this.readManifest();
    const explicit = new Set(explicitResourceIds);
    const scopedResources = manifest.resources.filter((resource) =>
      resource.enabled &&
      resource.providers.includes(provider) &&
      (resource.workspaceId == null || resource.workspaceId === workspaceId));
    const studioItems = await Promise.all(
      scopedResources.map(async (resource) => {
        const base: AiResourceContextItem = {
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          loadMode: resource.loadMode,
          description: resource.description,
          tags: resource.tags,
        };
        if (resource.loadMode === "always" || explicit.has(resource.id)) {
          return { ...base, content: await this.readResourceContent(resource).catch(() => "") };
        }
        return base;
      }),
    );
    const always = studioItems.filter((item) => item.loadMode === "always" && item.content);
    const explicitItems = studioItems.filter((item) => explicit.has(item.id) && item.loadMode !== "always" && item.content);

    return { provider, always, explicit: explicitItems };
  }

  getSourceRoot(): string {
    return this.sourceRoot;
  }

  /** workspaceId未解決のrun向けフォールバックの固定ルート(常にグローバルリソースのみ投影される)。 */
  getRuntimeRoot(provider: AiResourceProvider): string {
    if (provider === "codex") {
      return this.codexRuntimeRoot;
    }
    if (provider === "antigravity") {
      return this.geminiRuntimeRoot;
    }
    return this.claudeRuntimeRoot;
  }

  /**
   * このrunが実際にcwdとして使う絶対パス。workspaceIdが解決できているrunは
   * `agent-workspaces/<workspaceId>/<provider>`(グローバル∪当該ワークスペースのリソースが
   * 投影される)を、解決できないrunはgetRuntimeRoot()と同じ固定フォールバックルート
   * (常にグローバルリソースのみ)を返す。
   */
  getAgentWorkspaceDir(provider: AiResourceProvider, workspaceId: string | null): string {
    return safeJoin(this.dataDir, agentWorkspaceRootRelative(provider, workspaceId));
  }

  private async readManifest(): Promise<AiResourceManifestFile> {
    await this.ensureOfficialSkillsSeeded();
    return this.readManifestFile();
  }

  /**
   * グローバル指示と公式スキルの初期化は、同一プロセスで使うstoreインスタンスにつき一度だけ行う。
   * 同時に来た初回readは同じpromiseを待つため、固定manifest.json.tmpを奪い合わない。
   */
  private ensureOfficialSkillsSeeded(): Promise<void> {
    if (!this.officialSkillsSeedPromise) {
      this.officialSkillsSeedPromise = this.seedOfficialSkillsOnce().catch((error: unknown) => {
        this.officialSkillsSeedPromise = undefined;
        throw error;
      });
    }
    return this.officialSkillsSeedPromise;
  }

  /**
   * 旧世代のmanifest(hook/doc、旧ID codex-agents/claude-instructions)は normalizeManifest が
   * 読み込み時に捨てるため、既存インストールのアップグレード直後はグローバル指示が
   * 存在しない状態になる。初回read時の補完でそれを恒久的に修復する。
   */
  private async seedOfficialSkillsOnce(): Promise<void> {
    await fs.mkdir(path.join(this.sourceRoot, "instructions"), { recursive: true });
    // ユーザー編集欄(グローバル「AIへの指示」)は空でseedする。旧デフォルト文が担っていた
    // 基盤ルール(SigmaDoc JSONが正本・編集はMCP提案ツール経由・日本語応答など)は、
    // ユーザー非可視の組み込みプロンプト(SIGMA_DOC_AI_CONTEXT_PROMPT /
    // MCP_EDIT_TURN_HARD_RULES / MCP_EDIT_INVARIANT_GUIDANCE)側で全provider・毎runに届く。
    await writeIfMissing(path.join(this.sourceRoot, "instructions", "global.md"), "");
    const manifest = await this.readManifestFile();
    let changed = false;
    if (!manifest.resources.some((item) => item.id === GLOBAL_INSTRUCTIONS_ID)) {
      manifest.resources.unshift(normalizeEntry({ ...GLOBAL_INSTRUCTIONS_ENTRY, updatedAt: new Date().toISOString() }));
      changed = true;
    }
    if (await this.ensureOfficialSkills(manifest)) {
      changed = true;
    }
    if (changed) {
      await this.writeManifest(manifest);
    }
  }

  private async readManifestFile(): Promise<AiResourceManifestFile> {
    let manifest: AiResourceManifestFile;
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      manifest = normalizeManifest(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        manifest = { version: 1, resources: [] };
      } else {
        throw error;
      }
    }
    let manifestChanged = false;
    if (!manifest.resources.some((item) => item.id === GLOBAL_INSTRUCTIONS_ID)) {
      manifest.resources.unshift(normalizeEntry({ ...GLOBAL_INSTRUCTIONS_ENTRY, updatedAt: new Date().toISOString() }));
      manifestChanged = true;
    }
    // SKILL.mdのfrontmatterは各CLIが直接読む正本。旧manifestのdescriptionが空、または
    // 外部編集で不一致になった場合は、非空のファイル側descriptionをmanifest/UIへ反映する。
    // ただし公式スキルの説明は公式definitionを正本とし、bundle本文のfrontmatterでは上書きしない。
    for (let i = 0; i < manifest.resources.length; i += 1) {
      const resource = manifest.resources[i];
      if (resource.kind !== "skill" || resource.origin === "official") {
        continue;
      }
      try {
        const raw = await fs.readFile(this.resolveSourcePath(resource.sourcePath), "utf8");
        const description = parseSkillFile(raw).description?.trim();
        if (description && description !== resource.description) {
          manifest.resources[i] = normalizeEntry({ ...resource, description });
          manifestChanged = true;
        }
      } catch {
        // source欠損は従来どおりread/sync時に無視し、manifest一覧の取得自体は継続する。
      }
    }
    if (manifestChanged) {
      await this.writeManifest(manifest);
    }
    return manifest;
  }

  /**
   * 公式スキルはmanifestの origin + bundledHash でアプリ所有を判定する。現在の本文hashが
   * 前回bundledHashと一致する場合だけbundle更新で置き換える。直接またはUIで手編集された本文は
   * officialState:"modified" として残し、以後も上書きしない。enabledとユーザー編集済みの
   * title/descriptionは常に既存値を保つ。
   */
  private async ensureOfficialSkills(manifest: AiResourceManifestFile): Promise<boolean> {
    let changed = false;
    for (const { definition, content: bundledContent, hash: bundledHash } of await this.loadOfficialSkillBundles()) {
      const existingIndex = manifest.resources.findIndex((item) => item.id === definition.id);
      const officialPath = this.resolveSourcePath(definition.sourcePath);

      if (existingIndex < 0) {
        const pathClaimedByUser = manifest.resources.some((item) => item.sourcePath === definition.sourcePath);
        if (pathClaimedByUser || await fileExists(officialPath)) {
          // 所有権のない既存ファイルは、たとえ公式と同じpath/titleでも絶対に上書きしない。
          continue;
        }
        await fs.mkdir(path.dirname(officialPath), { recursive: true });
        await fs.writeFile(officialPath, bundledContent, "utf8");
        manifest.resources.push(normalizeEntry({
          ...definition,
          kind: "skill",
          enabled: true,
          providers: ALL_PROVIDERS,
          loadMode: "auto",
          workspaceId: null,
          origin: "official",
          bundledHash,
          bundledTitle: definition.title,
          bundledDescription: definition.description,
          officialState: "managed",
          updatedAt: new Date().toISOString(),
        }));
        changed = true;
        continue;
      }

      const existing = manifest.resources[existingIndex];
      if (existing.origin !== "official") {
        // namespaced idが手作業で先に使われていても、ユーザーエントリの所有権を奪わない。
        continue;
      }

      const sourcePath = existing.sourcePath || definition.sourcePath;
      const sourceFilePath = this.resolveSourcePath(sourcePath);
      const currentContent = await readTextIfExists(sourceFilePath);
      const currentHash = currentContent === null ? null : sha256(currentContent);
      const canRefresh = currentHash === null
        || currentHash === bundledHash
        || (typeof existing.bundledHash === "string" && currentHash === existing.bundledHash);
      let nextBundledHash = existing.bundledHash;
      let officialState: AiResourceOfficialState = "modified";

      if (canRefresh) {
        if (currentHash !== bundledHash) {
          await fs.mkdir(path.dirname(sourceFilePath), { recursive: true });
          await fs.writeFile(sourceFilePath, bundledContent, "utf8");
        }
        nextBundledHash = bundledHash;
        officialState = "managed";
      }

      const canRefreshTitle = existing.bundledTitle === undefined
        ? existing.title === definition.title
        : existing.title === existing.bundledTitle;
      const canRefreshDescription = existing.bundledDescription === undefined
        ? existing.description === definition.description
        : existing.description === existing.bundledDescription;

      const next = normalizeEntry({
        ...existing,
        kind: "skill",
        title: canRefreshTitle ? definition.title : existing.title,
        sourcePath,
        providers: ALL_PROVIDERS,
        loadMode: "auto",
        description: canRefreshDescription ? definition.description : existing.description,
        tags: definition.tags,
        workspaceId: null,
        origin: "official",
        bundledHash: nextBundledHash,
        bundledTitle: canRefreshTitle ? definition.title : existing.bundledTitle,
        bundledDescription: canRefreshDescription ? definition.description : existing.bundledDescription,
        officialState,
      });
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        manifest.resources[existingIndex] = { ...next, updatedAt: new Date().toISOString() };
        changed = true;
      }
    }
    return changed;
  }

  /** 同梱ファイルのreadとhash計算は初期化中の一度だけ行い、そのpromiseを共有する。 */
  private loadOfficialSkillBundles(): Promise<OfficialSkillBundle[]> {
    if (!this.officialSkillBundlesPromise) {
      this.officialSkillBundlesPromise = Promise.all(OFFICIAL_SKILL_DEFINITIONS.map(async (baseDefinition) => {
        const definition = {
          ...baseDefinition,
          ...this.officialSkillMetadataOverrides[baseDefinition.id],
        };
        const content = this.officialSkillContentOverrides[definition.id]
          ?? await fs.readFile(path.join(__dirname, "official-skills", definition.bundledPath), "utf8");
        return { definition, content, hash: sha256(content) };
      }));
    }
    return this.officialSkillBundlesPromise;
  }

  private async writeManifest(manifest: AiResourceManifestFile): Promise<void> {
    await fs.mkdir(this.sourceRoot, { recursive: true });
    const tmpPath = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(normalizeManifest(manifest), null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.manifestPath);
  }

  private resolveSourcePath(relativePath: string): string {
    return safeJoin(this.sourceRoot, relativePath);
  }

  private async readResourceContent(resource: AiResourceManifestEntry): Promise<string> {
    const filePath = this.resolveSourcePath(resource.sourcePath);
    const raw = await fs.readFile(filePath, "utf8");
    if (resource.kind !== "skill") {
      return raw;
    }
    // 旧バージョンでは空descriptionのSKILL.mdを作成できた。3社のネイティブskill探索は
    // descriptionを適用判断に使うため、読み込み・投影時にtitleをフォールバックとして補完し、
    // 正本側も一度だけ修復する。
    const normalized = normalizeSkillContent(resource, raw);
    if (normalized.content !== raw) {
      await fs.writeFile(filePath, normalized.content, "utf8");
    }
    return normalized.content;
  }
}

/**
 * 3プロバイダのネイティブローダーが必須とするname/descriptionを保証する。
 * UIから明示されたdescriptionを優先し、次に既存frontmatter、manifest、titleの順で補完する。
 * frontmatterの追加キーと本文はparse/composeのround-tripで保持する。
 */
function normalizeSkillContent(
  resource: AiResourceManifestEntry,
  raw: string,
  explicitDescription?: string,
): { content: string; description: string } {
  const parsed = parseSkillFile(raw);
  const sourceName = skillNameFromSourcePath(resource.sourcePath);
  const name = parsed.name?.trim() || sourceName || normalizeResourceName(resource.title) || "skill";
  const description = explicitDescription?.trim()
    || parsed.description?.trim()
    || resource.description.trim()
    || resource.title.trim()
    || name;
  if (parsed.name?.trim() === name && parsed.description?.trim() === description) {
    return { content: raw, description };
  }
  return {
    content: composeSkillFile({
      name,
      description,
      body: parsed.body,
      extraFrontmatterLines: parsed.extraFrontmatterLines,
    }),
    description,
  };
}

/**
 * skill名は全スコープ横断で一意にする(id `skill-<name>` の重複と、グローバル/ワークスペース
 * どちらのsourcePathパターンでもその名前が使われていないかの両方をチェックする)。投影先は
 * プロバイダごとにフラットな名前空間 (`.agents/skills/<name>/SKILL.md` 等) なので、
 * 同名のグローバルskillとワークスペースskillが同じ投影パスを取り合うことはできない。
 */
function uniqueSkillName(
  base: string,
  manifest: AiResourceManifestFile,
  workspaceId?: string,
): { name: string; id: string; sourcePath: string } {
  const sourcePathFor = (name: string) => workspaceId
    ? `skills/workspaces/${workspaceId}/${name}/SKILL.md`
    : `skills/${name}/SKILL.md`;
  const taken = (name: string) =>
    manifest.resources.some((item) => item.id === `skill-${name}` || skillNameFromSourcePath(item.sourcePath) === name);
  let candidate = base;
  let suffix = 1;
  while (taken(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return { name: candidate, id: `skill-${candidate}`, sourcePath: sourcePathFor(candidate) };
}

/**
 * このprovider×workspaceScope向けの実行ディレクトリ(agent-workspaces/<ws>/<provider> または
 * workspaceId未解決時のフォールバック固定ルート)の、dataDirからの相対パス。
 */
function agentWorkspaceRootRelative(provider: AiResourceProvider, workspaceId: string | null): string {
  if (workspaceId == null) {
    return PROVIDER_FALLBACK_ROOT_NAME[provider];
  }
  return `${AGENT_WORKSPACES_DIR_NAME}/${sanitizeWorkspaceIdSegment(workspaceId)}/${provider}`;
}

function sanitizeWorkspaceIdSegment(workspaceId: string): string {
  const trimmed = workspaceId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error(ta("desktop.resource.invalidWorkspaceId"));
  }
  return trimmed;
}

function syncTargetKey(provider: AiResourceProvider, workspaceId: string | null): string {
  return `${provider}::${workspaceId ?? "global"}`;
}

/**
 * runtimeTargetsはmanifestに永続化しない。(kind, sourcePath, workspaceId)から常にこの場で
 * 導出することで、投影先の命名規則を変えたいときにmanifestマイグレーションが要らなくなる。
 *
 * スコープ整合: リソースがグローバル(workspaceId未設定)か、投影対象のworkspaceIdと一致する
 * ときだけ投影先を返す(それ以外は undefined = 投影しない)。ワークスペーススキルは、そのまま
 * そのワークスペースの実行ディレクトリにだけ投影され、フォールバックディレクトリや他ワーク
 * スペースには決して投影されない。
 *
 * instructionはグローバル指示だけがCodex/AntigravityのAGENTS.mdまたはClaudeのCLAUDE.mdへ
 * 投影され、ワークスペース指示は常にプロンプト注入のみ(undefined、現状維持)。
 * skillはグローバル/ワークスペースいずれも全provider向けに投影する。
 */
function deriveRuntimeTarget(
  resource: Pick<AiResourceManifestEntry, "kind" | "id" | "sourcePath" | "workspaceId">,
  provider: AiResourceProvider,
  workspaceId: string | null,
): string | undefined {
  if (resource.workspaceId != null && resource.workspaceId !== workspaceId) {
    return undefined;
  }
  const root = agentWorkspaceRootRelative(provider, workspaceId);
  if (resource.kind === "instruction") {
    if (resource.id !== GLOBAL_INSTRUCTIONS_ID) {
      return undefined;
    }
    if (provider === "codex" || provider === "antigravity") {
      return `${root}/AGENTS.md`;
    }
    if (provider === "claude") {
      return `${root}/CLAUDE.md`;
    }
    return undefined;
  }
  const name = skillNameFromSourcePath(resource.sourcePath);
  if (!name) {
    return undefined;
  }
  if (provider === "claude") {
    return `${root}/.claude/skills/${name}/SKILL.md`;
  }
  return `${root}/.agents/skills/${name}/SKILL.md`;
}

const GLOBAL_SKILL_SOURCE_PATH_PATTERN = /^skills\/([^/]+)\/SKILL\.md$/;
const WORKSPACE_SKILL_SOURCE_PATH_PATTERN = /^skills\/workspaces\/([^/]+)\/([^/]+)\/SKILL\.md$/;

function skillNameFromSourcePath(sourcePath: string): string | null {
  const workspaceMatch = WORKSPACE_SKILL_SOURCE_PATH_PATTERN.exec(sourcePath);
  if (workspaceMatch) {
    return workspaceMatch[2];
  }
  const globalMatch = GLOBAL_SKILL_SOURCE_PATH_PATTERN.exec(sourcePath);
  return globalMatch ? globalMatch[1] : null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashFingerprints(fingerprints: ProviderTargetFingerprint[]): string {
  return sha256(JSON.stringify(fingerprints));
}

// 旧スキーマ (`{ providers: { <provider>: {hash, syncedAt} } }`) は、provider単位でしか
// フィンガープリントを持たなかった。新スキーマの `targets` はprovider×workspaceScope単位の
// 複合キーを使うため形が異なり、後方互換の変換は行わない(捨てて全再同期になるだけで良い —
// 次のsyncToRuntimeTargetsが全ターゲットを未フィンガープリント扱いで書き直す)。
function normalizeSyncManifest(value: unknown): AiResourceSyncManifestFile {
  if (!isRecord(value) || !isRecord(value.targets)) {
    return { version: 1, targets: {} };
  }
  const targets: AiResourceSyncManifestFile["targets"] = {};
  for (const [key, entry] of Object.entries(value.targets)) {
    if (isRecord(entry) && typeof entry.hash === "string" && typeof entry.syncedAt === "string") {
      targets[key] = { hash: entry.hash, syncedAt: entry.syncedAt };
    }
  }
  return { version: 1, targets };
}

// hook/docは概念ごと廃止したため、kindがskill/instruction以外のmanifestエントリ(旧hook/doc)
// と、廃止した固定instruction id(旧codex-agents/claude-instructions。新id: global-instructions)
// は読み込み時に静かに捨てる(後方互換のマイグレーションは行わない)。捨てた結果グローバル指示が
// 消える問題は readManifest 側の補完で回復する。
function normalizeManifest(value: unknown): AiResourceManifestFile {
  if (!isRecord(value)) {
    return { version: 1, resources: [] };
  }
  const resources = Array.isArray(value.resources)
    ? value.resources
        .filter((raw): raw is Record<string, unknown> =>
          isRecord(raw) &&
          (raw.kind === "skill" || raw.kind === "instruction") &&
          raw.id !== "codex-agents" &&
          raw.id !== "claude-instructions")
        .map(normalizeEntry)
    : [];
  return { version: 1, resources };
}

function normalizeEntry(value: unknown): AiResourceManifestEntry {
  const record = isRecord(value) ? value : {};
  const kind = record.kind === "skill" ? "skill" : "instruction";
  const sourcePath = typeof record.sourcePath === "string" ? normalizeRelativePath(record.sourcePath) : "";
  // 新規のStudio管理リソースは3社共通。一方、旧UIで明示された単一provider制限は
  // provider固有の前提を含み得るため保持し、既知の旧共有形(Codex+Claude)だけを3社へ移行する。
  const providers = normalizeProviders(record.providers);
  // skill・instructionとも同じ正規化: 非空文字列ならワークスペーススコープとして保持し、
  // それ以外(未設定/null/空文字)はグローバル(undefined)として扱う。
  const workspaceId = typeof record.workspaceId === "string" && record.workspaceId.trim()
    ? record.workspaceId.trim()
    : undefined;
  // eslint-disable-next-line no-restricted-syntax -- Persisted/model-facing compatibility fallback.
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "AIリソース";
  const rawDescription = typeof record.description === "string" ? record.description : "";
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `resource-${Date.now()}`,
    kind,
    title,
    sourcePath,
    enabled: record.enabled !== false,
    providers,
    loadMode: record.loadMode === "always" || record.loadMode === "auto" || record.loadMode === "manual" ? record.loadMode : "manual",
    description: kind === "skill" ? rawDescription.trim() || title : rawDescription,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [],
    workspaceId,
    origin: record.origin === "official" ? "official" : undefined,
    bundledHash: typeof record.bundledHash === "string" && record.bundledHash ? record.bundledHash : undefined,
    bundledTitle: typeof record.bundledTitle === "string" ? record.bundledTitle : undefined,
    bundledDescription: typeof record.bundledDescription === "string" ? record.bundledDescription : undefined,
    officialState: record.officialState === "managed" || record.officialState === "modified"
      ? record.officialState
      : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function normalizeProviders(value: unknown): AiResourceProvider[] {
  const providers = Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is AiResourceProvider =>
        item === "codex" || item === "claude" || item === "antigravity")))
    : [];
  if (providers.length === 0) {
    return ALL_PROVIDERS;
  }
  if (providers.includes("codex") && providers.includes("claude") && !providers.includes("antigravity")) {
    return ALL_PROVIDERS;
  }
  return providers;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    throw new Error(ta("desktop.resource.invalidPath"));
  }
  return normalized;
}

function normalizeResourceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isWithinRoot(rootAbs: string, candidate: string): boolean {
  return candidate === rootAbs || candidate.startsWith(`${rootAbs}${path.sep}`);
}

function safeJoin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, normalizeRelativePath(relativePath));
  const resolvedRoot = path.resolve(root);
  if (!isWithinRoot(resolvedRoot, resolved)) {
    throw new Error(ta("desktop.resource.invalidPath"));
  }
  return resolved;
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, "utf8");
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
