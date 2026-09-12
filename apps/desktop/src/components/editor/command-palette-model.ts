import type { SettingsSurfaceId } from "@/components/editor/settings-catalog";
import { SETTINGS_ENTRIES } from "@/components/editor/settings-catalog";
import type { EditorShortcutBinding, ResolvedEditorCommand } from "@/lib/editor-command-shortcuts";
import type { AppLocale } from "@/lib/i18n";

/**
 * コマンドパレットの中身。**React に依存しない純関数**として持ち、
 * 並びとスコアリングはここだけで決める (UI は描くだけ)。
 */
interface PaletteEntryBase {
  id: string;
  label: string;
  /** グループ化のキー。表示名ではなく id を使う (訳語が衝突しても混ざらない)。 */
  groupId: string;
  /** グループ見出しの表示名。 */
  group: string;
  detail?: string;
  keywords?: string;
}

export type PaletteEntry =
  | (PaletteEntryBase & { kind: "command"; shortcut: string | null })
  | (PaletteEntryBase & { kind: "setting"; surface: SettingsSurfaceId; anchorId?: string });

export interface PaletteGroup {
  groupId: string;
  group: string;
  entries: readonly PaletteEntry[];
}

export const SETTINGS_GROUP_ID = "settings-entries";

export interface BuildPaletteEntriesInput {
  commands: readonly ResolvedEditorCommand[];
  /** コマンド id → 現在のバインド (ユーザーの再割り当て込み)。 */
  resolveShortcut: (commandId: string) => EditorShortcutBinding | null;
  formatShortcut: (binding: EditorShortcutBinding | null) => string;
  /** `settings` namespace の翻訳。設定項目の文言を引く。 */
  translateSetting: (key: string) => string;
  /** 設定項目のグループ見出し。 */
  settingsGroupLabel: string;
  /** パレットから隠すコマンド (パレット自身など)。 */
  hiddenCommandIds?: readonly string[];
  /**
   * その設定面をこのホストで開けるか。埋め込み (SDK web) にはデスクトップブリッジが
   * 無く、アプリ設定 / AI 設定は**開いても何も描かれない**ので、候補から落とす。
   * 省略時は全面が開けるものとして扱う。
   */
  isSettingsSurfaceAvailable?: (surface: SettingsSurfaceId) => boolean;
}

export function buildPaletteEntries(input: BuildPaletteEntriesInput): readonly PaletteEntry[] {
  const hidden = new Set(input.hiddenCommandIds ?? []);
  const commands: PaletteEntry[] = input.commands
    .filter((command) => !hidden.has(command.id))
    .map((command) => ({
      kind: "command" as const,
      id: command.id,
      label: command.label,
      groupId: command.categoryId,
      group: command.category,
      detail: command.description || undefined,
      keywords: command.keywords || undefined,
      shortcut: input.formatShortcut(input.resolveShortcut(command.id)) || null,
    }));

  const surfaceAvailable = input.isSettingsSurfaceAvailable ?? (() => true);
  const settings: PaletteEntry[] = SETTINGS_ENTRIES
    .filter((entry) => surfaceAvailable(entry.surface))
    .map((entry) => ({
      kind: "setting" as const,
      id: entry.id,
      label: input.translateSetting(entry.labelKey),
      groupId: SETTINGS_GROUP_ID,
      group: input.settingsGroupLabel,
      detail: entry.descriptionKey ? input.translateSetting(entry.descriptionKey) : undefined,
      keywords: entry.keywordsKey ? input.translateSetting(entry.keywordsKey) : undefined,
      surface: entry.surface,
      anchorId: entry.anchorId,
    }));

  return [...commands, ...settings];
}

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KATAKANA_TO_HIRAGANA = 0x60;

/**
 * 検索用の正規化。全角英数を半角へ畳み、カタカナをひらがなへ畳み、
 * ロケール規則で小文字化する。
 *
 * `toLocaleLowerCase(locale)` を使うのは、トルコ語の `I` のような言語依存の畳み方が
 * あるため。全角を畳むのは日本語入力のまま `ｆｏｎｔ` と打ってしまう事故が普通にあるから、
 * カタカナを畳むのは「プレビュー」と「ぷれびゅー」で結果が変わると変換前に打てないから。
 */
export function normalizeForSearch(value: string, locale: AppLocale): string {
  let folded = "";
  for (const char of value.normalize("NFKC")) {
    const code = char.codePointAt(0) ?? 0;
    folded += code >= KATAKANA_START && code <= KATAKANA_END
      ? String.fromCodePoint(code - KATAKANA_TO_HIRAGANA)
      : char;
  }
  return folded.toLocaleLowerCase(locale);
}

/**
 * 正規化済みフィールドのキャッシュ。1 打鍵ごとに候補 (約 155 件) × 5 フィールドを
 * 正規化し直すと NFKC が毎回 800 回近く走る。エントリは `buildPaletteEntries` が
 * 作り直さない限り同一参照なので、WeakMap で持てば打鍵中は 0 回になる。
 */
