import { createHash, verify } from "node:crypto";

import { EXTENSION_ICON_NAMES, EXTENSION_MENU_LIMITS, type ExtensionIconName } from "@/lib/extension-contracts";

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 1024;
export const MAX_CATALOG_BYTES = 1024 * 1024;

/** ホストが返すエラーの種類。描画側の文言や再試行の判断はこの値で決まる。 */
export type PluginErrorCode =
  | "unavailable"
  | "unauthorized"
  | "forbidden"
  | "incompatible"
  | "verification-failed"
  | "busy"
  | "timeout"
  | "import-failed";

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode) {
    super(code);
    this.code = code;
  }
}

/** 取り込み用の action。ファイルを選ばせ、中身を拡張機能のワーカーへ渡し、返った教材を別の教材として開く。 */
export interface ImportFileAction {
  type: "import-file";
  command: string;
  extensions: string[];
}

export type CatalogMenuItem =
  | { type: "button"; id: string; label: string; description?: string; icon?: ExtensionIconName; action: ImportFileAction }
  | { type: "text"; text: string }
  | { type: "separator" };

export interface CatalogMenuSection {
  title?: string;
  items: CatalogMenuItem[];
}

export interface CatalogFile {
  path: string;
  kind: "code" | "font";
  sha256: string;
  bytes: number;
  family?: string;
  displayName?: string;
  portable?: boolean;
  complete?: boolean;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  minAppVersion: string;
  entry: "worker.cjs";
  capabilities: string[];
  files: CatalogFile[];
  contributes?: { menu?: { sections: CatalogMenuSection[] } };
  /** この拡張機能が自分で持っている書体の系統名の頭 (例: 製品の書体ファミリー名の前半)。この系統の書体は、このPCから読まない。 */
  ownFontFamilyPrefixes?: string[];
}

export interface Catalog {
  schema: 1;
  sequence: number;
  plugins: CatalogPlugin[];
}

export interface CatalogEnvelope {
  payload: string;
  signature: string;
}

export const isId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export const isVersion = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value);
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return Math.sign(x[index] - y[index]);
  }
  return 0;
}

