"use client";

import { useEffect, useState } from "react";

export const APP_READY_EVENT = "sigma-studio:app-ready";

/**
 * スプラッシュが画面に居るかを外から確かめるための目印。
 * クラス名ではなく専用の属性にしているのは、`.startup-splash` が数式サニタイザで
 * 「画面全体を覆えるクラス」として警戒対象になっている名前だから (math-markup.ts)。
 */
export const SPLASH_MARKER_ATTRIBUTE = "data-startup-splash";

/** Keep the logo on screen long enough to avoid a flash on fast startups. */
const MIN_VISIBLE_MS = 700;
/** Dismiss even if the ready event never arrives (e.g. workspace init hangs). */
export const SPLASH_MAX_VISIBLE_MS = 3500;
/** Must match the `.startup-splash` opacity transition in globals.css. */
export const SPLASH_FADE_OUT_MS = 360;

export function StartupSplash() {
  const [phase, setPhase] = useState<"visible" | "leaving" | "hidden">("visible");

  useEffect(() => {
    let appReady = false;
    let minElapsed = false;
    let leaveTimeoutId = 0;

    const leaveIfReady = () => {
      if (appReady && minElapsed) {
        setPhase((current) => (current === "visible" ? "leaving" : current));
        leaveTimeoutId = window.setTimeout(() => setPhase("hidden"), SPLASH_FADE_OUT_MS);
      }
    };

    const handleAppReady = () => {
      appReady = true;
      leaveIfReady();
    };

    const minTimeoutId = window.setTimeout(() => {
      minElapsed = true;
      leaveIfReady();
    }, MIN_VISIBLE_MS);
    const maxTimeoutId = window.setTimeout(() => {
      appReady = true;
      minElapsed = true;
      leaveIfReady();
    }, SPLASH_MAX_VISIBLE_MS);

    window.addEventListener(APP_READY_EVENT, handleAppReady);
    return () => {
      window.removeEventListener(APP_READY_EVENT, handleAppReady);
      window.clearTimeout(minTimeoutId);
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
      aria-hidden="true"
      {...{ [SPLASH_MARKER_ATTRIBUTE]: "" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="startup-splash-logo" src="./brand/sigma-studio-splash.png" alt="" draggable={false} />
    </div>
  );
}
