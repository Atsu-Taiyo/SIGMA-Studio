"use client";

import { Files, Globe, MessageSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useT } from "@/lib/i18n/react";
import { RIGHT_DOCK_TOOLS, type RightDockTool } from "../model/right-dock-state";
import styles from "./RightDockHub.module.css";
import { QUICK_LINK_URLS, QuickLinkTiles } from "./QuickLinks";
import { SiteIconsProvider, useSiteIcons, type SiteIconLoader } from "./use-site-icons";

export const RIGHT_DOCK_TOOL_ICONS: Record<RightDockTool, LucideIcon> = {
  files: Files,
  browser: Globe,
  chat: MessageSquare,
};

export interface RightDockHubProps {
  /** ブラウザを使えないとき (デスクトップ版以外) は、ブラウザとおすすめのサイトを出さない。 */
  browserAvailable: boolean;
  onChoose(tool: RightDockTool): void;
  onOpenSite(url: string): void;
  /** サイトのアイコンの取得。渡さなければ、代わりのアイコンだけを出す。 */
  loadSiteIcon?: SiteIconLoader;
  /** 選べなかった理由など、直前の操作の結果。 */
  notice?: string | null;
}

/**
 * 「+」で開く新しいタブ。ファイル・ブラウザ・サイドチャットのどれを開くかを選ぶだけの入口で、
 * 選ぶとこのタブがその面に置き換わる。並びのタブ列を固定の3つで埋めずに済むよう、面を足す入口はここ1つにする。
 */
export function RightDockHub({ browserAvailable, onChoose, onOpenSite, loadSiteIcon, notice }: RightDockHubProps) {
  const t = useT("chrome");
  const icons = useSiteIcons(QUICK_LINK_URLS, browserAvailable ? loadSiteIcon : undefined);
  const tools = RIGHT_DOCK_TOOLS.filter((tool) => tool !== "browser" || browserAvailable);
  return (
    <SiteIconsProvider value={icons}>
      <div className={styles.hub}>
        <section className={styles.section} aria-labelledby="right-dock-hub-tools">
          <h2 id="right-dock-hub-tools" className={styles.heading}>{t("rightDock.hub.tools")}</h2>
          <ul className={styles.tools}>
            {tools.map((tool) => {
              const Icon = RIGHT_DOCK_TOOL_ICONS[tool];
              return (
                <li key={tool}>
                  <button type="button" className={styles.tool} data-tool={tool} onClick={() => onChoose(tool)}>
                    <Icon size={16} aria-hidden="true" />
                    <span>{t(`rightDock.tab.${tool}`)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {notice && <p className={styles.notice} role="status">{notice}</p>}
        </section>
        {browserAvailable && (
          <section className={styles.section} aria-labelledby="right-dock-hub-recommended">
            <h2 id="right-dock-hub-recommended" className={styles.heading}>{t("rightDock.hub.recommended")}</h2>
            <QuickLinkTiles onOpen={onOpenSite} />
          </section>
        )}
      </div>
    </SiteIconsProvider>
  );
}
