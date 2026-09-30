"use client";

import { Shapes } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";

import { EditorToolbarMenuButton } from "@/components/editor/EditorToolbar";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { buildShapeTypeChangeSections } from "@/components/editor/overlay-canvas/shape-gallery";
import { isShapeTypeChangeCommand, type ShapeTypeChangeCommand } from "@/components/editor/overlay-canvas/shape-type-change";
import { useT } from "@/lib/i18n/react";

/**
 * 選んだ図形の種類を変える (四角→円、直線→矢印など) ボタンとメニュー。
 *
 * 上部ツールバー・リボン・選択バーで同じアイコン・同じ一覧を使うための共有部品。
 * `open` を渡すと呼び出し側が開閉を持ち (選択バーは同時に1つのメニューだけ開く)、
 * 渡さなければ自分で持つ (クロームは描画関数で state を持てないため)。
 */
export function ShapeTypeMenuButton({
  disabled = false,
  open: controlledOpen,
  onToggle,
  onSelect,
  placement,
  iconSize = 17,
  className,
  popoverZIndex,
}: {
  disabled?: boolean;
  open?: boolean;
  onToggle?: () => void;
  onSelect: (command: ShapeTypeChangeCommand) => void;
  placement?: "bottom" | "top";
  iconSize?: number;
  className?: string;
  popoverZIndex?: CSSProperties["zIndex"];
}) {
  const t = useT("shape");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = !disabled && (controlled ? controlledOpen : ownOpen);
  const label = t("menu.changeShapeType");
  const close = () => {
    if (controlled) {
      if (open) onToggle?.();
    } else {
      setOwnOpen(false);
    }
  };

  return (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={buttonRef}
        className={className}
        active={open}
        tooltip={{ label }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (controlled) {
            onToggle?.();
          } else {
            setOwnOpen((current) => !current);
          }
        }}
      >
        <Shapes size={iconSize} aria-hidden="true" />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={close}
        className="shape-menu shape-gallery shape-type-menu"
        role="menu"
        ariaLabel={label}
        placement={placement}
        zIndex={popoverZIndex}
      >
        {open && buildShapeTypeChangeSections(t).map((section) => (
          <div className="shape-gallery-section" key={section.id}>
            <div className="shape-gallery-section-label">{section.label}</div>
            <div className="shape-gallery-grid">
              {section.items.map((item) => {
                if (!item.command || !isShapeTypeChangeCommand(item.command)) {
                  return null;
                }
                const command = item.command;
                const Icon = item.icon;
                return (
                  <button
                    key={command}
                    type="button"
                    role="menuitem"
                    title={item.label}
                    aria-label={item.label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onSelect(command);
                      close();
                    }}
                  >
                    <Icon size={16} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </ToolbarPopover>
    </div>
  );
}
