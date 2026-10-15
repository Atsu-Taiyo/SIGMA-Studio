import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExtensionMenuGroup, ExtensionMenuEntry } from "@/lib/extension-contracts";
import type { OfficialOrganization, OfficialPluginErrorCode, OfficialPluginRow, OfficialPluginStatus } from "@/lib/plugin-status-contracts";

import {
  compareVersions,
  digest,
  isId,
  isVersion,
  MAX_CATALOG_BYTES,
  PluginError,
  verifyCatalog,
  type Catalog,
  type CatalogEnvelope,
  type CatalogMenuSection,
  type CatalogPlugin,
  type ImportFileAction,
} from "./manifest";
import { loadOrganizationLogo } from "./organization-logo";
import { createWorkerRunner, type LocalFontBytes, type RunWorker, type WorkerContext } from "./worker-runner";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function atomicJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

interface InstalledItem {
  version: string;
  enabled: boolean;
  name?: string;
  description?: string;
}

interface ManagerState {
  autoUpdate: boolean;
  installed: Record<string, InstalledItem>;
  sequence: number;
  lastChecked: number;
}

interface AccessGrant {
  userId: string;
  plugins: string[];
  organizations: OfficialOrganization[];
}

export interface PluginManagerOptions {
  directory: string;
  appVersion: string;
  catalogUrl: string | undefined;
  publicKey: string | undefined;
  authorization: () => string | null | undefined | Promise<string | null | undefined>;
  signedIn: () => boolean;
  userId?: () => string | null;
  fetchImpl?: typeof fetch;
  allowLoopbackHttp?: boolean;
  /** ダウンロード済みの版を有効にする前後で、同梱のフォントなどを登録する。 */
  registerFonts?: (plugin: CatalogPlugin, directory: string) => Promise<void>;
  runWorker?: RunWorker;
  loadLocalFonts?: (families: string[], context: WorkerContext) => Promise<LocalFontBytes[]>;
  now?: () => number;
}

/**
 * 公式プラグイン (拡張機能) の取得・検証・有効化・更新と、メニューの元データの管理。
 *
 * 信頼の根は2つだけ: ビルドに固定された公開鍵で検証できるカタログと、本人のログインで決まる権限。
 * カタログに載ったファイルはバイト数とSHA-256が一致したときだけ置き、版ごとに別の場所へ残す。
 * 動いている処理は開始時の版に固定し、更新はその処理が終わるまで待つ。権限が外れたら新しい処理は始めない。
 */
export class PluginManager extends EventEmitter {
  readonly directory: string;
  readonly appVersion: string;
  readonly publicKey: string | undefined;
  readonly catalogUrl: string | null = null;
  baseUrl = "";
  state: ManagerState = { autoUpdate: true, installed: {}, sequence: 0, lastChecked: 0 };
  access: AccessGrant | null = null;
  fetchImpl: typeof fetch;
  idleWaiters: Array<() => void> = [];
  private readonly authorization: PluginManagerOptions["authorization"];
  private readonly signedIn: () => boolean;
  private readonly currentUserId: () => string | null;
  private readonly registerFonts: NonNullable<PluginManagerOptions["registerFonts"]>;
  private readonly runWorker: RunWorker;
  private readonly now: () => number;
  private catalog: Catalog | null = null;
  private envelope: CatalogEnvelope | null = null;
  private phase: "idle" | "checking" | "installing" = "idle";
  private error: OfficialPluginErrorCode | undefined;
  private jobs = 0;
  private activating = false;
  private pendingAccess: Promise<AccessGrant> | null = null;
  private pendingCheck: Promise<OfficialPluginStatus> | null = null;
  private pendingInstall: Promise<OfficialPluginStatus> | null = null;
  private readonly logoCache = new Map<string, { data: string | null; expires: number }>();
  private logoOwner: string | null = null;
  /** インストール済みの版について、署名検証を通ったメニューの定義。 */
  private readonly menus = new Map<string, { name: string; sections: CatalogMenuSection[] }>();
  /** 同梱フォントの内容ハッシュから、それを配った拡張機能を引く。見つからないフォントは出さない。 */
  private readonly fontOwners = new Map<string, string>();

