/**
 * アプリ（描画側）と拡張機能ホスト（Electron の main）の間で受け渡すデータの型。
 *
 * ここにあるのは「何を描くか」の記述だけで、拡張機能のコードは一切動かさない。
 * 拡張機能は署名付きのカタログに、メニューへ並べたいもの（見出し・ボタン・説明文・区切り線）を
 * データとして書く。描くのはアプリで、ボタンを押したときに何が起きるか（action）はホストだけが知っている。
 * 描画側は項目を id で指名できるだけなので、拡張機能が画面や他の教材へ手を出す道は無い。
 */

/** メニューのボタンに添えられるアイコン。アプリが持つ固定の集合から選ばせ、任意の画像は受け付けない。 */
export const EXTENSION_ICON_NAMES = [
  "file-input", "folder-open", "download", "upload", "sparkles", "puzzle", "file-text", "image", "table", "book-open",
] as const;
export type ExtensionIconName = (typeof EXTENSION_ICON_NAMES)[number];

/** カタログの検証と描画の両方が守る上限。長い文字列や大量の項目でメニューが壊れないようにする。 */
export const EXTENSION_MENU_LIMITS = {
  sections: 8,
  items: 32,
  title: 60,
  label: 80,
  description: 200,
  text: 300,
  extensions: 8,
} as const;

/** メニューに描く1行。ボタンの action は含めない（ホストが持つ）。 */
export type ExtensionMenuEntry =
  | { type: "button"; id: string; label: string; description?: string; icon?: ExtensionIconName }
  | { type: "text"; text: string }
  | { type: "separator" };

export interface ExtensionMenuSection {
  title?: string;
  entries: ExtensionMenuEntry[];
}

/** 拡張機能ひとつぶんのメニュー。インストール済み・有効・権限ありの拡張機能だけがホストから返る。 */
export interface ExtensionMenuGroup {
  extensionId: string;
  name: string;
  sections: ExtensionMenuSection[];
}

export type ExtensionRunError =
  | "canceled"
  | "busy"
  | "unavailable"
  | "unauthorized"
  | "forbidden"
  | "invalid-input"
  | "timeout"
  | "import-failed";

/** 取り込みの結果に添えられる所見（代替したフォントなど）。種類 (code) の意味づけは拡張機能が決める。 */
export interface ExtensionImportIssue {
  code: string;
  detail: string;
}

/** 拡張機能が返した教材。描画側は `recoverSigmaDocument` を通してから別の教材として開く。 */
export type ExtensionRunResult =
  | { ok: true; document: unknown; issues: ExtensionImportIssue[]; sourceName: string }
  | { ok: false; error: ExtensionRunError };

export interface ExtensionBridge {
  menu(): Promise<ExtensionMenuGroup[]>;
  /** 項目 id を指名して実行する。ファイル選択などはホストが出す。 */
  run(extensionId: string, itemId: string): Promise<ExtensionRunResult>;
  onMenuChange(listener: (groups: ExtensionMenuGroup[]) => void): () => void;
}

/** Electron の preload が公開する橋。Web 版や埋め込みには無い。 */
export function getExtensionBridge(): ExtensionBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sigmaExtensions?: ExtensionBridge }).sigmaExtensions ?? null;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value) ? value : null;
}

/**
 * ホストから届いたメニューを、描く前にもう一度検査して整える。
 * ホストが検証済みでも、描画側は「形が正しいものだけを描く」を自分で守る。壊れた項目は黙って捨てる。
 */
export function normalizeExtensionMenu(value: unknown): ExtensionMenuGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ExtensionMenuGroup[] = [];
  for (const rawGroup of value.slice(0, 32)) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const group = rawGroup as { extensionId?: unknown; name?: unknown; sections?: unknown };
    const name = text(group.name, 100);
    if (typeof group.extensionId !== "string" || !ID_PATTERN.test(group.extensionId) || !name || !Array.isArray(group.sections)) continue;
    const sections: ExtensionMenuSection[] = [];
    let items = 0;
    for (const rawSection of group.sections.slice(0, EXTENSION_MENU_LIMITS.sections)) {
      if (!rawSection || typeof rawSection !== "object") continue;
      const section = rawSection as { title?: unknown; entries?: unknown };
      if (!Array.isArray(section.entries)) continue;
      const title = text(section.title, EXTENSION_MENU_LIMITS.title);
      const entries: ExtensionMenuEntry[] = [];
      for (const rawEntry of section.entries) {
        if (items >= EXTENSION_MENU_LIMITS.items) break;
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = rawEntry as Record<string, unknown>;
        if (entry.type === "separator") {
          entries.push({ type: "separator" });
        } else if (entry.type === "text") {
          const body = text(entry.text, EXTENSION_MENU_LIMITS.text);
          if (body) entries.push({ type: "text", text: body });
        } else if (entry.type === "button") {
          const label = text(entry.label, EXTENSION_MENU_LIMITS.label);
          if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || !label) continue;
          const description = text(entry.description, EXTENSION_MENU_LIMITS.description);
          const icon = (EXTENSION_ICON_NAMES as readonly unknown[]).includes(entry.icon) ? (entry.icon as ExtensionIconName) : undefined;
          entries.push({ type: "button", id: entry.id, label, ...(description ? { description } : {}), ...(icon ? { icon } : {}) });
        } else continue;
        items += 1;
      }
      if (entries.some((entry) => entry.type !== "separator")) sections.push({ ...(title ? { title } : {}), entries });
    }
    if (sections.length) groups.push({ extensionId: group.extensionId, name, sections });
  }
  return groups;
}
