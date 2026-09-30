"use client";

import { Compass, Globe, Newspaper, Search, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ChoiceGroup, type ChoiceGroupOption } from "@/components/ui/ChoiceGroup";
import { SEARCH_ENGINES, type SearchEngineId } from "@/lib/browser/in-app-browser-contract";
import { useT } from "@/lib/i18n/react";
import styles from "./BrowserPanel.module.css";
import { QUICK_LINK_URLS, QuickLinkTiles } from "./QuickLinks";
import { createSiteIcon, SiteIconsProvider, useSiteIcons, type SiteIconLoader } from "./use-site-icons";

/** 検索エンジンのトップページと、ロゴを取得できない間の代わりのアイコン。 */
const ENGINE_SITES: Record<SearchEngineId, { url: string; fallback: LucideIcon }> = {
  google: { url: "https://www.google.com", fallback: Search },
  duckduckgo: { url: "https://duckduckgo.com", fallback: ShieldCheck },
  bing: { url: "https://www.bing.com", fallback: Compass },
  "yahoo-japan": { url: "https://www.yahoo.co.jp", fallback: Newspaper },
};

const ENGINE_OPTIONS: readonly ChoiceGroupOption<SearchEngineId>[] = SEARCH_ENGINES.map((engine) => ({
  value: engine.id,
  label: engine.label,
  icon: createSiteIcon(ENGINE_SITES[engine.id].url, ENGINE_SITES[engine.id].fallback),
}));

/** アイコンを取りに行くサイト。同じサイト (Google) はまとめて1回で取る。 */
const ICON_URLS: readonly string[] = [...new Set([
  ...QUICK_LINK_URLS,
  ...Object.values(ENGINE_SITES).map((site) => site.url),
])];

export interface BrowserStartPageProps {
  engineId: SearchEngineId;
  onEngineChange(id: SearchEngineId): void;
  onOpen(url: string): void;
  /** サイトのアイコンの取得。渡さなければ (デスクトップ版以外)、代わりのアイコンだけを出す。 */
  loadSiteIcon?: SiteIconLoader;
}

/** 新しいタブ。検索はアドレス欄に任せ、ここはよく使うサイトと検索エンジンの選択だけを置く。 */
export function BrowserStartPage({ engineId, onEngineChange, onOpen, loadSiteIcon }: BrowserStartPageProps) {
  const t = useT("chrome");
  const icons = useSiteIcons(ICON_URLS, loadSiteIcon);
  return (
    <SiteIconsProvider value={icons}>
      <div className={styles.center}>
        <Globe size={28} aria-hidden="true" color="var(--text-muted)" />
        <h2 className={styles.startHeading}>{t("rightDock.browser.startHeading")}</h2>
        <QuickLinkTiles onOpen={onOpen} />
        {/* ドロップダウンにせず、選択肢をすべてアイコンで見せる。選ぶと次の検索から使われる。 */}
        <div className={styles.engine}>
          <span id="browser-engine-label" className={styles.engineCaption}>{t("rightDock.browser.searchEngine")}</span>
          <ChoiceGroup
            aria-labelledby="browser-engine-label"
            value={engineId}
            onChange={onEngineChange}
            options={ENGINE_OPTIONS}
            columns={4}
          />
        </div>
        <p className={styles.hint}>{t("rightDock.browser.startHint")}</p>
      </div>
    </SiteIconsProvider>
  );
}
