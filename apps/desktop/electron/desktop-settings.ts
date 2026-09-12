import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parseEditorCustomCommands, parseEditorShortcutOverrides } from "@/lib/editor-command-shortcuts";
import { DEFAULT_LOCALE, normalizeLocale, type AppLocale } from "@/lib/i18n/locale";

const MAX_FONT_FAMILY_LENGTH = 512;
const MAX_CUSTOM_FONTS = 200;

export interface DesktopSettings {
  codexBin?: string;
  claudeBin?: string;
  antigravityBin?: string;
  editorFontFamily?: string;
  customFonts?: DesktopCustomFont[];
  commandShortcuts?: unknown;
  customCommands?: unknown;
  // MCPサーバーが検証済み (verification.validationOk === true) と報告した pending 提案を、
  // baseRevision が現在のファイルrevisionと一致する場合に限り自動承認する。既定は無効 (false) で、
  // 未設定 (キー欠落) も false として扱う (readDesktopSettingsSync 参照)。
  aiAutoApplyVerifiedProposals?: boolean;
  // AIエージェント (Codex/Claude/Antigravity) にWeb検索を許可する。既定は有効 (true) で、
  // 未設定 (キー欠落) も true として扱う (isAiWebSearchEnabled 参照)。false のときだけ
  // キーを書き込む (設定ファイルを簡潔に保つため、他の bool 設定と極性が逆な点に注意)。
  aiWebSearchEnabled?: boolean;
  // UIの表示言語。mainプロセスとMCPサーバーも読むので、localStorageではなくここが正本。
  // 他の既定値と違いキーの「不在」が「まだ選んでいない」を意味する (= OSロケール検出に
  // 委ねる) ので、既定の ja を選んだ場合もキーを消さずに書く。
  uiLocale?: AppLocale;
}

export interface DesktopCustomFont {
  id: string;
  displayName: string;
  fileName: string;
  cssFamily: string;
  importedAt: string;
}

export interface DesktopCommandSettingsPayload {
  commandShortcuts?: unknown;
  customCommands?: unknown;
}

export interface DesktopEditorPreferences {
  fontFamily: string | null;
}

export function desktopSettingsPath(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}

