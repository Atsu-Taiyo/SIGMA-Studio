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
 * 起動の流れは「∀ (Turn A) が現れる → 斜めの筆 3 本で Sigma Studio ロゴが現れる」。
 * ∀ は Boost の起動画面と同じ字形。筆は傾き・太さ・長さ・速さが 1 本ずつ違い (長い・中くらい・短い)、
 * 形は CSS の `.startup-splash-stroke.is-*` が持つ。ここが持つのは時間だけ。
 * 区間の長さの出どころはここだけで、`--splash-*` として CSS (`.startup-splash-*`) に渡す。
 *
 * 配布版は教材が開けるまで 0.1〜0.5 秒なので、表示時間はほぼこの演出の長さで決まる。
 * 全体 (現れる〜消え終わる) は約 2 秒までと決めて、それに収めている。
 * 起動が遅いときは演出の後ろでロゴが待つだけで、演出自体は伸びない。
 */
const MARK_IN_MS = 260;
const MARK_HOLD_MS = 300;
/** 筆ごとの開始 (筆の開始時刻からの遅れ) と長さ。2 本目だけ右から左へ進み、一番ゆっくり。 */
const STROKES = [
  { name: "first", startMs: 0, durationMs: 300 },
  { name: "second", startMs: 250, durationMs: 380 },
  { name: "third", startMs: 560, durationMs: 260 },
] as const;
const STROKES_BEGIN_MS = MARK_IN_MS + MARK_HOLD_MS;
const REVEAL_END_MS = STROKES_BEGIN_MS + Math.max(...STROKES.map(({ startMs, durationMs }) => startMs + durationMs));
/** 描き終わったロゴが読み取れる間は残す。 */
const LOGO_HOLD_MS = 220;
/** 動きを減らす設定では ∀ を出さずロゴだけを出す。起動が速くてもチラつかない最短。 */
const STATIC_VISIBLE_MS = 700;
/** Dismiss even if the ready event never arrives (e.g. workspace init hangs). */
export const SPLASH_MAX_VISIBLE_MS = 3500;
export const SPLASH_FADE_OUT_MS = 260;

const LOGO_SRC = "./brand/sigma-studio-splash.png";

const TIMING_VARIABLES = {
  "--splash-mark-in": `${MARK_IN_MS}ms`,
  // ∀ は 2 本目の筆が上を通る間に消える。
  "--splash-mark-out-at": `${STROKES_BEGIN_MS + STROKES[1].startMs}ms`,
  "--splash-mark-out-for": `${STROKES[1].durationMs}ms`,
  "--splash-reveal-end": `${REVEAL_END_MS}ms`,
  "--splash-fade-out": `${SPLASH_FADE_OUT_MS}ms`,
  ...Object.fromEntries(
    STROKES.flatMap(({ startMs, durationMs }, index) => [
      [`--splash-stroke-${index + 1}-at`, `${STROKES_BEGIN_MS + startMs}ms`],
      [`--splash-stroke-${index + 1}-for`, `${durationMs}ms`],
    ]),
  ),
} as CSSProperties;

/**
 * 描き終わってからロゴを残す時間 (ms)。
 *
 * タイマーは hydration 後に数え始めるが、CSS の時間軸は静的 HTML の初回描画から進んでいる。
 * 両者はずれるので、時間ではなくロゴ自身のアニメーション (描き終わりに全面ロゴが現れる) の終了を待つ。
 */
async function holdAfterIntro(logo: HTMLElement | null): Promise<number> {
  const animations = logo?.getAnimations?.();
  if (!animations) return STATIC_VISIBLE_MS;
  if (animations.length > 0) {
    await Promise.allSettled(animations.map((animation) => animation.finished));
    return LOGO_HOLD_MS;
  }
  // アニメーションが無いのは「動きを減らす」設定か、hydration より前に描き終わっているとき。
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
        <div className="startup-splash-logo-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={logoRef} className="startup-splash-logo" src={LOGO_SRC} alt="" draggable={false} />
          {STROKES.map(({ name }) => (
            <span key={name} className={`startup-splash-stroke is-${name}`}>
              <span className="startup-splash-sweep">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={LOGO_SRC} alt="" draggable={false} />
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
