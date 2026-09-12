import type { EditorShortcutBinding } from "@/lib/editor-command-shortcuts";

/**
 * ⌘P の取り合いを決める 2 定数。**案 A / 案 C の切り替えはここだけで済む。**
 *
 * - 案 A (採用): ⌘P = コマンドパレット / ⌘⇧P = PDF プレビュー
 * - 案 C: 2 つの値を入れ替えるだけ (VS Code の実際の割り当てに忠実な代替案)
 *
 * この 2 つは **3 箇所**で同じ値でなければならない:
 *   1. `EDITOR_COMMAND_SHORTCUTS` の既定バインド
 *   2. `electron/main.ts` の `buildMenu` の accelerator (ネイティブメニューは
 *      レンダラの keydown より **先に**発火するので、ここが古いとレンダラに届かない)
 *   3. ユーザーの再割り当て (`settings.json` / localStorage) — こちらは上書きなので追随不要
 *
 * 1 と 2 のずれは `electron/menu-accelerator-parity.test.ts` が落とす。
 */
export const COMMAND_PALETTE_BINDING: EditorShortcutBinding = { primary: true, key: "p" };

export const PRINT_PREVIEW_BINDING: EditorShortcutBinding = { primary: true, shift: true, key: "p" };
