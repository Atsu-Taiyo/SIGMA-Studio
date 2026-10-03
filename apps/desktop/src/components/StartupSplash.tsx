"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

export const APP_READY_EVENT = "sigma-studio:app-ready";

/**
 * スプラッシュが画面に居るかを外から確かめるための目印。
 * クラス名ではなく専用の属性にしているのは、`.startup-splash` が数式サニタイザで
 * 「画面全体を覆えるクラス」として警戒対象になっている名前だから (math-markup.ts)。
 */
export const SPLASH_MARKER_ATTRIBUTE = "data-startup-splash";

/**
 * 起動の流れは Boost と同じ「∀ (Turn A) が現れる → 180° 回って Sigma Studio に入れ替わる」。
 * 区間の長さの出どころはここだけで、`--splash-*` として CSS (`.startup-splash-*`) に渡す。
 *
 * 配布版は教材が開けるまで 0.1 秒ほどなので、表示時間はほぼこの演出の長さで決まる。
 * 全体 (現れる〜消え終わる) を、これまでの最短表示 (700ms + 消える 360ms) と同じ約 1 秒に収める。
 * 起動が遅いときは演出の後ろでロゴが待つだけで、演出自体は伸びない。
 */
const MARK_IN_MS = 200;
const MARK_HOLD_MS = 120;
const TURN_MS = 420;
/** 入れ替わったロゴが読み取れる間は残す。消え始めの間も見えているので短くてよい。 */
const LOGO_HOLD_MS = 80;
/** 動きを減らす設定では ∀ を出さずロゴだけを出す。起動が速くてもチラつかない最短。 */
const STATIC_VISIBLE_MS = 700;
/** Dismiss even if the ready event never arrives (e.g. workspace init hangs). */
export const SPLASH_MAX_VISIBLE_MS = 3500;
export const SPLASH_FADE_OUT_MS = 260;

const TIMING_VARIABLES = {
  "--splash-mark-in": `${MARK_IN_MS}ms`,
  "--splash-mark-hold": `${MARK_HOLD_MS}ms`,
  "--splash-turn": `${TURN_MS}ms`,
  "--splash-fade-out": `${SPLASH_FADE_OUT_MS}ms`,
} as CSSProperties;

/**
 * 入れ替わりが終わってからロゴを残す時間 (ms)。
 *
 * タイマーは hydration 後に数え始めるが、CSS の時間軸は静的 HTML の初回描画から進んでいる。
 * 両者はずれるので、時間ではなくロゴ自身のアニメーションの終了を待つ。
 */
async function holdAfterIntro(logo: HTMLElement | null): Promise<number> {
  const animations = logo?.getAnimations?.();
  if (!animations) return STATIC_VISIBLE_MS;
  if (animations.length > 0) {
    await Promise.allSettled(animations.map((animation) => animation.finished));
    return LOGO_HOLD_MS;
  }
  // アニメーションが無いのは「動きを減らす」設定か、hydration より前に入れ替わり済みのとき。
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? STATIC_VISIBLE_MS : 0;
}

export function StartupSplash() {
  const [phase, setPhase] = useState<"visible" | "leaving" | "hidden">("visible");
  const logoRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let appReady = false;
    let introDone = false;
    let leaving = false;
    let disposed = false;
    let holdTimeoutId = 0;
    let leaveTimeoutId = 0;

    const leaveIfReady = () => {
      if (leaving || !appReady || !introDone) return;
      leaving = true;
      setPhase("leaving");
      leaveTimeoutId = window.setTimeout(() => setPhase("hidden"), SPLASH_FADE_OUT_MS);
    };

    const handleAppReady = () => {
      appReady = true;
      leaveIfReady();
    };

    // 入れ替わりの途中でロゴを描き直すと一瞬欠けるので、先にデコードしておく。
    logoRef.current?.decode().catch(() => undefined);
    void holdAfterIntro(logoRef.current).then((holdMs) => {
      if (disposed) return;
      holdTimeoutId = window.setTimeout(() => {
        introDone = true;
        leaveIfReady();
      }, holdMs);
    });
    const maxTimeoutId = window.setTimeout(() => {
      appReady = true;
      introDone = true;
      leaveIfReady();
    }, SPLASH_MAX_VISIBLE_MS);

    window.addEventListener(APP_READY_EVENT, handleAppReady);
    return () => {
      disposed = true;
      window.removeEventListener(APP_READY_EVENT, handleAppReady);
      window.clearTimeout(holdTimeoutId);
      window.clearTimeout(maxTimeoutId);
      window.clearTimeout(leaveTimeoutId);
    };
  }, []);

  if (phase === "hidden") {
    return null;
  }

  return (
    <div
      className={`startup-splash ${phase === "leaving" ? "is-leaving" : ""}`}
      style={TIMING_VARIABLES}
      aria-hidden="true"
      {...{ [SPLASH_MARKER_ATTRIBUTE]: "" }}
    >
      <div className="startup-splash-stage">
        {/* Turn A (∀)。Boost の起動画面と同じ字形を、フォントに依らないよう輪郭で持つ。 */}
        <svg className="startup-splash-mark" viewBox="0 0 771 840" focusable="false">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M110 0 217.5 227H553.5L661 0 771 50.5 385.5 840 0 50.5ZM268.5 334 385.5 589 503 334Z"
          />
        </svg>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={logoRef}
          className="startup-splash-logo"
          src="./brand/sigma-studio-splash.png"
          alt=""
          draggable={false}
        />
      </div>
    </div>
  );
}
