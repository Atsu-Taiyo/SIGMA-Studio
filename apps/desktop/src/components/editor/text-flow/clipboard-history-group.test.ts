import { describe, expect, it } from "vitest";

import {
  MIXED_CLIPBOARD_HISTORY_GROUP_META,
  createMixedClipboardHistoryGroup,
  markBodyCutHistoryGroup,
  peekBodyCutHistoryGroup,
} from "@/components/editor/text-flow/clipboard-history-group";

/**
 * 混在ペースト / 混在カットで、本文側と図形側に**同じコアレスキー**を配るための印。
 *
 * 図形側の保存は 250ms 遅れて別の `commitDocumentChange` として届くので、同じキーを
 * 共有していないと undo エントリが 2 段積まれ、⌘Z 1 回では本文が戻らない。
 *
 * カットの印がイベントで縛れないのは、本文側の受け取り口が ProseMirror の `onUpdate`
 * (ClipboardEvent を持たない) だから。代わりに **1 回読んだら消える**ことで、
 * 次のカットへ持ち越さない。
 */

describe("mixed clipboard history group", () => {
  it("mints a distinct key per operation", () => {
    const first = createMixedClipboardHistoryGroup();
    const second = createMixedClipboardHistoryGroup();

    expect(first).not.toBe(second);
    expect(first.startsWith("mixed_clipboard_history")).toBe(true);
  });

  it("names the transaction meta key it travels on", () => {
    expect(MIXED_CLIPBOARD_HISTORY_GROUP_META).toBe("sigmaMixedClipboardHistoryGroup");
  });

  it("hands the cut key to the first reader", () => {
    // 印はイベントで縛れない (読み手の `onUpdate` は ClipboardEvent を持たない)。
    // だから引数に event を取らない — 取ると、守っていない保証を型で匂わせることになる。
    markBodyCutHistoryGroup("mixed_clipboard_history_1");

    expect(peekBodyCutHistoryGroup()).toBe("mixed_clipboard_history_1");
  });

  it("forgets the cut key once it has been read", () => {
    // 持ち越すと、次に本文だけを切り取ったときに無関係な図形変更と同じキーになり、
    // その図形変更が畳まれて **永久に undo できなくなる**。
    markBodyCutHistoryGroup("mixed_clipboard_history_2");
    peekBodyCutHistoryGroup();

    expect(peekBodyCutHistoryGroup()).toBeNull();
  });

  it("keeps only the newest mark", () => {
    markBodyCutHistoryGroup("mixed_clipboard_history_3");
    markBodyCutHistoryGroup("mixed_clipboard_history_4");

    expect(peekBodyCutHistoryGroup()).toBe("mixed_clipboard_history_4");
  });
});