const KNOWN_CAPABILITIES = new Set(["document-conversion"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,16}$/i;

function invalid(): never {
  throw new PluginError("verification-failed");
}

function isText(value: unknown, max: number, required = true): value is string {
  return typeof value === "string" && (required ? value.trim().length > 0 : true) && value.length <= max && !CONTROL_CHARACTERS.test(value);
}

function validateMenu(menu: unknown): CatalogMenuSection[] {
  if (!menu || typeof menu !== "object") return invalid();
  const sections = (menu as { sections?: unknown }).sections;
  if (!Array.isArray(sections) || !sections.length || sections.length > EXTENSION_MENU_LIMITS.sections) return invalid();
  const ids = new Set<string>();
  let total = 0;
  for (const section of sections as Array<{ title?: unknown; items?: unknown }>) {
    if (!section || typeof section !== "object" || !Array.isArray(section.items) || !section.items.length) return invalid();
    if (section.title !== undefined && !isText(section.title, EXTENSION_MENU_LIMITS.title)) return invalid();
    for (const item of section.items as Array<Record<string, unknown>>) {
      total += 1;
      if (!item || typeof item !== "object" || total > EXTENSION_MENU_LIMITS.items) return invalid();
      if (item.type === "separator") continue;
      if (item.type === "text") {
        if (!isText(item.text, EXTENSION_MENU_LIMITS.text)) return invalid();
        continue;
      }
      if (item.type !== "button" || !isId(item.id) || ids.has(item.id) || !isText(item.label, EXTENSION_MENU_LIMITS.label)) return invalid();
      ids.add(item.id);
      if (item.description !== undefined && !isText(item.description, EXTENSION_MENU_LIMITS.description)) return invalid();
      if (item.icon !== undefined && !(EXTENSION_ICON_NAMES as readonly string[]).includes(item.icon as string)) return invalid();
      const action = item.action as Partial<ImportFileAction> | undefined;
      if (!action || action.type !== "import-file" || !isId(action.command)
        || !Array.isArray(action.extensions) || !action.extensions.length || action.extensions.length > EXTENSION_MENU_LIMITS.extensions
        || !action.extensions.every((extension) => typeof extension === "string" && EXTENSION_PATTERN.test(extension))) return invalid();
    }
  }
  return sections as CatalogMenuSection[];
}

export function validateCatalog(catalog: unknown): Catalog {
  const value = catalog as Partial<Catalog> | null;
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !Array.isArray(value.plugins) || value.plugins.length > 32) return invalid();
  const ids = new Set<string>();
  for (const plugin of value.plugins as CatalogPlugin[]) {
    if (!plugin || !isId(plugin.id) || ids.has(plugin.id) || !isVersion(plugin.version) || !isVersion(plugin.minAppVersion)
      || typeof plugin.name !== "string" || !plugin.name.trim() || plugin.name.length > 100
      || typeof plugin.description !== "string" || plugin.description.length > 500
      || plugin.entry !== "worker.cjs" || !Array.isArray(plugin.files) || !plugin.files.length || plugin.files.length > MAX_PACKAGE_FILES
      || !Array.isArray(plugin.capabilities) || plugin.capabilities.length < 1 || plugin.capabilities.length > 4
      || !plugin.capabilities.every((capability) => KNOWN_CAPABILITIES.has(capability))) return invalid();
    ids.add(plugin.id);
    let total = 0;
    let workers = 0;
    const paths = new Set<string>();
    for (const file of plugin.files) {
      if (!file || !isHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 13 || file.bytes > MAX_FILE_BYTES
        || paths.has(file.path)) return invalid();
      if (file.kind === "code") {
        if (file.path !== plugin.entry) return invalid();
        workers += 1;
      } else if (file.kind === "font") {
        if (file.path !== `fonts/${file.sha256}.ttf` || typeof file.family !== "string"
          || typeof file.portable !== "boolean"
          || (file.complete !== undefined && typeof file.complete !== "boolean")
          || !/^[\p{L}\p{N} _-]{1,160}$/u.test(file.family)
          || typeof file.displayName !== "string" || file.displayName.length > 160) return invalid();
      } else return invalid();
      paths.add(file.path);
      total += file.bytes;
    }
    if (workers !== 1 || total > MAX_PACKAGE_BYTES) return invalid();
    if (plugin.ownFontFamilyPrefixes !== undefined && (!Array.isArray(plugin.ownFontFamilyPrefixes) || plugin.ownFontFamilyPrefixes.length > 8
      || !plugin.ownFontFamilyPrefixes.every((prefix) => typeof prefix === "string" && /^[\p{L}\p{N} _-]{1,40}$/u.test(prefix)))) return invalid();
    if (plugin.contributes !== undefined) {
      if (!plugin.contributes || typeof plugin.contributes !== "object") return invalid();
      if (plugin.contributes.menu !== undefined) validateMenu(plugin.contributes.menu);
    }
  }
  return value as Catalog;
}

/** Ed25519 の署名を固定の公開鍵で確かめてから、中身の形を検査する。署名の無いカタログは何も有効にしない。 */
export function verifyCatalog(envelope: unknown, publicKey: string): Catalog {
  const value = envelope as Partial<CatalogEnvelope> | null;
  if (!value || typeof value.payload !== "string" || typeof value.signature !== "string"
    || value.payload.length > MAX_CATALOG_BYTES || !/^[A-Za-z0-9+/]+=*$/.test(value.payload)
    || !/^[A-Za-z0-9+/]+=*$/.test(value.signature) || value.signature.length !== 88) return invalid();
  const payload = Buffer.from(value.payload, "base64");
  try {
    if (!verify(null, payload, publicKey, Buffer.from(value.signature, "base64"))) return invalid();
    return validateCatalog(JSON.parse(payload.toString("utf8")));
  } catch {
    return invalid();
  }
}
