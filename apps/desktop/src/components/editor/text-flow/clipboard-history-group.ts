import { createId } from "@/lib/id";

/**
 * 混在ペースト / 混在カットを **1 つの undo エントリ**に畳むためのコアレスキー。
 *
 * 本文と図形が混ざった選択の操作は、SigmaDoc へ 2 回書き込む。本文は打鍵と同じ経路で
 * 即座に、図形は `queueOverlaySave` の 250ms 後に。素直に record すると履歴が 2 段積まれ、
 * ⌘Z 1 回では本文が戻らない —— 報告された「大きいブロックごとペーストしたら戻せない」
 * 「カットしたら戻せない」の正体がこれ。
 *
 * **`coalesce: true` は使えない。** `commitDocumentChange` の `coalesce` は「直前へマージ」
 * ではなく **`record` を丸ごとスキップ**するので、図形だけの操作でそれをやるとその変更は
 * 永久に undo できなくなる。代わりに `DocumentHistoryController.record` の
 * `coalescingKey` を 1 操作で共有する:
 *
 * - 本文が同じキー `K` で先に record 済み → 図形側の `K` は畳まれて 1 エントリ
 * - 本文が変わっていない (図形のみ) → `#activeCoalescingKey !== K` なので**必ず record**
 *
 * つまり **「本文も変わったか」を検出する必要が消える**。これが決定的な優位点。
 *
 * 先例: 跨ぎ選択の IME 置換が同じ手を使っている (`text-run-span.ts` の
 * `createId("text_run_span_history")`)。ここはそれをクリップボード操作へ横展開したもの。
 */

/** 本文側の混在ペーストで、鋳造したキーを載せる ProseMirror transaction の meta キー。 */
export const MIXED_CLIPBOARD_HISTORY_GROUP_META = "sigmaMixedClipboardHistoryGroup";

export function createMixedClipboardHistoryGroup(): string {
  return createId("mixed_clipboard_history");
}

/**
 * カットのキーを本文側の受け取り口へ渡す印。
 *
 * イベントで縛れない (`markBodyTextCut` と違って、受け取るのは ProseMirror の `onUpdate` で
 * ClipboardEvent を持たない)。代わりに **1 回読んだら消える**。持ち越すと、次に本文だけを
 * 切り取ったときに無関係な図形変更と同じキーになり、その図形変更が畳まれて永久に undo
 * できなくなる。
 *
 * 置くのは「必ず `view.dispatch` が続く」単一エディタ経路だけ。跨ぎ選択の経路は `onUpdate`
 * を通らないので、キーは `replaceActiveTextRunSpan` へ直接渡す (印を置くと誰も読まず残る)。
 */
let pendingBodyCutHistoryGroup: string | null = null;

export function markBodyCutHistoryGroup(group: string): void {
  pendingBodyCutHistoryGroup = group;
}

export function peekBodyCutHistoryGroup(): string | null {
  const pending = pendingBodyCutHistoryGroup;
  pendingBodyCutHistoryGroup = null;
  return pending;
}
