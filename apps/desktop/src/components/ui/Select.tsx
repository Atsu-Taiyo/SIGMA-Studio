"use client";

import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

import styles from "./Select.module.css";

/** Layout effects must not run during SSR; fall back to a no-op effect on the server. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const VIEWPORT_MARGIN_PX = 8;
const TYPEAHEAD_RESET_MS = 700;

export interface SelectOption {
  value: string;
  label: string;
  /** Shown instead of `label` inside the menu when the option needs richer content. */
  content?: ReactNode;
  disabled?: boolean;
  /** Per-option preview styling, e.g. a font family sample. */
  style?: CSSProperties;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export type SelectItem = SelectOption | SelectOptionGroup;

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectItem[];
  disabled?: boolean;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  /** Applied to the trigger, so screen-level CSS keeps sizing the control as it did the `select`. */
  className?: string;
  style?: CSSProperties;
  id?: string;
  title?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
  /**
   * `auto` (default) は幅をトリガー以上・内容なりにする (ネイティブの select と同じで、
   * 狭いツールバーのコントロールでも選択肢が省略されない)。`trigger` はトリガー幅に固定する。
   */
  menuWidth?: "trigger" | "auto";
}

function isGroup(item: SelectItem): item is SelectOptionGroup {
  return Array.isArray((item as SelectOptionGroup).options);
}

function flattenOptions(items: SelectItem[]): SelectOption[] {
  return items.flatMap((item) => (isGroup(item) ? item.options : [item]));
}

/** Pairs every item with the flat option index its first option occupies. */
function withStartIndexes(items: SelectItem[]): Array<{ item: SelectItem; startIndex: number }> {
  const result: Array<{ item: SelectItem; startIndex: number }> = [];
  let startIndex = 0;
  for (const item of items) {
    result.push({ item, startIndex });
    startIndex += isGroup(item) ? item.options.length : 1;
  }
  return result;
}

