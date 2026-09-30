"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ComponentType } from "react";

import type { ChoiceGroupIcon } from "@/components/ui/ChoiceGroup";
import styles from "./BrowserPanel.module.css";

/** サイトのアイコン (data URL) を返す。取得できなければ null。 */
export type SiteIconLoader = (url: string) => Promise<string | null>;

type SiteIcons = Readonly<Record<string, string>>;
type FallbackIcon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const SiteIconsContext = createContext<SiteIcons>({});
export const SiteIconsProvider = SiteIconsContext.Provider;

/** 取得できたアイコンは、アプリを開いている間使い回す。新しいタブを開くたびに取り直さない。 */
const loaded = new Map<string, string>();

/**
 * 開始ページに並べるサイトのアイコンを取りに行く。取得は順不同で、届いたものから表に載る。
 * 取得できなかったサイトは載らないので、呼び出し側は代わりのアイコンを出す。`urls` は安定した配列を渡す。
 */
export function useSiteIcons(urls: readonly string[], load: SiteIconLoader | undefined): SiteIcons {
  const [icons, setIcons] = useState<SiteIcons>(() => Object.fromEntries(urls.flatMap((url) => {
    const cached = loaded.get(url);
    return cached ? [[url, cached]] : [];
  })));

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    for (const url of urls) {
      if (loaded.has(url)) continue;
      load(url).then((dataUrl) => {
        if (!dataUrl) return;
        loaded.set(url, dataUrl);
        if (!cancelled) setIcons((current) => ({ ...current, [url]: dataUrl }));
      }, () => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [load, urls]);

  return icons;
}

/** サイト本物のアイコン。まだ取得できていない、または取得できないときは、用途を表す `fallback` を出す。 */
export function SiteIcon({ url, fallback: Fallback, size = 18, className }: {
  url: string;
  fallback: FallbackIcon;
  size?: number;
  className?: string;
}) {
  const src = useContext(SiteIconsContext)[url];
  if (!src) return <Fallback size={size} className={className} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- メイン側で取得した data URL
    <img className={[styles.siteIcon, className].filter(Boolean).join(" ")} src={src} width={size} height={size} alt="" aria-hidden="true" />
  );
}

/** `ChoiceGroup` の選択肢に渡すための、特定のサイトのアイコン。コンポーネントの同一性が変わらないよう、モジュールで1度だけ作る。 */
export function createSiteIcon(url: string, fallback: FallbackIcon): ChoiceGroupIcon {
  return function SiteChoiceIcon({ size, className }) {
    return <SiteIcon url={url} fallback={fallback} size={size} className={className} />;
  };
}
