"use client";

import { useEffect, type RefObject } from "react";

import type { OverlayModeStatus } from "../page-overlay-types";
import {
  findCommandByShortcut,
  getCommandTargetPolicy,
  shouldDispatchOverlayArrangeShortcut,
  type EditorCommandId,
  type EditorCustomCommandDefinition,
  type EditorShortcutOverrides,
} from "@/lib/editor-command-shortcuts";
import type { UiLayoutPreference } from "@/lib/ui-layout-preference";

import { isCommandShortcutBlockedByTarget, isTextEntryTarget } from "./command-shortcut-targets";
import { createEditorCommandRunner, type EditorCommandActionPorts } from "./editor-command-actions";

export interface EditorCommandConfiguration {
  customCommands: EditorCustomCommandDefinition[];
  shortcutOverrides: EditorShortcutOverrides;
  commandSettingsLoaded: boolean;
  commandSettingsError: string | null;
}

/** The host projects UI and extension policy into values; this adapter does not read feature stores. */
export interface EditorCommandKeyboardState {
  isModalSurfaceOpen: boolean;
  uiLayoutMode: UiLayoutPreference["mode"];
  hasOverlaySelection: boolean;
  overlaySelectionLocked: boolean;
  blockedOverlaySelection: boolean;
  overlayModeStatus: OverlayModeStatus | null;
}

export interface EditorCommandRoutingOptions {
  configuration: EditorCommandConfiguration;
  keyboard: EditorCommandKeyboardState;
  actions: EditorCommandActionPorts;
  runShortcutCommandRef: RefObject<(commandId: EditorCommandId) => void>;
  toggleRibbonCollapseRef: RefObject<() => void>;
}

/** `edit.undo` / `edit.redo` なら向き、それ以外は null。 */
function historyShortcutDirection(commandId: string): "undo" | "redo" | null {
  if (commandId === "edit.undo") {
    return "undo";
  }
  return commandId === "edit.redo" ? "redo" : null;
}

/** Publish this render's runner in a passive effect, then own the command keydown subscription. */
export function useEditorCommandRouting({
  configuration: { customCommands, shortcutOverrides, commandSettingsLoaded, commandSettingsError },
  keyboard: {
    isModalSurfaceOpen, uiLayoutMode, hasOverlaySelection, overlaySelectionLocked,
    blockedOverlaySelection, overlayModeStatus,
  },
  actions,
  runShortcutCommandRef,
  toggleRibbonCollapseRef,
}: EditorCommandRoutingOptions): void {
  useEffect(() => {
    runShortcutCommandRef.current = createEditorCommandRunner(customCommands, actions);
  });

  useEffect(() => {
    const handleCommandShortcut = (event: KeyboardEvent) => {
      // 「いま他の面が前に出ているか」の抑止。ここは設定の読み込み状況とは無関係。
      // 判定はメニュー経路と共有する (`isModalSurfaceOpen`)。
      if (event.isComposing || isModalSurfaceOpen) {
        return;
      }

      // Word の Ctrl+F1 (リボンの開閉)。docs には無い操作なので
      // EDITOR_COMMAND_SHORTCUTS には登録せず、word 限定の固定キーとして扱う
      // （登録するとショートカット設定に「押しても何も起きないコマンド」が並ぶ）。
      // ユーザー設定のショートカット表とは無関係な固定キーなので、設定の読み込み
      // (commandSettingsLoaded) を待たない — 待つと、デスクトップで設定の読み込みが
      // 終わるまでリボンを開閉できない。
      // Word と同じ Ctrl+F1 だけを見る（⌘F1 は Word のバインドではないし、macOS の
      // 既存コマンドは ⌘ 側に寄せてあるので取り合いになる）。
      const wantsRibbonToggle = uiLayoutMode === "word"
        && event.key === "F1"
        && event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && !event.shiftKey;
      // ユーザーが Ctrl+F1 を自分のコマンドへ割り当てていたらそちらを優先する。
      // 設定がまだ読めていないときは «割り当ては無い» とみなして先にリボンを開閉する
      // — ここで待つと、デスクトップでは設定が読めるまでリボンを開閉できない。
      const settingsReady = commandSettingsLoaded && !commandSettingsError;
      if (wantsRibbonToggle && !(settingsReady && findCommandByShortcut(event, shortcutOverrides, customCommands))) {
        event.preventDefault();
        event.stopPropagation();
        toggleRibbonCollapseRef.current();
        return;
      }

      // ここから先はユーザー設定のショートカット表を引くので、読めていないと引けない。
      if (!settingsReady) {
        return;
      }

      const match = findCommandByShortcut(event, shortcutOverrides, customCommands);
      if (!match) {
        return;
      }
      // フォーカス面の判定はメニュー経路と共有する 1 箇所へ (`command-shortcut-targets.ts`)。
      // ここでブロックされたときに**イベントを止めない**のが肝 —— 止めなければ MathLive /
      // ProseMirror / ブラウザの既定 undo がそのまま処理する。
      if (isCommandShortcutBlockedByTarget(
        event.target,
        getCommandTargetPolicy(match.commandId, customCommands),
        match.binding,
        historyShortcutDirection(match.commandId),
      )) {
        return;
      }

      const editingOverlayTextOrTable = overlayModeStatus?.id === "overlay.textEditing"
        || overlayModeStatus?.id === "overlay.tableEditing";
      if (!shouldDispatchOverlayArrangeShortcut(match.commandId, {
        hasUnlockedOverlaySelection: hasOverlaySelection
          && !overlaySelectionLocked
          && !blockedOverlaySelection,
        editingOverlayTextOrTable,
        editingTextTarget: isTextEntryTarget(event.target),
      })) {
        return;
      }

      if (
        event.repeat
        && match.commandId !== "view.zoomIn"
        && match.commandId !== "view.zoomOut"
        && match.commandId !== "overlay.arrange.forward"
        && match.commandId !== "overlay.arrange.backward"
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      runShortcutCommandRef.current(match.commandId);
    };

    window.addEventListener("keydown", handleCommandShortcut, true);
    return () => window.removeEventListener("keydown", handleCommandShortcut, true);
  }, [
    isModalSurfaceOpen,
    commandSettingsError,
    commandSettingsLoaded,
    uiLayoutMode,
    blockedOverlaySelection,
    customCommands,
    hasOverlaySelection,
    overlayModeStatus,
    overlaySelectionLocked,
    shortcutOverrides,
    runShortcutCommandRef,
    toggleRibbonCollapseRef,
  ]);

}