function findEnabledIndex(options: SelectOption[], from: number, step: number): number {
  for (let index = from; index >= 0 && index < options.length; index += step) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

/**
 * The app's only dropdown. A native `<select>` hands the list to the OS, which paints it in the
 * platform's own language and changes shape per platform; this keeps the list inside the product
 * (see docs/design-rules.md > Controls > Selects And Pickers).
 *
 * Focus stays on the trigger while the menu is open and the active option is published through
 * `aria-activedescendant`, so the portalled list never has to steal focus from the caller.
 */
export function Select({
  value,
  onChange,
  options,
  disabled = false,
  placeholder,
  className,
  style,
  id,
  title,
  menuWidth = "auto",
  ...aria
}: SelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef<{ query: string; timer: ReturnType<typeof setTimeout> | null }>({
    query: "",
    timer: null,
  });
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  const flatOptions = flattenOptions(options);
  const selectedIndex = flatOptions.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? flatOptions[selectedIndex] : undefined;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback((initialIndex: number) => {
    if (disabled) return;
    setActiveIndex(initialIndex);
    setOpen(true);
  }, [disabled]);

  const commit = useCallback((index: number) => {
    const option = flatOptions[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  }, [closeMenu, flatOptions, onChange, value]);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setPortalHost(null);
      setMenuStyle(null);
      return;
    }
    // Menus opened from inside a modal are portalled into that modal's backdrop so the modal's
    // focus isolation keeps treating them as its own content.
    setPortalHost(triggerRef.current?.closest<HTMLElement>("[data-modal-backdrop]") ?? document.body);
  }, [open]);

  useIsomorphicLayoutEffect(() => {
    if (!open || !portalHost) return;
    const trigger = triggerRef.current;
    if (!trigger) return;

    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const menuWidthPx = menuRef.current?.offsetWidth ?? rect.width;
      const below = rect.bottom + 4;
      const above = rect.top - 4 - menuHeight;
      const fitsBelow = below + menuHeight <= window.innerHeight - VIEWPORT_MARGIN_PX;
      const top = fitsBelow
        ? below
        : Math.max(VIEWPORT_MARGIN_PX, above >= VIEWPORT_MARGIN_PX ? above : below);
      const maxLeft = window.innerWidth - VIEWPORT_MARGIN_PX - menuWidthPx;
      setMenuStyle({
        position: "fixed",
        top,
        left: Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, Math.max(VIEWPORT_MARGIN_PX, maxLeft))),
        ...(menuWidth === "trigger" ? { width: rect.width } : { minWidth: rect.width }),
        maxHeight: Math.max(
          120,
          (fitsBelow ? window.innerHeight - below : rect.top - 4) - VIEWPORT_MARGIN_PX,
        ),
      });
    };

    update();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (menuRef.current) resizeObserver?.observe(menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [menuWidth, open, portalHost]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    // 呼び出し元のフォーカスを奪わない画面もあるので、Escape はドキュメントでも受ける。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => () => {
    if (typeaheadRef.current.timer !== null) clearTimeout(typeaheadRef.current.timer);
  }, []);

  const runTypeahead = (key: string) => {
    const typeahead = typeaheadRef.current;
    if (typeahead.timer !== null) clearTimeout(typeahead.timer);
    typeahead.query += key.toLowerCase();
    typeahead.timer = setTimeout(() => {
      typeahead.query = "";
      typeahead.timer = null;
    }, TYPEAHEAD_RESET_MS);
    const match = flatOptions.findIndex((option) => (
      !option.disabled && option.label.toLowerCase().startsWith(typeahead.query)
    ));
    if (match < 0) return;
    if (open) setActiveIndex(match);
    else commit(match);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const step = (offset: number) => {
      event.preventDefault();
      // 閉じた状態の矢印キーは「開く」だけ。ネイティブの select と違い、開かずに値が変わることはない。
      if (!open) {
        openMenu(selectedIndex >= 0 ? selectedIndex : findEnabledIndex(flatOptions, 0, 1));
        return;
      }
      const from = activeIndex >= 0 ? activeIndex : selectedIndex;
      const next = findEnabledIndex(
        flatOptions,
        from < 0 ? (offset > 0 ? 0 : flatOptions.length - 1) : from + offset,
        offset,
      );
      if (next >= 0) setActiveIndex(next);
    };

    switch (event.key) {
      case "ArrowDown":
        step(1);
        return;
      case "ArrowUp":
        step(-1);
        return;
      case "Home":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(findEnabledIndex(flatOptions, 0, 1));
        return;
      case "End":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(findEnabledIndex(flatOptions, flatOptions.length - 1, -1));
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!open) openMenu(selectedIndex >= 0 ? selectedIndex : findEnabledIndex(flatOptions, 0, 1));
        else commit(activeIndex);
        return;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      case "Tab":
        if (open) closeMenu(false);
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          runTypeahead(event.key);
        }
    }
  };

  const renderOption = (option: SelectOption, index: number) => {
    const isSelected = option.value === value;
    return (
      <div
        key={option.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        className={styles.option}
        data-option-index={index}
        data-value={option.value}
        data-active={index === activeIndex}
        data-disabled={option.disabled || undefined}
        style={option.style}
        onPointerMove={() => {
          if (!option.disabled && index !== activeIndex) setActiveIndex(index);
        }}
        onClick={() => commit(index)}
      >
        <Check className={styles.check} size={13} aria-hidden="true" data-visible={isSelected} />
        <span className={styles.optionLabel}>{option.content ?? option.label}</span>
      </div>
    );
  };

  return (
    <>
      <button
        {...aria}
        ref={triggerRef}
        type="button"
        id={id}
        title={title}
        className={["ui-select", styles.trigger, className].filter(Boolean).join(" ")}
        style={style}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        disabled={disabled}
        data-ui-select-open={open || undefined}
        // The menu only exists while it is open, so the closed trigger is the one place the
        // current value and the size of the list can be observed (DOM signature specs read these).
        data-value={value}
        data-option-count={flatOptions.length}
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (open) closeMenu(false);
          else openMenu(selectedIndex >= 0 ? selectedIndex : findEnabledIndex(flatOptions, 0, 1));
        }}
      >
        <span className={styles.value} data-placeholder={selected ? undefined : true}>
          {selected?.label ?? placeholder ?? ""}
        </span>
        <ChevronDown className={styles.chevron} size={13} aria-hidden="true" />
      </button>
      {open && portalHost ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          className={`ui-select-menu ${styles.menu}`}
          // Measured off-screen on the first pass so it can be positioned without flashing.
          style={menuStyle ?? { position: "fixed", top: -9999, left: -9999 }}
        >
          {withStartIndexes(options).map(({ item, startIndex }) => (isGroup(item) ? (
            <div key={`group-${item.label}`} role="group" aria-label={item.label} className={styles.group}>
              <div className={styles.groupLabel} aria-hidden="true">{item.label}</div>
              {item.options.map((option, offset) => renderOption(option, startIndex + offset))}
            </div>
          ) : renderOption(item, startIndex)))}
        </div>,
        portalHost,
      ) : null}
    </>
  );
}