function readDesktopSettingsRawSync(dataDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(desktopSettingsPath(dataDir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readDesktopSettingsSync(dataDir: string): DesktopSettings {
  return normalizeDesktopSettings(readDesktopSettingsRawSync(dataDir));
}

let desktopSettingsWriteQueue: Promise<void> = Promise.resolve();

export async function writeDesktopSettings(dataDir: string, settings: DesktopSettings): Promise<void> {
  const nextWrite = desktopSettingsWriteQueue.then(() => writeDesktopSettingsNow(dataDir, settings));
  desktopSettingsWriteQueue = nextWrite.catch(() => undefined);
  await nextWrite;
}

async function writeDesktopSettingsNow(dataDir: string, settings: DesktopSettings): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const next: Record<string, unknown> = { ...readDesktopSettingsRawSync(dataDir) };

  if ("codexBin" in settings) {
    setOptionalTrimmedSetting(next, "codexBin", settings.codexBin);
  }
  if ("claudeBin" in settings) {
    setOptionalTrimmedSetting(next, "claudeBin", settings.claudeBin);
  }
  if ("antigravityBin" in settings) {
    setOptionalTrimmedSetting(next, "antigravityBin", settings.antigravityBin);
  }
  if ("editorFontFamily" in settings) {
    const fontFamily = normalizeEditorFontFamily(settings.editorFontFamily);
    if (fontFamily) {
      next.editorFontFamily = fontFamily;
    } else {
      delete next.editorFontFamily;
    }
  }
  if ("customFonts" in settings) {
    const customFonts = normalizeDesktopCustomFonts(settings.customFonts);
    if (customFonts.length > 0) {
      next.customFonts = customFonts;
    } else {
      delete next.customFonts;
    }
  }
  if ("commandShortcuts" in settings) {
    const commandShortcuts = normalizeDesktopCommandShortcuts(settings.commandShortcuts);
    if (Object.keys(commandShortcuts).length > 0) {
      next.commandShortcuts = commandShortcuts;
    } else {
      delete next.commandShortcuts;
    }
  }
  if ("customCommands" in settings) {
    const customCommands = normalizeDesktopCustomCommands(settings.customCommands);
    if (customCommands.length > 0) {
      next.customCommands = customCommands;
    } else {
      delete next.customCommands;
    }
  }
  if ("aiAutoApplyVerifiedProposals" in settings) {
    if (settings.aiAutoApplyVerifiedProposals) {
      next.aiAutoApplyVerifiedProposals = true;
    } else {
      // 既定値 (false) はキーごと削除して設定ファイルを簡潔に保つ。
      delete next.aiAutoApplyVerifiedProposals;
    }
  }
  if ("aiWebSearchEnabled" in settings) {
    if (settings.aiWebSearchEnabled === false) {
      next.aiWebSearchEnabled = false;
    } else {
      // 既定値 (true) はキーごと削除して設定ファイルを簡潔に保つ。
      delete next.aiWebSearchEnabled;
    }
  }
  if ("uiLocale" in settings) {
    const uiLocale = normalizeUiLocale(settings.uiLocale);
    if (uiLocale) {
      // 既定の ja でもキーを書く。ここでキーを消すと「日本語を明示的に選んだ」が
      // 「まだ選んでいない」と区別できなくなり、英語OSでは次回起動が英語に戻る。
      next.uiLocale = uiLocale;
    } else {
      delete next.uiLocale;
    }
  }

  const settingsPath = desktopSettingsPath(dataDir);
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, settingsPath);
}

export function readDesktopEditorPreferences(dataDir: string): DesktopEditorPreferences {
  return {
    fontFamily: readDesktopSettingsSync(dataDir).editorFontFamily ?? null,
  };
}

export function normalizeEditorFontFamily(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const fontFamily = value.trim();
  return fontFamily.length > 0 && fontFamily.length <= MAX_FONT_FAMILY_LENGTH ? fontFamily : undefined;
}

export function normalizeDesktopCustomFonts(value: unknown): DesktopCustomFont[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const fonts: DesktopCustomFont[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = normalizeFontToken(record.id);
    const displayName = normalizeFontDisplayName(record.displayName);
    const fileName = normalizeFontFileName(record.fileName);
    const cssFamily = normalizeEditorFontFamily(record.cssFamily);
    const importedAt = typeof record.importedAt === "string" && record.importedAt.trim()
      ? record.importedAt.trim()
      : new Date(0).toISOString();
    if (!id || !displayName || !fileName || !cssFamily || seen.has(id)) {
      continue;
    }
    seen.add(id);
    fonts.push({ id, displayName, fileName, cssFamily, importedAt });
    if (fonts.length >= MAX_CUSTOM_FONTS) {
      break;
    }
  }
  return fonts;
}

function normalizeFontToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const token = value.trim();
  return /^[a-zA-Z0-9_-]{1,80}$/u.test(token) ? token : undefined;
}

function normalizeFontDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  return name.length > 0 && name.length <= 120 ? name : undefined;
}

function normalizeFontFileName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const fileName = value.trim();
  return /^[^/\\:]{1,180}\.(?:ttf|otf|woff2?|ttc)$/iu.test(fileName) ? fileName : undefined;
}

export function normalizeDesktopCommandShortcuts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return parseEditorShortcutOverrides(JSON.stringify(value));
}

export function normalizeDesktopCustomCommands(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return parseEditorCustomCommands(JSON.stringify(value));
}

