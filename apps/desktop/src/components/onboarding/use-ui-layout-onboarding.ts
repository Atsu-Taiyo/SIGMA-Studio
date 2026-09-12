"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  APP_READY_EVENT,
  SPLASH_FADE_OUT_MS,
  SPLASH_MARKER_ATTRIBUTE,
  SPLASH_MAX_VISIBLE_MS,
} from "@/components/StartupSplash";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { shouldShowUiLayoutOnboarding, useUiLayoutPreference } from "@/lib/ui-layout-preference";

const SPLASH_SELECTOR = `[${SPLASH_MARKER_ATTRIBUTE}]`;
/** スプラッシュが自力で消える最遅時刻。消え損ねても出さないままにはしない。 */
const SPLASH_GONE_DEADLINE_MS = SPLASH_MAX_VISIBLE_MS + SPLASH_FADE_OUT_MS;

/**
 * 起動シーケンスが終わってオンボーディングを出せる状態か。
 *
 * 2つの条件を待つ:
 * - `APP_READY_EVENT`: 教材が開けている合図。EditorShell が落ちた場合は来ないので、
 *   クラッシュ画面の上にモーダルを重ねて操作不能にしてしまうことがない。
 * - スプラッシュ (z-index:10000) が DOM から消えたこと。モーダルは --z-modal:5000 なので
 *   先に出すと下に隠れる。app-ready からの時刻計算では合わない — フェードは class が
 *   付いた**フレームの描画**から始まり、起動直後は本文描画に押されて数百ms遅れるため、
 *   実測では時刻計算方式の表示時点でスプラッシュがまだ opacity 0.48 で残っていた。
 */
function useStartupSettled(): boolean {
  const [appReady, setAppReady] = useState(false);
  // 起動時はスプラッシュが必ず居るので初期値は false になる。SSR とも一致する。
  const [splashGone, setSplashGone] = useState(
    () => typeof document !== "undefined" && !document.querySelector(SPLASH_SELECTOR),
  );

  useEffect(() => {
    const handleAppReady = () => setAppReady(true);
    window.addEventListener(APP_READY_EVENT, handleAppReady);
    return () => window.removeEventListener(APP_READY_EVENT, handleAppReady);
  }, []);

  useEffect(() => {
    const splash = document.querySelector(SPLASH_SELECTOR);
    if (!splash) {
      // 初期値がすでに true。ここで setState すると effect 内更新になるので何もしない。
      return;
    }

    // スプラッシュは自分自身を unmount して消えるので、親の childList を見れば
    // ポーリング無しで「消えた瞬間」が取れる (取りこぼすと編集画面が一瞬見える)。
    const observer = new MutationObserver(() => {
      if (!document.querySelector(SPLASH_SELECTOR)) {
        setSplashGone(true);
      }
    });
    const parent = splash.parentNode;
    if (parent) {
      observer.observe(parent, { childList: true });
    }
    const deadlineId = window.setTimeout(() => setSplashGone(true), SPLASH_GONE_DEADLINE_MS);

    return () => {
      observer.disconnect();
      window.clearTimeout(deadlineId);
    };
  }, []);

  return appReady && splashGone;
}

/**
 * 初回オンボーディングを出すかどうか。表示側 (UiLayoutOnboardingDialog) と
 * ショートカット抑止側 (EditorShell) が同じ値を見るための共有フック。
 * 判定そのものは純関数 shouldShowUiLayoutOnboarding が持つ。
 */
export function useUiLayoutOnboardingVisible(input: { isEmbedded: boolean }): boolean {
  const [preference] = useUiLayoutPreference();
  const isDesktopApp = useSyncExternalStore(
    useCallback(() => () => undefined, []),
    useCallback(() => Boolean(getDesktopBridge()), []),
    useCallback(() => false, []),
  );
  const appReady = useStartupSettled();

  return shouldShowUiLayoutOnboarding({
    onboardingCompleted: preference.onboardingCompleted,
    isDesktopApp,
    isEmbedded: input.isEmbedded,
    appReady,
  });
}
