import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **メニュー経路が同じポリシーを通ること。**
 *
 * ここが今回の中心。メニュー click は keydown を伴わないので、判定をイベントの中に書くと
 * メニューだけが素通りする。振る舞いでは押さえにくい (実機の OS メニューが要る) ので、
 * 配線を構造で固定する。
 */
const shellSource = readFileSync(
  fileURLToPath(new URL("../EditorShell.tsx", import.meta.url)),
  "utf8",
);
const routingSource = readFileSync(new URL("./use-editor-command-routing.ts", import.meta.url), "utf8");
const desktopMenuSource = readFileSync(new URL("./use-desktop-menu-actions.ts", import.meta.url), "utf8");

function sliceOf(from: string, to: string, source = shellSource): string {
  const start = source.indexOf(from);
  expect(start, `${from} が見つからない`).toBeGreaterThan(0);
  const end = source.indexOf(to, start);
  expect(end, `${to} が見つからない`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("menu history shortcut wiring", () => {
  it("routes the menu action through the shared policy", () => {
    const handlers = sliceOf("      undo: () => ", "      openSettings: () => {", desktopMenuSource);
    expect(handlers).toContain('runHistoryShortcutFromMenu("undo")');
    expect(handlers).toContain('runHistoryShortcutFromMenu("redo")');
    // コマンド id を直に走らせるとフォーカス判定を迂回する。
    expect(handlers).not.toContain('runShortcutCommandRef.current("edit.undo")');
  });

  it("applies the focus policy, the modal guard and the IME guard", () => {
    const body = sliceOf("  const runHistoryShortcutFromMenu = (", "  const desktopMenuHandlersRef", desktopMenuSource);
    expect(body).toContain("isModalSurfaceOpen,");
    expect(body).toContain("deliverHistoryShortcutToFocusedSurface({");
    expect(body).toContain("isComposing: isImeCompositionActive()");
    expect(body).toContain("activeElement: window.document.activeElement");
  });

  it("hands the delivery to the shared router and only runs the command when it says so", () => {
    // 届け先ごとの実際の配達は `command-shortcut-targets.test.ts` が本物の DOM で見る。
    // ここで固定するのは配線 —— コンポーネントは「引数を集めて呼ぶだけ」で、
    // ルータが `"document"` と言ったときにだけ文書コマンドを走らせる。
    const body = sliceOf("  const runHistoryShortcutFromMenu = (", "  const desktopMenuHandlersRef", desktopMenuSource);
    const call = body.indexOf("deliverHistoryShortcutToFocusedSurface({");
    const guard = body.indexOf('if (outcome === "document") {');
    const command = body.indexOf('runShortcutCommandRef.current(direction === "undo" ? "edit.undo" : "edit.redo")');
    expect(call).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(call);
    expect(command).toBeGreaterThan(guard);
  });

  it("routes the native-history receiver through the same policy", () => {
    // **3 本目の入口。** `beforeinput` ガードが右クリック Undo・3 本指スワイプ・支援技術から
    // 流してくる。ここが素通りだと、モーダルの上でも IME 変換中でも背後の文書が巻き戻る。
    const body = sliceOf(
      "    const handleNativeHistoryCommand = (event: Event) => {",
      "    window.addEventListener(NATIVE_HISTORY_COMMAND_EVENT",
    );
    expect(body).toContain("deliverHistoryShortcutToFocusedSurface({");
    expect(body).toContain("isModalSurfaceOpen,");
    expect(body).toContain("isComposing: isImeCompositionActive()");
    // 面ごとの振り分けはガード側が済ませている。投げ返すと合図が往復する。
    expect(body).toContain("deliverToFocusedSurface: false,");
    const guard = body.indexOf('if (outcome !== "document") {');
    const undo = body.indexOf("undoDocumentChange()");
    expect(guard).toBeGreaterThan(0);
    expect(undo).toBeGreaterThan(guard);
  });

  it("lets a stuck composition expire instead of wedging the menu shut", () => {
    // `compositionend` は取りこぼす経路がいくつもある (要素の引き剥がし・Escape での
    // キャンセル・アプリ切り替え・programmatic blur)。真偽値で持つと立ちっぱなしになり、
    // セッション中ずっとメニュー ⌘Z が死ぬ。**失効の判定は読む側に置く。**
    const reader = sliceOf("  const isImeCompositionActive = useCallback(() => {", "  useEffect(() => {");
    expect(reader).toContain("isCompositionStillActive(element)");
    expect(reader).toContain("imeCompositionElementRef.current = null;");

    // 立ちっぱなしを不可能にする 4 本目の出口 (合成を伴わない入力・ウィンドウの blur) が
    // 実際に購読されていること。
    // **購読側だけを切り出す。** 解除側 (`removeEventListener`) まで含めて数えると、
    // 購読を消す変異が解除側の同じ文字列で素通りする (実測済みの偽陽性)。
    const effect = sliceOf(
      "    const endIfNotComposing = (event: Event) => {",
      "    return () => {",
    );
    for (const wiring of [
      'window.addEventListener("compositionend", end, true)',
      'window.addEventListener("focusout", end, true)',
      'window.addEventListener("keydown", endIfNotComposing, true)',
      'window.addEventListener("keyup", endIfNotComposing, true)',
      'window.addEventListener("pointerdown", end, true)',
      'window.addEventListener("blur", end)',
    ]) {
      expect(effect, wiring).toContain(wiring);
    }
    expect(effect).toContain("shouldEndCompositionForEvent(event)");
  });

  it("keeps the receiver honest about what it depends on", () => {
    // 依存が漏れると、マウント時の値を握ったまま固まる。IME 側を値ベースへ寄せた瞬間に壊れる。
    const deps = sliceOf("  }, [closeTransientCommandSurfaces, isImeCompositionActive,", ");");
    expect(deps).toContain("isModalSurfaceOpen");
  });

  it("shares one modal guard between the keyboard and the menu", () => {
    // 片方だけに書くと、メニューがダイアログを飛び越えて背後の文書を戻す。
    expect(shellSource.match(/isModalSurfaceOpen/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const keyboard = sliceOf("    const handleCommandShortcut = (event: KeyboardEvent) => {", "      const match =", routingSource);
    expect(keyboard).toContain("event.isComposing || isModalSurfaceOpen");
  });

  it("asks the shared policy from the keyboard path too", () => {
    const keyboard = sliceOf("      const match = findCommandByShortcut(", "      const editingOverlayTextOrTable", routingSource);
    expect(keyboard).toContain("isCommandShortcutBlockedByTarget(");
    expect(keyboard).toContain("getCommandTargetPolicy(match.commandId, customCommands)");
    expect(keyboard).toContain("historyShortcutDirection(match.commandId)");
  });
});