  constructor({ directory, appVersion, catalogUrl, publicKey, authorization, signedIn, fetchImpl = fetch,
    allowLoopbackHttp = false, registerFonts = async () => {}, runWorker, loadLocalFonts, userId = () => null, now = Date.now }: PluginManagerOptions) {
    super();
    if (!isVersion(appVersion)) throw new Error("INVALID_APP_VERSION");
    this.directory = directory;
    this.appVersion = appVersion;
    this.publicKey = publicKey;
    this.authorization = authorization;
    this.signedIn = signedIn;
    this.fetchImpl = fetchImpl;
    this.registerFonts = registerFonts;
    this.runWorker = runWorker ?? createWorkerRunner({ loadLocalFonts });
    this.currentUserId = userId;
    this.now = now;
    try {
      const url = new URL(catalogUrl ?? "");
      if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/catalog")
        || (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error();
      this.catalogUrl = url.href;
      this.baseUrl = url.href.slice(0, -"catalog".length);
    } catch {
      this.catalogUrl = null;
    }
  }

  async initialize(): Promise<OfficialPluginStatus> {
    const filename = path.join(this.directory, "state.json");
    try {
      const state = JSON.parse(await fs.readFile(filename, "utf8")) as ManagerState;
      if (typeof state.autoUpdate === "boolean" && Number.isSafeInteger(state.sequence) && state.sequence >= 0
        && typeof state.lastChecked === "number" && state.installed && Object.keys(state.installed).length <= 32
        && Object.entries(state.installed).every(([id, item]) => isId(id) && isVersion(item.version) && typeof item.enabled === "boolean")) this.state = state;
    } catch { /* 状態が無ければ新規のインストール。 */ }
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(this.directory, "catalog.json"), "utf8")) as CatalogEnvelope;
      const catalog = verifyCatalog(envelope, this.publicKey ?? "");
      if (catalog.sequence >= this.state.sequence) {
        this.catalog = catalog;
        this.envelope = envelope;
        this.state.sequence = catalog.sequence;
      }
    } catch { /* 検証できなかった情報は有効にしない。 */ }
    await this.refreshAccess().catch(() => {});
    for (const id of Object.keys(this.state.installed)) {
      try {
        const plugin = await this.installedPlugin(id);
        this.remember(plugin);
        if (this.hasAccess(id)) await this.registerFonts(plugin, this.versionDir(plugin));
      } catch {
        this.error = "verification-failed";
      }
    }
    return this.status();
  }

  versionDir(plugin: Pick<CatalogPlugin, "id" | "version">): string {
    return path.join(this.directory, plugin.id, plugin.version);
  }

  private async persist(): Promise<void> {
    await atomicJson(path.join(this.directory, "state.json"), this.state);
  }

  private remember(plugin: CatalogPlugin): void {
    const sections = plugin.contributes?.menu?.sections;
    if (sections?.length) this.menus.set(plugin.id, { name: plugin.name, sections });
    else this.menus.delete(plugin.id);
    for (const file of plugin.files) if (file.kind === "font") this.fontOwners.set(file.sha256, plugin.id);
  }

  /** 同梱フォントを今の本人が使ってよいか。配った拡張機能が有効で、権限があるときだけ。 */
  isFontVisible(sha256: string): boolean {
    const owner = this.fontOwners.get(sha256);
    return Boolean(owner && this.state.installed[owner]?.enabled && this.hasAccess(owner));
  }

  status(): OfficialPluginStatus {
    const rows = new Map<string, OfficialPluginRow>((this.catalog?.plugins ?? []).filter((plugin) => this.hasAccess(plugin.id)).map((plugin) => [plugin.id, {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      latestVersion: plugin.version,
      enabled: this.state.installed[plugin.id]?.enabled ?? false,
      installedVersion: this.state.installed[plugin.id]?.version,
      compatible: compareVersions(this.appVersion, plugin.minAppVersion) >= 0,
      authorized: this.hasAccess(plugin.id),
      fonts: plugin.files.filter((file) => file.kind === "font").map((file) => file.displayName as string)
        .filter((name, index, names) => names.indexOf(name) === index),
    }]));
    for (const [id, item] of Object.entries(this.state.installed)) {
      if (!rows.has(id) && this.hasAccess(id)) {
        rows.set(id, {
          id,
          name: item.name ?? id,
          description: item.description ?? "",
          enabled: item.enabled,
          installedVersion: item.version,
          compatible: true,
          authorized: this.hasAccess(id),
        });
      }
    }
    const signedIn = this.signedIn();
    return {
      available: Boolean(this.catalogUrl && this.publicKey),
      requiresLogin: !signedIn,
      requiresRole: signedIn && !this.access?.plugins.length,
      organizations: signedIn && this.access?.userId === this.currentUserId() ? this.access?.organizations ?? [] : [],
      autoUpdate: this.state.autoUpdate,
      phase: this.phase,
      plugins: [...rows.values()],
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** メニューに出せる拡張機能: インストール済み・有効・今この本人に権限がある。 */
  menuGroups(): ExtensionMenuGroup[] {
    const groups: ExtensionMenuGroup[] = [];
    for (const [id, menu] of this.menus) {
      if (!this.state.installed[id]?.enabled || !this.hasAccess(id)) continue;
      groups.push({
        extensionId: id,
        name: menu.name,
        sections: menu.sections.map((section) => ({
          ...(section.title ? { title: section.title } : {}),
          entries: section.items.map((item): ExtensionMenuEntry => {
            if (item.type !== "button") return item;
            return {
              type: "button",
              id: item.id,
              label: item.label,
              ...(item.description ? { description: item.description } : {}),
              ...(item.icon ? { icon: item.icon } : {}),
            };
          }),
        })),
      });
    }
    return groups;
  }

  /** ボタンの action を、検証済みのカタログから引く。描画側が送る値は id だけで、中身は信用しない。 */
  resolveAction(id: string, itemId: string): ImportFileAction | null {
    const menu = this.menus.get(id);
    if (!menu || !this.state.installed[id]?.enabled || !this.hasAccess(id)) return null;
    for (const section of menu.sections) {
      for (const item of section.items) {
        if (item.type === "button" && item.id === itemId) return item.action;
      }
    }
    return null;
  }

  /** 今ログインしている本人の id。切り替わりの検知に使う。 */
  currentActor(): string | null {
    return this.currentUserId();
  }

  /** 本人が変わったとき、前の本人の権限・所属・ロゴを捨てて、表示を更新する。 */
  resetIdentity(): void {
    this.access = null;
    this.logoCache.clear();
    this.publish();
  }

  publish(): OfficialPluginStatus {
    const status = this.status();
    this.emit("change", status);
    return status;
  }

  private async bytes(url: string, maxBytes: number, token: string): Promise<Buffer> {
    const response = await this.fetchImpl(url, { headers: { Authorization: token }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new PluginError(response.status === 401 ? "unauthorized" : "forbidden");
    }
    if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== new URL(this.catalogUrl as string).origin)
      || Number(response.headers.get("content-length")) > maxBytes || !response.body) {
      await response.body?.cancel();
      throw new PluginError("unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new PluginError("verification-failed");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  private async token(): Promise<string> {
    if (!this.signedIn()) throw new PluginError("unauthorized");
    let token: string | null | undefined;
    try {
      token = await this.authorization();
    } catch {
      throw new PluginError("unauthorized");
    }
    if (typeof token !== "string" || !/^Bearer [A-Za-z0-9_.-]+$/.test(token)) throw new PluginError("unauthorized");
    return token;
  }

  hasAccess(id: string): boolean {
    return Boolean(this.signedIn() && this.access?.userId === this.currentUserId() && this.access?.plugins.includes(id));
  }

  /** 本人にどれかの拡張機能の権限があるか。 */
  private hasAnyAccess(): boolean {
    return Boolean(this.signedIn() && this.access?.userId === this.currentUserId() && this.access?.plugins.length);
  }

  async refreshAccess(): Promise<AccessGrant> {
    if (this.pendingAccess) return this.pendingAccess;
    this.pendingAccess = this.refreshAccessInner();
    try {
      return await this.pendingAccess;
    } finally {
      this.pendingAccess = null;
    }
  }

  private async refreshAccessInner(): Promise<AccessGrant> {
    const previous = JSON.stringify({ menu: this.menuGroups(), access: this.access });
    const userId = this.currentUserId();
    try {
      if (!this.catalogUrl || !userId) throw new PluginError("unauthorized");
      const raw = await this.bytes(`${this.baseUrl}access`, MAX_CATALOG_BYTES, await this.token());
      const access = JSON.parse(raw.toString("utf8")) as { userId?: string; plugins?: unknown; organizations?: unknown };
      if (access.userId !== userId || this.currentUserId() !== userId || !this.signedIn()
        || !Array.isArray(access.plugins) || access.plugins.length > 32 || !access.plugins.every(isId)) throw new PluginError("forbidden");
      const rawGroups = (access.organizations ?? []) as Array<{ id: string; name: string; logoPath?: string | null }>;
      if (!Array.isArray(rawGroups) || rawGroups.length > 256 || !rawGroups.every((group) => group
        && UUID.test(group.id)
        && typeof group.name === "string" && group.name.trim() && group.name.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(group.name)
        && (group.logoPath == null || (typeof group.logoPath === "string" && group.logoPath.startsWith(`${group.id}/`)
          && /^[a-f0-9-]{36}\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(group.logoPath))))) throw new PluginError("forbidden");
      if (this.logoOwner !== userId) {
        this.logoCache.clear();
        this.logoOwner = userId;
      }
      const organizations: OfficialOrganization[] = [];
      let loads = 0;
      let size = 0;
      for (const group of rawGroups) {
        let logoUrl: string | null = null;
        if (group.logoPath) {
          let cached = this.logoCache.get(group.logoPath);
          if ((!cached || cached.expires <= this.now()) && loads < 4 && size < 2 * 1024 * 1024) {
            loads += 1;
            try {
              cached = {
                data: await loadOrganizationLogo({ origin: new URL(this.catalogUrl).origin, path: group.logoPath, authorization: await this.token(), fetchImpl: this.fetchImpl }),
                expires: Infinity,
              };
            } catch {
              cached = { data: null, expires: this.now() + 60_000 };
            }
            this.logoCache.set(group.logoPath, cached);
          }
          if (cached?.data && size + cached.data.length <= 2 * 1024 * 1024) {
            logoUrl = cached.data;
            size += logoUrl.length;
          }
        }
        organizations.push({ id: group.id, name: group.name, logoUrl });
      }
      const visiblePaths = new Set(rawGroups.map((group) => group.logoPath));
      for (const key of this.logoCache.keys()) if (!visiblePaths.has(key)) this.logoCache.delete(key);
      if (this.currentUserId() !== userId || !this.signedIn()) throw new PluginError("forbidden");
      this.access = { userId, plugins: [...new Set(access.plugins as string[])], organizations };
      if (this.hasAnyAccess() && (this.error === "unauthorized" || this.error === "forbidden")) this.error = undefined;
      return this.access;
    } catch (error) {
      this.access = null;
      throw error instanceof PluginError ? error : new PluginError("unavailable");
    } finally {
      if (previous !== JSON.stringify({ menu: this.menuGroups(), access: this.access })) this.publish();
    }
  }

  private async requireAccess(id: string): Promise<void> {
    await this.refreshAccess();
    if (!this.hasAccess(id)) throw new PluginError("forbidden");
  }

  private async requireAnyAccess(): Promise<void> {
    await this.refreshAccess();
    if (!this.hasAnyAccess()) throw new PluginError("forbidden");
  }

  async check(): Promise<OfficialPluginStatus> {
    if (this.pendingInstall) {
      this.error = "busy";
      return this.publish();
    }
    if (this.pendingCheck) return this.pendingCheck;
    this.pendingCheck = this.checkInner();
    try {
      return await this.pendingCheck;
    } finally {
      this.pendingCheck = null;
    }
  }

  private async checkInner(): Promise<OfficialPluginStatus> {
    this.phase = "checking";
    this.error = undefined;
    this.publish();
    try {
      if (!this.catalogUrl) throw new PluginError("unavailable");
      await this.requireAnyAccess();
      const raw = await this.bytes(this.catalogUrl, MAX_CATALOG_BYTES, await this.token());
      const envelope = JSON.parse(raw.toString("utf8")) as CatalogEnvelope;
      const catalog = verifyCatalog(envelope, this.publicKey ?? "");
      if (catalog.sequence < this.state.sequence) throw new PluginError("verification-failed");
      await atomicJson(path.join(this.directory, "catalog.json"), envelope);
      this.catalog = catalog;
      this.envelope = envelope;
      this.state.sequence = catalog.sequence;
      this.state.lastChecked = this.now();
      await this.persist();
    } catch (error) {
      this.error = errorCode(error);
    } finally {
      this.phase = "idle";
    }
    return this.publish();
  }

  async install(id: string): Promise<OfficialPluginStatus> {
    if (!isId(id)) {
      this.error = "verification-failed";
      return this.publish();
    }
    if (this.pendingInstall || this.pendingCheck) {
      this.error = "busy";
      return this.publish();
    }
    this.pendingInstall = this.installInner(id);
    try {
      return await this.pendingInstall;
    } finally {
      this.pendingInstall = null;
    }
  }

  private async installInner(id: string): Promise<OfficialPluginStatus> {
    this.phase = "installing";
    this.error = undefined;
    this.publish();
    let stage: string | null = null;
    try {
      const plugin = this.catalog?.plugins.find((candidate) => candidate.id === id);
      if (!plugin) throw new PluginError("unavailable");
      await this.requireAccess(id);
      if (compareVersions(this.appVersion, plugin.minAppVersion) < 0) throw new PluginError("incompatible");
      const installed = this.state.installed[id];
      if (installed && compareVersions(plugin.version, installed.version) < 0) throw new PluginError("verification-failed");
      stage = path.join(this.directory, `.staging-${randomUUID()}`);
      await fs.mkdir(stage, { recursive: true, mode: 0o700 });
      for (const file of plugin.files) {
        const key = `${plugin.id}/${plugin.version}/${file.path}`;
        const bytes = await this.bytes(`${this.baseUrl}assets/${key}`, file.bytes, await this.token());
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new PluginError("verification-failed");
        const target = path.join(stage, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      }
      await atomicJson(path.join(stage, "manifest.json"), this.envelope);
      const destination = this.versionDir(plugin);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await fs.rename(stage, destination);
        stage = null;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await this.verifyFiles(plugin, destination);
      }
      // 動いている処理は開始時の版に固定されている。有効にするのは、既存の処理が終わってから。
      this.activating = true;
      if (this.jobs) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      // ダウンロード中や待機中に権限が外れていないかを、有効にする直前にもう一度見る。
      await this.requireAccess(id);
      await this.registerFonts(plugin, destination);
      await this.requireAccess(id);
      const previous = this.state.installed[id];
      this.state.installed[id] = { version: plugin.version, enabled: previous?.enabled ?? true, name: plugin.name, description: plugin.description };
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.state.installed[id] = previous;
        else delete this.state.installed[id];
        throw error;
      }
      this.remember(plugin);
      this.error = undefined;
    } catch (error) {
      this.error = errorCode(error);
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true });
      this.activating = false;
      this.phase = "idle";
    }
    return this.publish();
  }

  async setAutoUpdate(enabled: boolean): Promise<OfficialPluginStatus> {
    if (typeof enabled !== "boolean") throw new PluginError("verification-failed");
    const previous = this.state.autoUpdate;
    this.state.autoUpdate = enabled;
    try {
      await this.persist();
    } catch (error) {
      this.state.autoUpdate = previous;
      throw error;
    }
    return this.publish();
  }

  async setEnabled(id: string, enabled: boolean): Promise<OfficialPluginStatus> {
    if (!isId(id) || typeof enabled !== "boolean" || !this.state.installed[id]) throw new PluginError("unavailable");
    if (this.pendingInstall) {
      this.error = "busy";
      return this.publish();
    }
    if (enabled) await this.requireAccess(id);
    const previous = this.state.installed[id].enabled;
    this.state.installed[id].enabled = enabled;
    try {
      await this.persist();
    } catch (error) {
      this.state.installed[id].enabled = previous;
      throw error;
    }
    this.error = undefined;
    return this.publish();
  }

  async refreshAutomatically(): Promise<OfficialPluginStatus> {
    if (this.pendingCheck || this.pendingInstall || this.now() - this.state.lastChecked < DAY_MS || !this.signedIn()) return this.status();
    const result = await this.check();
    if (result.error || !this.state.autoUpdate) return result;
    for (const plugin of this.catalog?.plugins ?? []) {
      const item = this.state.installed[plugin.id];
      if (item?.enabled && compareVersions(plugin.version, item.version) > 0 && compareVersions(this.appVersion, plugin.minAppVersion) >= 0) {
        const installed = await this.install(plugin.id);
        if (installed.error) return installed;
      }
    }
    return this.status();
  }

  private async verifyFiles(plugin: CatalogPlugin, directory: string): Promise<void> {
    for (const file of plugin.files) {
      const filename = path.join(directory, file.path);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size !== file.bytes || digest(await fs.readFile(filename)) !== file.sha256) throw new PluginError("verification-failed");
    }
  }

  /** ディスク上の版をもう一度検証する。署名・最低バージョン・全ファイルのハッシュを見る。 */
  async installedPlugin(id: string): Promise<CatalogPlugin> {
    const item = this.state.installed[id];
    if (!item) throw new PluginError("unavailable");
    const directory = path.join(this.directory, id, item.version);
    const envelope = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as CatalogEnvelope;
    const catalog = verifyCatalog(envelope, this.publicKey ?? "");
    const plugin = catalog.plugins.find((candidate) => candidate.id === id && candidate.version === item.version);
    if (!plugin || compareVersions(this.appVersion, plugin.minAppVersion) < 0) throw new PluginError("verification-failed");
    await this.verifyFiles(plugin, directory);
    return plugin;
  }

  /**
   * 拡張機能のワーカーを1回動かす。権限は始める直前にもう一度確かめ、
   * 同時に動かすのは1つだけ。更新の有効化中も始めない。
   */
  async run(id: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.jobs || this.activating || !this.state.installed[id]?.enabled) throw new PluginError(this.jobs || this.activating ? "busy" : "unavailable");
    this.jobs += 1;
    try {
      await this.requireAccess(id);
      const plugin = await this.installedPlugin(id);
      const directory = this.versionDir(plugin);
      return await this.runWorker(path.join(directory, plugin.entry), {
        ...payload,
        fonts: plugin.files.filter((file) => file.kind === "font").map((file) => ({
          path: path.join(directory, file.path),
          family: file.family,
          portable: file.portable,
          complete: file.complete === true,
        })),
      }, {
        bundledFamilies: new Set(plugin.files.flatMap((file) => (file.kind === "font" && file.family ? [file.family] : []))),
        ownFamilyPrefixes: plugin.ownFontFamilyPrefixes ?? [],
      });
    } finally {
      this.jobs -= 1;
      if (!this.jobs) for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}

function errorCode(error: unknown): OfficialPluginErrorCode {
  const code = error instanceof PluginError ? error.code : "unavailable";
  // 描画側の状態に出す種類だけを通す。それ以外は取得できなかったものとして扱う。
  return (["unavailable", "unauthorized", "forbidden", "incompatible", "verification-failed", "busy"] as const).includes(code as never)
    ? code as OfficialPluginErrorCode
    : "unavailable";
}
