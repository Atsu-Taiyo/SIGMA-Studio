"use client";

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { deliverHistoryShortcutToFocusedSurface } from "./command-shortcut-targets";

export interface DesktopMenuActionOptions {
  isDesktopApp: boolean;
  isModalSurfaceOpen: boolean;
  isImeCompositionActive(): boolean;
  runShortcutCommandRef: RefObject<(commandId: "edit.undo" | "edit.redo") => void>;
  createDocumentTab(): unknown;
  openDocumentViaDesktop(): unknown;
  exportJson(): unknown;
  openPrintPreview(): unknown;
  setDesktopSettingsUpdateCheckRequest: Dispatch<SetStateAction<number>>;
  setDesktopSettingsOpen: Dispatch<SetStateAction<boolean>>;
}

/** 購読は維持し、確定した最新 render のアクションをネイティブメニューへ配送する。 */
export function useDesktopMenuActions({
  isDesktopApp, isModalSurfaceOpen, isImeCompositionActive, runShortcutCommandRef,
  createDocumentTab, openDocumentViaDesktop, exportJson, openPrintPreview,
  setDesktopSettingsUpdateCheckRequest, setDesktopSettingsOpen,
}: DesktopMenuActionOptions) {

  /**
   * ネイティブメニュー由来の Undo / Redo を、キーボード経路と同じポリシーで振り分ける。
   *
   * メニュー click には `event.target` も `isComposing` も `repeat` も無いので、フォーカスは
   * `document.activeElement` から、IME 合成中かは自前の追跡 ref から読む。
   *
   * **オートリピートは通す (意図的)。** キーボード層は `event.repeat` を弾いて「押しっぱなしで
   * 1 手だけ」にしているが、メニューのキー等価には repeat フラグが無く、OS の自動リピートと
   * 連打を区別できない。時間しきい値で推測すると素早い連打を握り潰すので、**履歴を歩ける**
   * ほうに倒した。結果としてデスクトップだけ「押しっぱなしで戻り続ける」になるが、
   * これは多くのエディタの既定挙動でもある。
   */
  const runHistoryShortcutFromMenu = (direction: "undo" | "redo") => {
    // 判定と配達は `command-shortcut-targets.ts` が持つ。ここは引数を集めて呼ぶだけ。
    const outcome = deliverHistoryShortcutToFocusedSurface({
      activeElement: window.document.activeElement,
      direction,
      isComposing: isImeCompositionActive(),
      ownerDocument: window.document,
      isModalSurfaceOpen,
    });
    if (outcome === "document") {
      runShortcutCommandRef.current(direction === "undo" ? "edit.undo" : "edit.redo");
    }
  };

  const desktopMenuHandlersRef = useRef({
    newDocument: () => undefined as unknown,
    openDocument: () => undefined as unknown,
    saveDocument: () => undefined as unknown,
    printDocument: () => undefined as unknown,
    openSettings: () => undefined as unknown,
    checkUpdates: () => undefined as unknown,
    undo: () => undefined as unknown,
    redo: () => undefined as unknown,
  });

  useEffect(() => {
    desktopMenuHandlersRef.current = {
      newDocument: createDocumentTab,
      openDocument: openDocumentViaDesktop,
      saveDocument: exportJson,
      printDocument: openPrintPreview,
      // Edit メニューの Undo / Redo は ⌘Z / ⇧⌘Z を持ったままで、**キー押下もクリックも
      // 同じ click ハンドラを通って**ここへ来る (ネイティブメニューが role: "undo" だった頃は
      // click が無視されて webContents.undo() が走っていた。electron/main.ts 参照)。
      //
      // **メニュー経路は keydown を一切伴わない。** そのままコマンドを走らせると、キーボード層が
      // 通しているフォーカス判定・モーダル抑止・IME 抑止を丸ごと迂回し、AI チャット欄で
      // 打ち間違えて ⌘Z を押すと教材本体が巻き戻る。だから同じポリシーをここでも通す。
      undo: () => runHistoryShortcutFromMenu("undo"),
      redo: () => runHistoryShortcutFromMenu("redo"),
      openSettings: () => {
        setDesktopSettingsUpdateCheckRequest(0);
        setDesktopSettingsOpen(true);
      },
      checkUpdates: () => {
        setDesktopSettingsUpdateCheckRequest((current) => current + 1);
        setDesktopSettingsOpen(true);
      },
    };
  });

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }
    const bridge = getDesktopBridge();
    if (!bridge) {
      return;
    }
    return bridge.onMenuAction((action) => {
      const h = desktopMenuHandlersRef.current;
      if (action === "new-document") {
        void h.newDocument();
      } else if (action === "open-document") {
        void h.openDocument();
      } else if (action === "save-document") {
        void h.saveDocument();
      } else if (action === "print-document") {
        h.printDocument();
      } else if (action === "open-settings") {
        h.openSettings();
      } else if (action === "check-updates") {
        h.checkUpdates();
      } else if (action === "undo") {
        h.undo();
      } else if (action === "redo") {
        h.redo();
      }
    });
  }, [isDesktopApp]);
}