interface NormalizedFields {
  locale: AppLocale;
  label: string;
  group: string;
  detail: string;
  keywords: string;
  id: string;
}
const normalizedCache = new WeakMap<PaletteEntry, NormalizedFields>();

function normalizedFieldsOf(entry: PaletteEntry, locale: AppLocale): NormalizedFields {
  const cached = normalizedCache.get(entry);
  if (cached && cached.locale === locale) {
    return cached;
  }
  const fields: NormalizedFields = {
    locale,
    label: normalizeForSearch(entry.label, locale),
    group: normalizeForSearch(entry.group, locale),
    detail: entry.detail ? normalizeForSearch(entry.detail, locale) : "",
    keywords: entry.keywords ? normalizeForSearch(entry.keywords, locale) : "",
    id: normalizeForSearch(entry.id, locale),
  };
  normalizedCache.set(entry, fields);
  return fields;
}

/** 大きいほど上に出る。0 は「一致しない」。 */
export function scorePaletteEntry(entry: PaletteEntry, query: string, locale: AppLocale): number {
  return scoreNormalized(entry, normalizeForSearch(query.trim(), locale), locale);
}

function scoreNormalized(entry: PaletteEntry, normalizedQuery: string, locale: AppLocale): number {
  if (!normalizedQuery) {
    return 1;
  }
  const fields = normalizedFieldsOf(entry, locale);

  if (fields.label === normalizedQuery) {
    return 100;
  }
  if (fields.label.startsWith(normalizedQuery)) {
    return 90;
  }
  if (fields.label.includes(normalizedQuery)) {
    return 70;
  }
  if (fields.group.startsWith(normalizedQuery)) {
    return 55;
  }
  if (fields.keywords.includes(normalizedQuery)) {
    return 50;
  }
  if (fields.detail.includes(normalizedQuery) || fields.group.includes(normalizedQuery)) {
    return 40;
  }
  if (fields.id.includes(normalizedQuery)) {
    return 30;
  }
  // 頭文字のサブシーケンス (`fs` → "Font size")。最後の砦なので最低点。
  return isSubsequence(normalizedQuery, fields.label) ? 10 : 0;
}

/**
 * 絞り込み。**返り値の並びは画面の並びと必ず一致する** —
 * グループは連続して現れ、グループの順序はそのグループの最高スコア順。
 *
 * ここを「スコア順に並べてから描画側でグループ化する」形にすると、群を跨いで
 * スコアが交互になったときに ↑↓ の移動順と画面の並びがずれる (実測: ある絞り込みで
 * ArrowDown 7 回目が画面 12 行目に飛び、8〜11 行目が素通りになった)。
 */
export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
  locale: AppLocale,
): readonly PaletteEntry[] {
  const normalizedQuery = normalizeForSearch(query.trim(), locale);
  const scored = entries
    .map((entry, index) => ({ entry, index, score: scoreNormalized(entry, normalizedQuery, locale) }))
    .filter((row) => row.score > 0);

  const groupRank = new Map<string, { best: number; first: number }>();
  for (const row of scored) {
    const current = groupRank.get(row.entry.groupId);
    if (!current) {
      groupRank.set(row.entry.groupId, { best: row.score, first: row.index });
    } else if (row.score > current.best) {
      current.best = row.score;
    }
  }

  // 同点は元の並び (コマンド → 設定、カタログ順) を保つ。安定した並びでないと
  // 打鍵のたびに候補が入れ替わって選べない。
  scored.sort((a, b) => {
    const groupA = groupRank.get(a.entry.groupId)!;
    const groupB = groupRank.get(b.entry.groupId)!;
    return (groupB.best - groupA.best)
      || (groupA.first - groupB.first)
      || (b.score - a.score)
      || (a.index - b.index);
  });
  return scored.map((row) => row.entry);
}

/** グループ見出し付きで並べ直す。**入力の並びは崩さない** (見出しの順序は最初に現れた順)。 */
export function groupPaletteEntries(entries: readonly PaletteEntry[]): readonly PaletteGroup[] {
  const groups: { groupId: string; group: string; entries: PaletteEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.groupId === entry.groupId) {
      last.entries.push(entry);
    } else {
      groups.push({ groupId: entry.groupId, group: entry.group, entries: [entry] });
    }
  }
  return groups;
}

/** 画面の並び。`filterPaletteEntries` の結果と一致することをテストで固定している。 */
export function flattenPaletteGroups(groups: readonly PaletteGroup[]): readonly PaletteEntry[] {
  return groups.flatMap((group) => group.entries);
}

function isSubsequence(needle: string, haystack: string): boolean {
  const chars = [...needle];
  if (chars.length === 0) {
    return true;
  }
  let index = 0;
  for (const char of haystack) {
    if (char === chars[index]) {
      index += 1;
      if (index === chars.length) {
        return true;
      }
    }
  }
  return false;
}
