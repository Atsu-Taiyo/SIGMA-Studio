"use client";

import { ChevronDown, ChevronRight, Eye, EyeOff, Plus } from "lucide-react";
import { Children, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { GraphItemActionsMenu } from "./GraphItemActionsMenu";
import { IconButton } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import styles from "./GraphSettingsControls.module.css";

/** Keep DOM/tab order, while short cards use only the rows their content needs. */
export function GraphCardGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      for (const cell of grid.children) {
        const content = cell.firstElementChild;
        if (!(cell instanceof HTMLElement) || !content) continue;
        const rows = Math.max(1, Math.ceil((content.getBoundingClientRect().height + gap) / (1 + gap)));
        const span = `span ${rows}`;
        if (cell.style.gridRowEnd !== span) cell.style.gridRowEnd = span;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const cell of grid.children) if (cell.firstElementChild) observer.observe(cell.firstElementChild);
    return () => observer.disconnect();
  }, [children]);
  return <div ref={ref} className={`${styles.cardGrid} ${className}`} data-graph-card-grid>
    {Children.toArray(children).map((child, index) => <div className={styles.gridCell} key={typeof child === "object" && child && "key" in child ? child.key : index}>{child}</div>)}
  </div>;
}

export function GraphSettingsSection({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="editor-settings-accordion">
      <button
        type="button"
        className="editor-settings-accordion-header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span className="editor-settings-accordion-title">{title}</span>
        {count !== undefined && count > 0 && <span className="editor-settings-accordion-count">{count}</span>}
      </button>
      {open && <Stack className="editor-settings-accordion-body" id={bodyId} gap="sm">{children}</Stack>}
    </section>
  );
}

/**
 * The "add one more" tile.
 *
 * It sits in the grid where the next card will appear, rather than under it as a button: with four
 * sections stacked, an add button below each list put the control furthest from the cards it adds
 * to, and pushed the next section off the panel.
 */
export function GraphAddCard({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.addCard} disabled={disabled} onClick={onClick}>
      <Plus size={17} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function GraphWidgetCard({
  label,
  title,
  summary,
  controls,
  headerAction,
  visibility,
  openDetailsOnCardHover = false,
  children,
}: {
  label: string;
  title: ReactNode;
  summary?: ReactNode;
  controls?: ReactNode;
  headerAction?: ReactNode;
  visibility?: { visible: boolean; onChange: (visible: boolean) => void };
  openDetailsOnCardHover?: boolean;
  children: ReactNode;
}) {
  const tShape = useT("shape");
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hidden = visibility?.visible === false;
  return (
    <div
      ref={cardRef}
      className={[styles.card, "graph-curve-editor", hidden ? styles.cardHidden : ""].filter(Boolean).join(" ")}
    >
      <Inline gap="sm" justify="between">
        <div className={styles.widgetTitle}>{title}</div>
        <Inline className={styles.cardHeaderActions} gap="xs">
          {headerAction}
          {visibility && (
            <IconButton
              label={tShape("graph3dUi.displaySection")}
              tooltip={{ label: visibility.visible ? tShape("graph3dUi.visible") : tShape("graph3dUi.hidden") }}
              size="sm"
              tone="ghost"
              aria-pressed={visibility.visible}
              onClick={() => visibility.onChange(!visibility.visible)}
            >
              {visibility.visible
                ? <Eye size={15} aria-hidden="true" />
                : <EyeOff size={15} aria-hidden="true" />}
            </IconButton>
          )}
          <span className={visibility ? styles.detailsTriggerHidden : undefined}>
            <GraphItemActionsMenu
              label={label}
              className={styles.detailsPopover}
              hoverAnchorRef={openDetailsOnCardHover ? cardRef : undefined}
              onCloseNestedMenus={() => undefined}
            >
              <Stack className={styles.detailsContent} gap="sm">
                {children}
              </Stack>
            </GraphItemActionsMenu>
          </span>
        </Inline>
      </Inline>
      {summary}
      {controls && <div className={styles.quickControls}>{controls}</div>}
    </div>
  );
}