export function parseDesktopCommandSettingsPayload(value: unknown): DesktopCommandSettingsPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const commandShortcuts = record.commandShortcuts ?? null;
  const customCommands = record.customCommands ?? [];
  if (commandShortcuts !== null && (typeof commandShortcuts !== "object" || Array.isArray(commandShortcuts))) {
    return null;
  }
  if (!Array.isArray(customCommands)) {
    return null;
  }
  const normalizedCommandShortcuts = normalizeDesktopCommandShortcuts(commandShortcuts);
  const normalizedCustomCommands = normalizeDesktopCustomCommands(customCommands);
  return {
    commandShortcuts: Object.keys(normalizedCommandShortcuts).length > 0 ? normalizedCommandShortcuts : undefined,
    customCommands: normalizedCustomCommands,
  };
}

function normalizeDesktopSettings(value: unknown): DesktopSettings {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const parsed = value as Record<string, unknown>;
  const next: DesktopSettings = {};
  const codexBin = normalizeTrimmedString(parsed.codexBin);
  const claudeBin = normalizeTrimmedString(parsed.claudeBin);
  const antigravityBin = normalizeTrimmedString(parsed.antigravityBin) ?? normalizeTrimmedString(parsed.geminiBin);
  const editorFontFamily = normalizeEditorFontFamily(parsed.editorFontFamily);
  const customFonts = normalizeDesktopCustomFonts(parsed.customFonts);
  const commandShortcuts = normalizeDesktopCommandShortcuts(parsed.commandShortcuts);
  const customCommands = normalizeDesktopCustomCommands(parsed.customCommands);
  const aiAutoApplyVerifiedProposals = parsed.aiAutoApplyVerifiedProposals === true;
  const aiWebSearchEnabled = parsed.aiWebSearchEnabled !== false;
  const uiLocale = normalizeUiLocale(parsed.uiLocale);

  if (codexBin) {
    next.codexBin = codexBin;
  }
  if (claudeBin) {
    next.claudeBin = claudeBin;
  }
  if (antigravityBin) {
    next.antigravityBin = antigravityBin;
  }
  if (editorFontFamily) {
    next.editorFontFamily = editorFontFamily;
  }
  if (customFonts.length > 0) {
    next.customFonts = customFonts;
  }
  if (Object.keys(commandShortcuts).length > 0) {
    next.commandShortcuts = commandShortcuts;
  }
  if (customCommands.length > 0) {
    next.customCommands = customCommands;
  }
  if (aiAutoApplyVerifiedProposals) {
    next.aiAutoApplyVerifiedProposals = true;
  }
  if (!aiWebSearchEnabled) {
    next.aiWebSearchEnabled = false;
  }
  if (uiLocale) {
    next.uiLocale = uiLocale;
  }

  return next;
}

/** 設定ファイル / IPC から来た表示言語を対応ロケールへ畳む。判定できなければ undefined。 */
export function normalizeUiLocale(value: unknown): AppLocale | undefined {
  return normalizeLocale(typeof value === "string" ? value : null) ?? undefined;
}

/** Web検索設定の既定値 (true) を含めて解決する。未設定 (キー欠落) は true として扱う。 */
export function isAiWebSearchEnabled(settings: DesktopSettings): boolean {
  return settings.aiWebSearchEnabled !== false;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function setOptionalTrimmedSetting<Key extends "codexBin" | "claudeBin" | "antigravityBin">(
  settings: Record<string, unknown>,
  key: Key,
  value: DesktopSettings[Key],
): void {
  const normalized = normalizeTrimmedString(value);
  if (normalized) {
    settings[key] = normalized;
  } else {
    delete settings[key];
  }
}

/**
 * main プロセスでプロンプトを組むときの表示言語。
 *
 * **renderer の React context はここから見えない**ので、保存済み設定 → OS ロケール →
 * 既定 (日本語) の順で解決する。教材の中身の言語はこれとは独立で、
 * `prompt.documentLanguagePolicy` が「編集中の教材の言語で書く」ことを指示する (D2)。
 */
export function resolveDesktopPromptLocale(dataDir: string, osLocale?: string): AppLocale {
  return readDesktopSettingsSync(dataDir).uiLocale
    ?? normalizeUiLocale(osLocale)
    ?? DEFAULT_LOCALE;
}
