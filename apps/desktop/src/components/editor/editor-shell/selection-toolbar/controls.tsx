"use client";

import { useCallback, useState, type ReactNode, type RefObject } from "react";

import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import {
  EditorToolbarColorButton,
  EditorToolbarIconButton,
} from "@/components/editor/EditorToolbar";
import { ColorPalette } from "@/components/editor/ColorPalette";

/** 選択バーで同時に開けるメニューは 1 つ。開いているメニューの識別子だけを持つ。 */
export function useToolbarMenus<Id extends string>() {
  const [openId, setOpenId] = useState<Id | null>(null);
  const toggle = useCallback((id: Id) => setOpenId((current) => (current === id ? null : id)), []);
  const close = useCallback((id?: Id) => setOpenId((current) => (id === undefined || current === id ? null : current)), []);
  return { openId, toggle, close };
}

export const TOOLBAR_ICON_SIZE = 16;

/** アイコンだけのボタン。ラベルは読み上げとツールチップに使う。 */
export function ToolIconButton({
  label,
  active = false,
  disabled = false,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <EditorToolbarIconButton
      className="selection-toolbar-button"
      active={active}
      danger={danger}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </EditorToolbarIconButton>
  );
}

/** アイコン + 文字のボタン。「トリミング」のように、何が起きるかを言葉で示したい操作用。 */
export function ToolLabelButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <EditorToolbarIconButton
      className="selection-toolbar-button selection-toolbar-labeled"
      withText
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
      <span>{label}</span>
    </EditorToolbarIconButton>
  );
}

/** 色を選ぶボタンとパレット。`allowTransparent` のときは「なし」が選べる。 */
export function ToolColorMenu({
  id,
  openId,
  onToggle,
  onClose,
  buttonRef,
  label,
  icon,
  swatch,
  disabled = false,
  palette,
}: {
  id: string;
  openId: string | null;
  onToggle: (id: string) => void;
  onClose: (id: string) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  icon: ReactNode;
  /** ボタンの下に敷く現在色の帯。 */
  swatch?: string | null;
  disabled?: boolean;
  palette: (props: { close: () => void }) => ReactNode;
}) {
  const open = openId === id && !disabled;
  return (
    <div className="shape-menu-anchor">
      <EditorToolbarColorButton
        buttonRef={buttonRef}
        className="selection-toolbar-button"
        // 現在の色は自前の帯で見せる。上部ツールバーの色ボタンが持つ currentColor の帯は使わない。
        text
        active={open}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(id);
        }}
      >
        {icon}
        {swatch !== undefined && (
          <span
            aria-hidden="true"
            className="toolbar-icon-color-stripe"
            style={{ backgroundColor: swatch ?? "transparent" }}
          />
        )}
      </EditorToolbarColorButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => onClose(id)}
        className="color-popover"
        ariaLabel={label}
        placement="top"
      >
        {open && palette({ close: () => onClose(id) })}
      </ToolbarPopover>
    </div>
  );
}

/** 一覧から選ぶメニュー (ドロップダウン)。中身は呼び出し側が決める。 */
export function ToolMenu({
  id,
  openId,
  onClose,
  buttonRef,
  className = "shape-menu",
  role = "menu",
  ariaLabel,
  children,
}: {
  id: string;
  openId: string | null;
  onClose: (id: string) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  className?: string;
  role?: "menu" | "dialog";
  ariaLabel: string;
  children: ReactNode;
}) {
  const open = openId === id;
  return (
    <ToolbarPopover
      open={open}
      anchorRef={buttonRef}
      onClose={() => onClose(id)}
      className={className}
      role={role}
      ariaLabel={ariaLabel}
      placement="top"
    >
      {open && children}
    </ToolbarPopover>
  );
}

export function ToolDivider() {
  return <span className="selection-action-divider" aria-hidden="true" />;
}

export { ColorPalette };
