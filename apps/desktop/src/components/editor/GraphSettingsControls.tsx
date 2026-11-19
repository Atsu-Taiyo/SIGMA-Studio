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
  collapsedNotice,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /**
   * Shown under the header only while the section is collapsed, so a problem inside stays visible.
   * Pass "" when there is nothing to say: the live region stays mounted for sections that use it.
   */
  collapsedNotice?: string;
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
      {/* live region は常にマウントし、畳んでいる間だけ文言を入れる (挿入と同時の読み上げは不安定)。 */}
      {collapsedNotice !== undefined && (
        <p
          className="editor-settings-accordion-notice"
          role="status"
          data-empty={!open && collapsedNotice ? undefined : "true"}
        >
          {!open && collapsedNotice ? collapsedNotice : ""}
        </p>
      )}
      {open && <Stack className="editor-settings-accordion-body" id={bodyId} gap="sm">{children}</Stack>}
    </section>
  );
}

/**
 * One "label | controls" row of the graph settings panel.
 *
 * Every setting in the 2D graph panel — a function's expression, type, line style and domain, and
 * the graph's ranges, ticks and axes — is laid out with this row, so the label column lines up
 * across cards and sections and each control sits next to the word that names it. Before, the line
 * style lived in a hover popover, the function type and domain behind a "details" disclosure, and
 * the ranges in a separate collapsed section with stacked headings: three different patterns for
 * what is one list of settings.
 *
 * With `htmlFor` the label is a real `<label>` for a single control. Otherwise the row is a named
 * group (`role="group"` + `aria-labelledby`), so a screen reader announces the row name before the
 * controls inside it, which keep their own specific names.
 */
export function GraphFieldRow({
  label,
  htmlFor,
  groupLabel,
  testId,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  /** Overrides the group name when the visible word alone is too short out of context. */
  groupLabel?: string;
  testId?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  if (htmlFor) {
    return (
      <div className={styles.fieldRow} data-graph-field-row="" data-testid={testId}>
        <label id={labelId} className={styles.fieldLabel} htmlFor={htmlFor}>{label}</label>
        <div className={styles.fieldControl}>{children}</div>
      </div>
    );
  }
  return (
    <div
      className={styles.fieldRow}
      role="group"
      aria-labelledby={groupLabel ? undefined : labelId}
      aria-label={groupLabel}
      data-graph-field-row=""
      data-testid={testId}
    >
      <span id={labelId} className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  );
}

/**
 * A titled run of `GraphFieldRow`s inside a section (e.g. 範囲 / 目盛 / 軸 under 座標軸と範囲).
 *
 * The title is a heading, not a group name: the group words (目盛) repeat the names of controls
 * inside (the 目盛 checkbox), and a same-named group around them would make "目盛" ambiguous to
 * assistive tech and to label lookups. Headings still give heading navigation.
 */
export function GraphFieldGroup({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldGroup} data-testid={testId}>
      <h3 className={styles.fieldGroupTitle}>{title}</h3>
      {children}
    </div>
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
