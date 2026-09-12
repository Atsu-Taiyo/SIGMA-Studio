"use client";

import { useEffect } from "react";

import { findSettingsEntry } from "./settings-catalog";

/**
 * 設定パレットから開いたとき、その項目までスクロールして一時的に光らせる。
 *
 * 各ダイアログが `focusEntryId` を受け取ってこのフックを呼ぶ。**スクロール先の解決は
 * `settings-catalog.ts` に一本化**してあるので、ダイアログ側は id の綴りを知らない。
 */
export const SETTINGS_FOCUS_HIGHLIGHT_CLASS = "settings-entry-focus";

/** ハイライトを消すまで。CSS のアニメーション長 (`--settings-entry-focus-ms`) と揃える。 */
const HIGHLIGHT_DURATION_MS = 1600;

/**
 * anchor が現れるまで待つ上限フレーム数 (60fps で約 2 秒)。
 *
 * 1 フレームだけ見て諦めると、**非同期に読み込む面では必ず外す**。AI 設定は
 * `aiResources.readTree()` が解決するまでシマーを出しているし、折りたたみの裏に
 * 居る項目は開いた次のフレームで初めて DOM に入る。
 */
const MAX_LOOKUP_FRAMES = 120;

export function useSettingsEntryFocus(focusEntryId: string | undefined): void {
  useEffect(() => {
    if (!focusEntryId) {
      return;
    }
    const anchorId = findSettingsEntry(focusEntryId)?.anchorId;
    if (!anchorId) {
      return;
    }

    let timer = 0;
    let frame = 0;
    let framesLeft = MAX_LOOKUP_FRAMES;
    let target: HTMLElement | null = null;

    const look = () => {
      target = document.getElementById(anchorId);
      if (!target) {
        framesLeft -= 1;
        if (framesLeft > 0) {
          frame = requestAnimationFrame(look);
        }
        return;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add(SETTINGS_FOCUS_HIGHLIGHT_CLASS);
      timer = window.setTimeout(() => {
        target?.classList.remove(SETTINGS_FOCUS_HIGHLIGHT_CLASS);
      }, HIGHLIGHT_DURATION_MS);
    };
    // ダイアログを開いたのと同じ tick では中身がまだ DOM に無い。次のフレームから探す。
    frame = requestAnimationFrame(look);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      // アンマウント時に消し忘れると、次に同じ要素を開いたとき光らない。
      target?.classList.remove(SETTINGS_FOCUS_HIGHLIGHT_CLASS);
    };
  }, [focusEntryId]);
}
