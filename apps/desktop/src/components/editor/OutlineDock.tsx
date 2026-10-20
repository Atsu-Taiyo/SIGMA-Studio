"use client";

import { ListTree, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useT } from "@/lib/i18n/react";
import type { OutlineNavigationItem } from "@/lib/outline-navigation";

import styles from "./OutlineDock.module.css";

/** ポインタが外れてから畳むまでの猶予。ボタンとカードの隙間を渡る間に閉じないため。 */
const CLOSE_DELAY_MS = 100;

/** 開く要求のあと、カードの行が描かれるのを待つ最大のフレーム数。 */
const FOCUS_RETRY_FRAMES = 30;

interface OutlineDockProps {
  items: readonly OutlineNavigationItem[];
  /** いま選ばれているブロック。見出しならその行を強調する。 */
  selectedId: string | null;
  onSelectItem: (blockId: string) => void;
  /**
   * 値が増えるたびに開いて、強調中 (無ければ先頭) の行へフォーカスを移す。コマンドパレットの
   * 「アウトラインを表示」のように、ポインタを使わずに開きたい入口が使う。
   */
  openRequest?: number;
}

/**
 * 見出し・節・問題の一覧。キャンバス左上の AI タスクの入口 (`AiTaskDock`) の真下に、同じ作法で
 * 置く: 畳んでいる間は丸いアイコン 1 つだけ、ホバー / フォーカスでその場にカードが開き、
 * 外へ出る・Esc・外側のクリックで閉じる。ダイアログではないので背景は暗くせず、開いたまま
 * 本文をスクロールできる。
 */
export function OutlineDock({ items, selectedId, onSelectItem, openRequest = 0 }: OutlineDockProps) {
  const t = useT("editor");
  const tCommon = useT("common");
  const [expanded, setExpanded] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledOpenRequestRef = useRef(openRequest);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const openPanel = useCallback(() => {
    clearCloseTimer();
    setPanelMounted(true);
    setExpanded(true);
  }, [clearCloseTimer]);

  const closePanel = useCallback(() => {
    clearCloseTimer();
    setExpanded(false);
  }, [clearCloseTimer]);

  const scheduleClosePanel = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      // キーボードで中を操作している最中は、ポインタが外れただけでは閉じない。
      if (anchorRef.current?.contains(window.document.activeElement)) {
        return;
      }
      setExpanded(false);
    }, CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  // 開いている間だけ Esc と外側のクリックを見る。
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setExpanded(false);
      // 畳んだアイコンへフォーカスが残っていると、その focus で開き直してしまう。
      const active = window.document.activeElement;
      if (active instanceof HTMLElement && anchorRef.current?.contains(active)) {
        active.blur();
      }
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !anchorRef.current?.contains(target)) {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [expanded]);

  // 開く要求: 開いて、カードが描かれてから強調中 (無ければ先頭) の行へフォーカスを移す。
  // カードは state の更新の次の描画で現れるので、行が見つかるまで数フレーム待つ。
  useEffect(() => {
    if (openRequest === handledOpenRequestRef.current) {
      return;
    }
    handledOpenRequestRef.current = openRequest;
    openPanel();
    let frame = 0;
    let attempts = 0;
    const focusRow = () => {
      const list = listRef.current;
      const target = list?.querySelector<HTMLElement>("[aria-current='location']")
        ?? list?.querySelector<HTMLElement>("button");
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (attempts < FOCUS_RETRY_FRAMES) {
        attempts += 1;
        frame = window.requestAnimationFrame(focusRow);
      }
    };
    frame = window.requestAnimationFrame(focusRow);
    return () => window.cancelAnimationFrame(frame);
  }, [openPanel, openRequest]);

  // 開いたとき、強調中の行がカードの外にあれば見える位置へ送る。
  useLayoutEffect(() => {
    if (panelMounted) {
      listRef.current?.querySelector<HTMLElement>("[aria-current='location']")?.scrollIntoView({ block: "nearest" });
    }
  }, [panelMounted]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) {
      return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) {
      return;
    }
    const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    buttons[next]?.focus();
  };

  const toggleLabel = t("outline.titleWithCount", { replace: { items: items.length } });

  return (
    <div
      className={styles.root}
      ref={anchorRef}
      data-outline-dock=""
      // 入口はキャンバスの中にあるので、そのままだと項目を押した click がキャンバスの
      // 「空きをクリックして選択を解除」へ届き、選んだ見出しの選択がすぐ消える。
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={openPanel}
      onMouseLeave={scheduleClosePanel}
      onFocus={openPanel}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          closePanel();
        }
      }}
    >
      <span className={styles.hoverBridge} aria-hidden="true" />
      <button
        type="button"
        className={`${styles.toggle}${expanded ? ` ${styles.toggleOpen}` : ""}`}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        title={toggleLabel}
      >
        <ListTree size={16} aria-hidden="true" />
      </button>
      {panelMounted && (
        <div
          className={`${styles.motion} ${expanded ? styles.motionExpanded : styles.motionCollapsing}`}
          onAnimationEnd={() => {
            if (!expanded) {
              setPanelMounted(false);
            }
          }}
        >
          <div className={styles.panel} role="region" aria-label={t("outline.title")}>
            <header className={styles.header}>
              <span className={styles.title}>{t("outline.title")}</span>
              <span className={styles.count}>{items.length}</span>
              <button
                type="button"
                className={styles.close}
                onClick={closePanel}
                title={tCommon("actions.close")}
                aria-label={tCommon("actions.close")}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </header>
            <nav className={styles.list} ref={listRef} aria-label={t("outline.title")} onKeyDown={moveFocus}>
              {items.map((item) => {
                const selected = selectedId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.item}${selected ? ` ${styles.itemSelected}` : ""}`}
                    data-kind={item.kind}
                    data-depth={item.depth}
                    style={{ "--outline-depth": item.depth } as CSSProperties}
                    aria-current={selected ? "location" : undefined}
                    title={item.number ? `${item.number} ${item.title}` : item.title}
                    onClick={() => {
                      onSelectItem(item.id);
                      closePanel();
                    }}
                  >
                    {item.number ? <span className={styles.number}>{item.number}</span> : null}
                    <span className={styles.label}>{item.title}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
