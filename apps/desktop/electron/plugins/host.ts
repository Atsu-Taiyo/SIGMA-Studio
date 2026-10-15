import fs from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";

import { documentFontReferences } from "@/features/document";
import type { ExtensionImportIssue, ExtensionRunError, ExtensionRunResult } from "@/lib/extension-contracts";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";

import type { ApplicationFontStore } from "../application-font-store";
import { readDesktopSettingsSync, writeDesktopSettings, type DesktopCustomFont } from "../desktop-settings";
import { LocalFontReader } from "./local-fonts";
import { PluginManager } from "./manager";
import type { CatalogFile, CatalogPlugin } from "./manifest";
import { PluginError } from "./manifest";

/** ワーカーに渡せる取り込み元ファイルの上限。 */
export const IMPORT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ISSUES = 10_000;
const MAX_ISSUE_CODE_LENGTH = 64;
const MAX_ISSUE_DETAIL_LENGTH = 4_096;
const MAX_LOCAL_FONT_RESOURCES = 32;
const MAX_FILENAME_BYTES = 255;

export interface PluginConfig {
  catalogUrl?: string;
  publicKey?: string;
}

export interface PluginAuth {
  user(): { id?: string } | null | unknown;
  authorization(): Promise<string>;
}

export interface PluginHostOptions {
  dataDir: string;
  appVersion: string;
  isPackaged: boolean;
  config: PluginConfig | null;
  auth: PluginAuth | null;
  fontStore: ApplicationFontStore | undefined;
  getMainContents: () => WebContents | null;
  /** 部分的な文字しか持たない書体につける注記。表示言語に合わせた文言を呼び出し側が渡す。 */
  partialFontNote: () => string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** 開発・テスト用の差し替え。配布版 (isPackaged) では無視する。 */
export function resolvePluginConfig(config: PluginConfig | null, isPackaged: boolean, env: Record<string, string | undefined>): { config: PluginConfig | null; allowLoopbackHttp: boolean } {
  if (isPackaged) return { config, allowLoopbackHttp: false };
  const catalogUrl = env.SIGMA_EXTENSIONS_CATALOG_URL?.trim();
  const publicKey = env.SIGMA_EXTENSIONS_PUBLIC_KEY?.replace(/\\n/g, "\n").trim();
  if (catalogUrl && publicKey) return { config: { catalogUrl, publicKey }, allowLoopbackHttp: true };
  return { config, allowLoopbackHttp: true };
}

/** 編集用に出す書体: 同じ表示名のうち、文字が揃っているものを優先し、同順なら大きいものを選ぶ。 */
export function selectEditingFonts(files: CatalogFile[]): CatalogFile[] {
  const selected = new Map<string, CatalogFile>();
  for (const file of files.filter((candidate) => candidate.kind === "font")) {
    const key = file.displayName as string;
    const previous = selected.get(key);
    if (!previous || (file.complete === true && previous.complete !== true)
      || (Boolean(file.complete) === Boolean(previous.complete) && file.bytes > previous.bytes)) selected.set(key, file);
  }
  return [...selected.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 拡張機能ホスト。マネージャ・ワーカー・書体の登録・取り込みの実行を、アプリの保存先と本人のログインへつなぐ。
 * 製品や拡張機能の名前は一切持たない。何をメニューに出し、どんなファイルを受けるかは、署名付きカタログのデータだけで決まる。
 */
export class PluginHost {
  readonly manager: PluginManager;
  readonly ready: Promise<unknown>;
  private readonly localFonts: LocalFontReader;

  constructor(private readonly options: PluginHostOptions) {
    const { config, allowLoopbackHttp } = resolvePluginConfig(options.config, options.isPackaged, options.env ?? process.env);
    this.localFonts = new LocalFontReader(options.getMainContents);
    const readUserId = (): string | null => {
      const user = options.auth?.user();
      return isRecord(user) && typeof user.id === "string" ? user.id : null;
    };
    this.manager = new PluginManager({
      directory: path.join(options.dataDir, "plugins"),
      appVersion: options.appVersion,
      catalogUrl: config?.catalogUrl,
      publicKey: config?.publicKey,
      allowLoopbackHttp,
      fetchImpl: options.fetchImpl,
      authorization: () => options.auth?.authorization(),
      signedIn: () => Boolean(options.auth?.user()),
      userId: readUserId,
      loadLocalFonts: (families, context) => this.localFonts.readFamilies(families, context.bundledFamilies, context.ownFamilyPrefixes),
      registerFonts: (plugin, directory) => this.registerFonts(plugin, directory),
    });
    this.ready = this.manager.initialize().catch(() => undefined);
  }

  /** 同梱フォントを、内容ハッシュの資源として登録し、エディタの書体一覧に載せる。古い版の書体は既存の教材のために残す。 */
  private async registerFonts(plugin: CatalogPlugin, directory: string): Promise<void> {
    const { dataDir, fontStore } = this.options;
    for (const file of plugin.files.filter((candidate) => candidate.kind === "font")) {
      const bytes = await fs.readFile(path.join(directory, file.path));
      await fontStore?.ensure(file.sha256, async () => bytes);
    }
    const fontsDir = path.join(dataDir, "fonts");
    await fs.mkdir(fontsDir, { recursive: true });
    const resources = new Map(plugin.files.filter((file) => file.kind === "font").map((file) => [`plugin-${file.sha256}`, file]));
    const displayName = (file: CatalogFile): string => `${file.displayName}${file.complete === false ? this.options.partialFontNote() : ""}`;
    const settings = readDesktopSettingsSync(dataDir);
    const fonts: DesktopCustomFont[] = (settings.customFonts ?? []).map((font) => {
      const resource = resources.get(font.id);
      return resource ? { ...font, displayName: displayName(resource) } : font;
    });
    for (const file of selectEditingFonts(plugin.files)) {
      const id = `plugin-${file.sha256}`;
      const fileName = `${id}.ttf`;
      await fs.copyFile(path.join(directory, file.path), path.join(fontsDir, fileName));
      if (!fonts.some((font) => font.id === id)) {
        fonts.push({ id, fileName, displayName: displayName(file), cssFamily: `"Sigma Plugin Font ${file.sha256}"`, importedAt: new Date().toISOString() });
      }
    }
    // 設定の書き込みは現在の設定とマージされるので、AIやユーザーの設定は残る。
    await writeDesktopSettings(dataDir, { customFonts: fonts });
  }

  /** 書体一覧に出してよいか。配布された書体は、配った拡張機能が有効で権限があるときだけ。 */
  isFontVisible(font: Pick<DesktopCustomFont, "id">): boolean {
    return !font.id.startsWith("plugin-") || this.manager.isFontVisible(font.id.slice("plugin-".length));
  }

  /**
   * メニューの項目を実行する: ファイルを選ばせ、拡張機能のワーカーに渡し、返った教材を検証して返す。
   * 受け取る値は拡張機能と項目の id だけ。何をするか (action) は検証済みのカタログから引く。
   */
  async runItem(extensionId: unknown, itemId: unknown, pickFile: (extensions: string[]) => Promise<{ filePath: string; bytes: Uint8Array } | null>): Promise<ExtensionRunResult> {
    if (typeof extensionId !== "string" || typeof itemId !== "string") return { ok: false, error: "invalid-input" };
    await this.ready;
    const action = this.manager.resolveAction(extensionId, itemId);
    if (!action) return { ok: false, error: "unavailable" };
    let picked: { filePath: string; bytes: Uint8Array } | null;
    try {
      picked = await pickFile(action.extensions);
    } catch {
      return { ok: false, error: "invalid-input" };
    }
    if (!picked) return { ok: false, error: "canceled" };
    const filename = path.basename(picked.filePath);
    const extension = path.extname(filename).toLowerCase();
    if (!picked.bytes.byteLength || picked.bytes.byteLength > IMPORT_MAX_INPUT_BYTES
      || Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES || /[\u0000-\u001f\u007f]/u.test(filename)
      || !action.extensions.some((candidate) => candidate.toLowerCase() === extension)) return { ok: false, error: "invalid-input" };
    try {
      const raw = await this.manager.run(extensionId, {
        command: action.command,
        bytes: Uint8Array.from(picked.bytes).buffer,
        filename,
      });
      return await this.acceptResult(raw, filename);
    } catch (error) {
      return { ok: false, error: runError(error) };
    }
  }

  private async acceptResult(raw: unknown, sourceName: string): Promise<ExtensionRunResult> {
    if (!isRecord(raw) || !Array.isArray(raw.issues) || raw.issues.length > MAX_ISSUES || !raw.issues.every((issue) =>
      isRecord(issue) && typeof issue.code === "string" && issue.code.length > 0 && issue.code.length <= MAX_ISSUE_CODE_LENGTH
      && typeof issue.detail === "string" && issue.detail.length <= MAX_ISSUE_DETAIL_LENGTH)) return { ok: false, error: "import-failed" };
    const parsed = SigmaDocumentSchema.safeParse(raw.document);
    if (!parsed.success) return { ok: false, error: "import-failed" };
    const snapshot = parsed.data.pageLayout?.overlay?.overlaySnapshot;
    const references = documentFontReferences(snapshot);
    const declared = snapshot?.extensions?.["sigma.font-references"];
    if (declared !== undefined && (!Array.isArray(declared) || declared.length !== references.length)) return { ok: false, error: "import-failed" };
    const resources = raw.localFontResources ?? [];
    if (!Array.isArray(resources) || resources.length > MAX_LOCAL_FONT_RESOURCES) return { ok: false, error: "import-failed" };
    for (const resource of resources) {
      if (!isRecord(resource) || typeof resource.resourceId !== "string" || !(resource.bytes instanceof Uint8Array) || !this.options.fontStore) {
        return { ok: false, error: "import-failed" };
      }
      const bytes = resource.bytes;
      await this.options.fontStore.ensure(resource.resourceId, async () => bytes);
    }
    const issues: ExtensionImportIssue[] = (raw.issues as Array<{ code: string; detail: string }>).map(({ code, detail }) => ({ code, detail }));
    return { ok: true, document: parsed.data, issues, sourceName };
  }
}

function runError(error: unknown): ExtensionRunError {
  if (error instanceof PluginError) {
    const code = error.code;
    if (code === "incompatible" || code === "verification-failed") return "unavailable";
    return code;
  }
  return "import-failed";
}
