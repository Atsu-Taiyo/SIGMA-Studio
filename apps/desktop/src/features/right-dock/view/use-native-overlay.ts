"use client";

import { useEffect, useState } from "react";

/**
 * ブラウザのページ面はネイティブのビューで、DOMのダイアログやメニューより手前に描かれる。
 * それらが開いている間はページ面を隠す必要があるので、アプリ内のダイアログ・メニュー・
 * 選択リストが見えているかを監視する。ツールチップは対象外 (隠すほどではない)。
 */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-modal-backdrop]",
  "[data-native-overlay]",
].join(",");

/** 本文キャンバスの中身はキャンバスの外へ張り出せない (ドックとは重ならない) ので調べない。 */
const NEVER_OVERLAPS_DOCK = ".editor-canvas";

function isVisible(element: Element): boolean {
  if (element.closest(NEVER_OVERLAPS_DOCK)) return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : (element as HTMLElement).getClientRects().length > 0;
}

export function findVisibleOverlay(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll(OVERLAY_SELECTOR)).some(isVisible);
}

function mentionsOverlay(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  // 本文の編集中に大量に増減する要素は調べない。
  if (node.closest(NEVER_OVERLAPS_DOCK)) return false;
  return node.matches(OVERLAY_SELECTOR) || node.querySelector(OVERLAY_SELECTOR) !== null;
}

export function useNativeOverlayPresent(enabled: boolean): boolean {
  const [present, setPresent] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const evaluate = () => {
      frame = 0;
      setPresent(findVisibleOverlay());
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(evaluate);
    };
    schedule();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some(mentionsOverlay)
        || (mutation.type === "attributes" && mutation.target instanceof Element && mutation.target.matches(OVERLAY_SELECTOR)))) {
        schedule();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "hidden", "role"] });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  // 無効の間は古い判定を返さない。
  return enabled && present;
}
