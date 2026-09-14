"use client";

import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";

const GRID_COLUMNS = 10;
const GRID_ROWS = 8;
const MAX_SIZE = 20;

function validSize(value: string): boolean {
  const number = Number(value);
  return value.trim() !== "" && Number.isInteger(number) && number >= 1 && number <= MAX_SIZE;
}

export function TableInsertGridPicker({
  anchorRect,
  onPick,
  onClose,
}: {
  anchorRect?: { x: number; y: number; width: number; height: number };
  onPick: (columnCount: number, rowCount: number) => void;
  onClose: () => void;
}) {
  const t = useT("shape");
  const tCommon = useT("common");
  const [size, setSize] = useState({ columns: "4", rows: "3" });
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
  const popoverRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const helpId = useId();
  const errorId = useId();
  const rowsValid = validSize(size.rows);
  const columnsValid = validSize(size.columns);
  const valid = rowsValid && columnsValid;
  const rows = rowsValid ? Number(size.rows) : 0;
  const columns = columnsValid ? Number(size.columns) : 0;
  const gridRow = Math.min(GRID_ROWS, Math.max(1, rows));
  const gridColumn = Math.min(GRID_COLUMNS, Math.max(1, columns));

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const updatePosition = () => {
      const { width, height } = popover.getBoundingClientRect();
      const preferredTop = anchorRect ? anchorRect.y + anchorRect.height + 6 : 82;
      const fallbackTop = anchorRect ? anchorRect.y - height - 6 : preferredTop;
      const top = preferredTop + height <= window.innerHeight - 8 ? preferredTop : fallbackTop;
      setPosition({
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(anchorRect?.x ?? 132, window.innerWidth - width - 8)),
      });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(popover);
    window.addEventListener("resize", updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchorRect]);

  useEffect(() => {
    // The shape menu entry disappears when this opens; its supplied anchor is the persistent
    // toolbar button. Direct toolbar and shortcut entry can also use the current focus.
    const anchor = anchorRect
      ? document.elementFromPoint(anchorRect.x + anchorRect.width / 2, anchorRect.y + anchorRect.height / 2)
        ?.closest<HTMLElement>("button")
      : null;
    returnFocusRef.current ??= anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    popoverRef.current?.querySelector<HTMLElement>(".table-insert-grid button[tabindex='0']")?.focus({ preventScroll: true });
  }, [anchorRect]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target)) {
        // Let the clicked control receive focus; do not send it back to the toolbar.
        onClose();
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [onClose]);

  const cancel = () => {
    onClose();
    returnFocusRef.current?.focus({ preventScroll: true });
  };

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, row: number, column: number) => {
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case "ArrowUp": nextRow = Math.max(1, row - 1); break;
      case "ArrowDown": nextRow = Math.min(GRID_ROWS, row + 1); break;
      case "ArrowLeft": nextColumn = Math.max(1, column - 1); break;
      case "ArrowRight": nextColumn = Math.min(GRID_COLUMNS, column + 1); break;
      case "Home": nextColumn = 1; if (event.ctrlKey || event.metaKey) nextRow = 1; break;
      case "End": nextColumn = GRID_COLUMNS; if (event.ctrlKey || event.metaKey) nextRow = GRID_ROWS; break;
      default: return;
    }
    event.preventDefault();
    popoverRef.current?.querySelector<HTMLElement>(`[data-table-size='${nextRow}:${nextColumn}']`)?.focus();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="table-insert-grid-popover"
      role="dialog"
      aria-label={t("table.insert")}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // These keys belong to the picker, not the canvas behind it (moving/deleting shapes).
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="table-insert-grid-heading">
        <span>{t("table.insert")}</span>
        <IconButton label={tCommon("actions.close")} tone="ghost" size="sm" onClick={cancel}><X size={16} /></IconButton>
      </div>
      <div className="table-insert-grid-size" role="status" aria-live="polite" aria-atomic="true">
        {valid ? t("table.size", { replace: { rows, columns } }) : t("table.chooseSize")}
      </div>
      <div className="table-insert-grid" role="group" aria-label={t("table.chooseSize")} aria-describedby={helpId}>
        {Array.from({ length: GRID_ROWS }, (_, rowIndex) => (
          Array.from({ length: GRID_COLUMNS }, (__, columnIndex) => {
            const row = rowIndex + 1;
            const column = columnIndex + 1;
            return (
              <button
                key={`${row}:${column}`}
                data-table-size={`${row}:${column}`}
                type="button"
                tabIndex={row === gridRow && column === gridColumn ? 0 : -1}
                className={valid && row <= rows && column <= columns ? "selected" : ""}
                aria-label={t("table.insertSize", { replace: { rows: row, columns: column } })}
                onMouseEnter={() => setSize({ rows: String(row), columns: String(column) })}
                onFocus={() => setSize({ rows: String(row), columns: String(column) })}
                onKeyDown={(event) => handleGridKeyDown(event, row, column)}
                onClick={() => onPick(column, row)}
              />
            );
          })
        ))}
      </div>
      <div id={helpId} className="table-insert-grid-help">{t("table.keyboardHint")}</div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) onPick(columns, rows); }}>
        <div className="table-insert-grid-fields">
          {(["rows", "columns"] as const).map((dimension) => (
            <label key={dimension}>
              <span>{t(`table.${dimension}`)}</span>
              <input
                type="number"
                min={1}
                max={MAX_SIZE}
                step={1}
                required
                value={size[dimension]}
                aria-invalid={!validSize(size[dimension])}
                aria-describedby={!validSize(size[dimension]) ? errorId : undefined}
                onChange={(event) => setSize({ ...size, [dimension]: event.target.value })}
              />
            </label>
          ))}
        </div>
        {!valid && <div id={errorId} className="table-insert-grid-error">{t("table.sizeRange", { replace: { max: MAX_SIZE } })}</div>}
        <Button type="submit" tone="primary" size="sm" disabled={!valid}>{t("table.insert")}</Button>
      </form>
    </div>,
    document.body,
  );
}
