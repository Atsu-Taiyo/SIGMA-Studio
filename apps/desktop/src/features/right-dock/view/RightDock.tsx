"use client";

import { Globe, LayoutGrid, PanelRight, Plus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

import { IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";
import {
  clampRightDockWidth,
  RIGHT_DOCK_DEFAULT_WIDTH,
  type RightDockPageKind,
} from "../model/right-dock-state";
import styles from "./RightDock.module.css";
import { RIGHT_DOCK_TOOL_ICONS } from "./RightDockHub";

/** タブ列に並べる1枚のタブ。名前やアイコンはページの種類ごとに呼び出し側が決める。 */
export interface RightDockTabItem {
  id: string;
  kind: RightDockPageKind;
  label: string;
  /** ブラウザのページのファビコン (data URL)。無ければ種類のアイコンを出す。 */
  iconUrl?: string | null;
}

export interface RightDockProps {
  open: boolean;
  items: readonly RightDockTabItem[];
  activeId: string | null;
  width: number;
  /** 各面。見せている間だけ表に出し、ファイル・ブラウザはタブがある間、隠れても中身の状態を保つ。 */
  hub: ReactNode;
  files: ReactNode;
  browser: ReactNode;
  /** サイドチャット。AI面は閉じていても状態を持つので、タブが無くても隠すだけで維持する。 */
  chat: ReactNode;
  onSelect(id: string): void;
  /** タブの × 。 */
  onClosePage(id: string): void;
  /** 「+」。Hub を開く。 */
  onNewTab(): void;
  /** 右上の ×。タブは残したままサイドバーだけを閉じる。 */
  onCollapse(): void;
  onResize(width: number): void;
}

function TabIcon({ item }: { item: RightDockTabItem }) {
  if (item.kind === "browser") {
    // eslint-disable-next-line @next/next/no-img-element -- ネイティブ側で取得した data URL
    if (item.iconUrl) return <img className={styles.favicon} src={item.iconUrl} alt="" aria-hidden="true" />;
    return <Globe size={14} className={styles.tabIcon} aria-hidden="true" />;
  }
  const Icon = item.kind === "hub" ? LayoutGrid : RIGHT_DOCK_TOOL_ICONS[item.kind];
  return <Icon size={14} className={styles.tabIcon} aria-hidden="true" />;
}

/**
 * キャンバスの右に並ぶサイドバー。開いているページのタブ列 (「+」で Hub を開く) と、見せている
 * 面を置く枠だけを持ち、各面の中身と状態は呼び出し側 (RightDockHost) の合成に任せる。
 */
export function RightDock({
  open, items, activeId, width, hub, files, browser, chat, onSelect, onClosePage, onNewTab, onCollapse, onResize,
}: RightDockProps) {
  const t = useT("chrome");
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const activeKind = items.find((item) => item.id === activeId)?.kind ?? null;
  const has = (kind: RightDockPageKind) => items.some((item) => item.kind === kind);

  const resizeTo = useCallback((clientX: number) => {
    const viewport = document.documentElement.clientWidth;
    onResize(clampRightDockWidth(viewport - clientX, viewport));
  }, [onResize]);

  const onHandleDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId };
    setDragging(true);
  };
  const onHandleMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) resizeTo(event.clientX);
  };
  const onHandleUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };
  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") onResize(clampRightDockWidth(width + step, document.documentElement.clientWidth));
    else if (event.key === "ArrowRight") onResize(clampRightDockWidth(width - step, document.documentElement.clientWidth));
    else return;
    event.preventDefault();
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    const target = event.key === "ArrowRight" ? (index + 1) % items.length
      : event.key === "ArrowLeft" ? (index - 1 + items.length) % items.length
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = items[target];
    onSelect(next.id);
    event.currentTarget.closest('[role="tablist"]')?.querySelector<HTMLButtonElement>(`[data-page-id="${next.id}"]`)?.focus();
  };

  const panels: Array<[RightDockPageKind, ReactNode, boolean]> = [
    // Hub は選ぶだけの面なので、見せている間だけ描く。
    ["hub", hub, activeKind === "hub"],
    ["files", files, has("files")],
    ["browser", browser, has("browser")],
    // チャットは AI 面の状態を持つので、タブが無くても外から差し込まれた要素を保つ。
    ["chat", chat, true],
  ];
  return (
    // ai-sidebar-panel: グリッド列・z-index・チャットのメニュー用の既存規則をそのまま受け取る。
    <aside
      className={`ai-sidebar-panel right-dock ai-chat-host--sidebar ${styles.dock}${open ? "" : " is-hidden"}`}
      aria-label={t("rightDock.aria")}
      aria-hidden={!open}
      data-right-dock="true"
      data-page={activeKind ?? undefined}
    >
      <button
        type="button"
        className={styles.resizeHandle}
        aria-label={t("rightDock.resize")}
        title={t("rightDock.resize")}
        data-dragging={dragging}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={onHandleKey}
        onDoubleClick={() => onResize(RIGHT_DOCK_DEFAULT_WIDTH)}
      />
      <header className={styles.header}>
        <div className={styles.tabStrip}>
          <div className={styles.tabList} role="tablist" aria-label={t("rightDock.tabs")}>
            {items.map((item, index) => {
              const selected = item.id === activeId;
              return (
                <div key={item.id} className={styles.tab} role="presentation" data-selected={selected}>
                  <button
                    type="button"
                    role="tab"
                    id={`right-dock-tab-${item.id}`}
                    aria-selected={selected}
                    aria-controls={`right-dock-panel-${item.kind}`}
                    tabIndex={selected ? 0 : -1}
                    data-page-id={item.id}
                    data-kind={item.kind}
                    className={styles.tabMain}
                    title={item.label}
                    onClick={() => onSelect(item.id)}
                    onAuxClick={(event) => {
                      // ブラウザのタブと同じく、中クリックで閉じる。
                      if (event.button !== 1) return;
                      event.preventDefault();
                      onClosePage(item.id);
                    }}
                    onKeyDown={(event) => onTabKey(event, index)}
                  >
                    <TabIcon item={item} />
                    <span className={styles.tabTitle}>{item.label}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.tabClose}
                    aria-label={`${t("rightDock.closeTab")}: ${item.label}`}
                    title={t("rightDock.closeTab")}
                    onClick={() => onClosePage(item.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <IconButton label={t("rightDock.newTab")} tone="ghost" size="sm" onClick={onNewTab}>
            <Plus size={15} aria-hidden="true" />
          </IconButton>
        </div>
        <IconButton label={t("rightDock.close")} tone="ghost" size="sm" onClick={onCollapse}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </header>
      <div className={styles.body}>
        {panels.map(([kind, content, mounted]) => (
          <section
            key={kind}
            id={`right-dock-panel-${kind}`}
            role="tabpanel"
            aria-labelledby={activeKind === kind && activeId ? `right-dock-tab-${activeId}` : undefined}
            hidden={activeKind !== kind}
            className={`${styles.panel}${kind === "chat" ? ` ${styles.chatPanel}` : ""}`}
          >
            {mounted ? content : null}
          </section>
        ))}
      </div>
    </aside>
  );
}

export interface RightDockToggleProps {
  onOpen(): void;
}

/** キャンバス右上の入口。ドックを開いている間は、ドック自身の閉じるボタンに任せて出さない。 */
export function RightDockToggle({ onOpen }: RightDockToggleProps) {
  const t = useT("chrome");
  return (
    <div
      className={styles.toggleRoot}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={styles.toggle}
        aria-label={t("rightDock.open")}
        title={t("rightDock.open")}
        onClick={onOpen}
      >
        <PanelRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
