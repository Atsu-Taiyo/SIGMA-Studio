"use client";

import { BookOpen, ChartLine, Search, Shapes, Sigma, SquarePlay } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import styles from "./BrowserPanel.module.css";
import { SiteIcon } from "./use-site-icons";

/**
 * 授業の調べものでよく使うサイト。名前はブランド名なので翻訳しない。
 * アイコンはサイト本物のロゴで、取得できるまで (オフラインを含む) は用途を表す代わりのアイコンを出す。
 * ブラウザの新しいページとサイドバーの Hub (おすすめ) が同じ並びを使う。
 */
const QUICK_LINKS: ReadonlyArray<{ name: string; url: string; icon: LucideIcon }> = [
  { name: "Google", url: "https://www.google.com", icon: Search },
  { name: "Wikipedia", url: "https://ja.wikipedia.org", icon: BookOpen },
  { name: "GeoGebra", url: "https://www.geogebra.org/classic", icon: Shapes },
  { name: "Desmos", url: "https://www.desmos.com/calculator", icon: ChartLine },
  { name: "Wolfram Alpha", url: "https://www.wolframalpha.com", icon: Sigma },
  { name: "YouTube", url: "https://www.youtube.com", icon: SquarePlay },
];

/** アイコンを取りに行くサイト。呼び出し側が安定した配列として使えるよう、モジュールで1度だけ作る。 */
export const QUICK_LINK_URLS: readonly string[] = QUICK_LINKS.map((link) => link.url);

/** 呼び出し側が `SiteIconsProvider` の中に置く。 */
export function QuickLinkTiles({ onOpen }: { onOpen(url: string): void }) {
  return (
    <div className={styles.quickLinks}>
      {QUICK_LINKS.map((link) => (
        <button key={link.url} type="button" className={styles.quickLink} onClick={() => onOpen(link.url)}>
          <span className={styles.quickLinkMark} aria-hidden="true">
            <SiteIcon url={link.url} fallback={link.icon} size={22} />
          </span>
          <span>{link.name}</span>
        </button>
      ))}
    </div>
  );
}
