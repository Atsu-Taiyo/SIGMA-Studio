"use client";

import { Globe, PanelRightOpen, Plus, X } from "lucide-react";
import { useId } from "react";

import { IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";
import type { RightDockTabItem } from "./RightDock";
import { RIGHT_DOCK_TOOL_ICONS } from "./RightDockHub";
import styles from "./RightDockPeek.module.css";

/** カードに並べるウェブページの数。これを超えたぶんは「すべて表示」でサイドバーを開いて見る。 */
export const RIGHT_DOCK_PEEK_WEB_LIMIT = 4;

export interface RightDockPeekProps {
  /** サイドバーの中のページ。Hub は選ぶだけの面なので含めない。 */
  items: readonly RightDockTabItem[];
  /** そのページを見せた状態でサイドバーを開く。 */
  onOpenPage(id: string): void;
  /** ウェブの「+」。サイドバーを開いて新しいタブ (Hub) を出す。 */
  onNewWebPage(): void;
  /** 「すべて表示」。最後に見ていたページでサイドバーを開く。 */
  onShowAll(): void;
  onDismiss(): void;
  /** コメントのカードと同じ並びの中に置く (固定位置にしない)。 */
  docked?: boolean;
  /** 並びが小さなアイコンだけのとき。カードの代わりに、ウェブの数を添えたサイドバーのボタンだけを出す。 */
  compact?: boolean;
}

function PageIcon({ item }: { item: RightDockTabItem }) {
  if (item.kind === "browser" && item.iconUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- ネイティブ側で取得した data URL
    return <img className={styles.favicon} src={item.iconUrl} alt="" aria-hidden="true" />;
  }
  const Icon = item.kind === "browser" || item.kind === "hub" ? Globe : RIGHT_DOCK_TOOL_ICONS[item.kind];
  return <Icon size={16} className={styles.icon} aria-hidden="true" />;
}

function PageRow({ item, onOpen }: { item: RightDockTabItem; onOpen(id: string): void }) {
  return (
    <li>
      <button type="button" className={styles.row} data-kind={item.kind} title={item.label} onClick={() => onOpen(item.id)}>
        <PageIcon item={item} />
        <span className={styles.label}>{item.label}</span>
      </button>
    </li>
  );
}

/**
 * サイドバーを閉じていても、中にウェブのページが開いているときだけ出す小さなカード。
 * 何が開いているかを閉じたまま見せ、選ぶとそのページでサイドバーを開く。
 */
export function RightDockPeek({ items, onOpenPage, onNewWebPage, onShowAll, onDismiss, docked = false, compact = false }: RightDockPeekProps) {
  const t = useT("chrome");
  const webHeadingId = useId();
  const web = items.filter((item) => item.kind === "browser");
  const others = items.filter((item) => item.kind !== "browser");
  if (compact) {
    return (
      <button
        type="button"
        className={styles.compactButton}
        data-right-dock-peek="true"
        aria-label={t("rightDock.peek.compact", { count: web.length })}
        title={t("rightDock.peek.compact", { count: web.length })}
        onClick={onShowAll}
      >
        <Globe size={16} aria-hidden="true" />
        <span className={styles.count} aria-hidden="true">{web.length}</span>
      </button>
    );
  }
  return (
    <div className={`${styles.peek}${docked ? ` ${styles.docked}` : ""}`} role="region" aria-label={t("rightDock.peek.aria")} data-right-dock-peek="true">
      <header className={styles.header}>
        <h2 className={styles.title}>{t("rightDock.peek.title")}</h2>
        <IconButton label={t("rightDock.peek.dismiss")} tone="ghost" size="sm" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </header>
      {others.length > 0 && (
        <ul className={styles.list}>
          {others.map((item) => <PageRow key={item.id} item={item} onOpen={onOpenPage} />)}
        </ul>
      )}
      <section className={styles.section} aria-labelledby={webHeadingId}>
        <div className={styles.sectionHeader}>
          <h3 id={webHeadingId} className={styles.heading}>{t("rightDock.peek.web")}</h3>
          <IconButton label={t("rightDock.newTab")} tone="ghost" size="sm" onClick={onNewWebPage}>
            <Plus size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <ul className={styles.list}>
          {web.slice(0, RIGHT_DOCK_PEEK_WEB_LIMIT).map((item) => <PageRow key={item.id} item={item} onOpen={onOpenPage} />)}
        </ul>
      </section>
      <button type="button" className={`${styles.row} ${styles.showAll}`} onClick={onShowAll}>
        <PanelRightOpen size={16} className={styles.icon} aria-hidden="true" />
        <span className={styles.label}>{t("rightDock.peek.showAll")}</span>
      </button>
    </div>
  );
}
