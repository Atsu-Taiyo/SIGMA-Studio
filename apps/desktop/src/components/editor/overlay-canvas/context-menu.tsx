"use client";
import {
  type OverlayAlignAction,
  type OverlayDistributeAxis,
  type OverlayFlipAxis
} from "@/features/drawing";
import { useT } from "@/lib/i18n/react";
import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BringToFront,
  ChartColumnBig, ChevronRight, Copy,
  Crop,
  Crosshair,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Layers,
  Maximize2,
  MoveDown,
  MoveUp,
  PackagePlus,
  PaintBucket,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SendToBack,
  Settings2,
  Shapes,
  Trash2,
  Ungroup
} from "lucide-react";
import type {
  ReactNode
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type OverlayArrangeAction } from "./reorder-shapes";
import { buildShapeTypeChangeSections } from "./shape-gallery";
import {
  isShapeTypeChangeCommand,
  type ShapeTypeChangeCommand
} from "./shape-type-change";

export function OverlayShapeContextMenu({
  x,
  y,
  canGroup,
  canUngroup,
  canAlign,
  canDistribute,
  canChangeShapeType,
  imageHasCrop,
  imageEditable,
  imageOpacity,
  graphEditable,
  graphCanFill,
  graph3dEditable,
  onChartSettings,
  onCreateChartFromTable,
  onGraphSettings,
  onGraph3DSettings,
  onGraphCrop,
  onGraphOriginPick,
  onGraphFillPick,
  onImageCrop,
  onImageReplace,
  onImageResetCrop,
  onImageNaturalSize,
  onImageOpacityChange,
  onDuplicate,
  onDelete,
  onGroup,
  onUngroup,
  arrangeShortcutLabels,
  onArrange,
  onTransform,
  onAlign,
  onDistribute,
  onChangeShapeType,
  onSaveAsMaterial,
}: {
  x: number;
  y: number;
  canGroup: boolean;
  canUngroup: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canChangeShapeType: boolean;
  imageHasCrop: boolean;
  imageEditable: boolean;
  imageOpacity: number;
  graphEditable: boolean;
  graphCanFill: boolean;
  graph3dEditable: boolean;
  onChartSettings?: () => void;
  onCreateChartFromTable?: () => void;
  onGraphSettings?: () => void;
  onGraph3DSettings?: () => void;
  onGraphCrop?: () => void;
  onGraphOriginPick?: () => void;
  onGraphFillPick?: () => void;
  onImageCrop?: () => void;
  onImageReplace?: () => void;
  onImageResetCrop?: () => void;
  onImageNaturalSize?: () => void;
  onImageOpacityChange?: (opacity: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  arrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  onArrange: (action: OverlayArrangeAction) => void;
  onTransform: (action: "rotateClockwise" | "rotateCounterclockwise" | OverlayFlipAxis) => void;
  onAlign: (action: OverlayAlignAction) => void;
  onDistribute: (axis: OverlayDistributeAxis) => void;
  onChangeShapeType: (command: ShapeTypeChangeCommand) => void;
  onSaveAsMaterial?: () => void;
}) {
  const tShape = useT("shape");
  // 並び替えの4語だけリボンと共有する (`chrome.shapeStyle.arrange.*` が唯一の出典)。
  const tChrome = useT("chrome");
  const [shapeTypePickerOpen, setShapeTypePickerOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<"order" | "rotation" | null>(null);
  const submenuSide = typeof window !== "undefined" && x + 456 > window.innerWidth ? "left" : "right";
  return (
    <div
      className="overlay-shape-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {onCreateChartFromTable && (
        <>
          <ContextMenuButton icon={<ChartColumnBig size={14} />} onClick={onCreateChartFromTable}>
            {tShape("table.createChart")}
          </ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onChartSettings && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} onClick={onChartSettings}>
            {tShape("chartPanel.title")}
          </ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onGraphSettings && onGraphCrop && onGraphOriginPick && onGraphFillPick && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} disabled={!graphEditable} onClick={onGraphSettings}>{tShape("menu.graphSettings")}</ContextMenuButton>
          <ContextMenuButton icon={<Crop size={14} />} disabled={!graphEditable} onClick={onGraphCrop}>{tShape("graph.trim")}</ContextMenuButton>
          <ContextMenuButton icon={<Crosshair size={14} />} disabled={!graphEditable} onClick={onGraphOriginPick}>{tShape("graph.pickOrigin")}</ContextMenuButton>
          <ContextMenuButton icon={<PaintBucket size={14} />} disabled={!graphEditable || !graphCanFill} onClick={onGraphFillPick}>{tShape("graph.fillArea")}</ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onGraph3DSettings && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} disabled={!graph3dEditable} onClick={onGraph3DSettings}>{tShape("graph3d.menuSettings")}</ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onImageCrop && onImageReplace && onImageResetCrop && onImageNaturalSize && onImageOpacityChange && (
        <>
          <ContextMenuButton icon={<Crop size={14} />} disabled={!imageEditable} onClick={onImageCrop}>{tShape("menu.imageCrop")}</ContextMenuButton>
          <ContextMenuButton icon={<RefreshCw size={14} />} disabled={!imageEditable} onClick={onImageReplace}>{tShape("menu.imageReplace")}</ContextMenuButton>
          <ContextMenuButton icon={<RotateCcw size={14} />} disabled={!imageEditable || !imageHasCrop} onClick={onImageResetCrop}>{tShape("menu.imageResetCrop")}</ContextMenuButton>
          <ContextMenuButton icon={<Maximize2 size={14} />} disabled={!imageEditable} onClick={onImageNaturalSize}>{tShape("menu.imageNaturalSize")}</ContextMenuButton>
          <label className="overlay-shape-context-menu-opacity">
            <span>{tShape("menu.opacity")}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={imageOpacity}
              disabled={!imageEditable}
              aria-label={tShape("menu.imageOpacityAria")}
              data-testid="overlay-image-opacity-slider"
              onChange={(event) => onImageOpacityChange(Number(event.target.value))}
            />
            <output>{Math.round(imageOpacity * 100)}%</output>
          </label>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {canGroup && <ContextMenuButton icon={<Group size={14} />} onClick={onGroup}>{tShape("menu.group")}</ContextMenuButton>}
      {canUngroup && <ContextMenuButton icon={<Ungroup size={14} />} onClick={onUngroup}>{tShape("menu.ungroup")}</ContextMenuButton>}
      {(canGroup || canUngroup) && <div className="overlay-shape-context-menu-separator" role="separator" />}

      {canChangeShapeType && (
        <>
          <ContextMenuButton icon={<Shapes size={14} />} onClick={() => setShapeTypePickerOpen((open) => !open)}>
            {tShape("menu.changeShapeType")}
          </ContextMenuButton>
          {shapeTypePickerOpen && (
            <div className="overlay-shape-type-picker">
              {buildShapeTypeChangeSections(tShape).map((section) => (
                <div key={section.id} className="overlay-shape-type-section">
                  <div className="overlay-shape-type-section-label">{section.label}</div>
                  <div className="overlay-shape-type-grid">
                    {section.items.map((item) => {
                      if (!item.command || !isShapeTypeChangeCommand(item.command)) {
                        return null;
                      }
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.command}
                          type="button"
                          role="menuitem"
                          title={item.label}
                          aria-label={item.label}
                          onClick={() => onChangeShapeType(item.command as ShapeTypeChangeCommand)}
                        >
                          <Icon size={16} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}

      <ContextMenuSubmenu
        icon={<Layers size={14} />}
        label={tShape("menu.order")}
        open={openSubmenu === "order"}
        side={submenuSide}
        onOpen={() => setOpenSubmenu("order")}
        onClose={() => setOpenSubmenu((current) => current === "order" ? null : current)}
      >
        <ContextMenuButton icon={<BringToFront size={14} />} shortcut={arrangeShortcutLabels?.front} onClick={() => onArrange("front")}>{tChrome("shapeStyle.arrange.front")}</ContextMenuButton>
        <ContextMenuButton icon={<MoveUp size={14} />} shortcut={arrangeShortcutLabels?.forward} onClick={() => onArrange("forward")}>{tChrome("shapeStyle.arrange.forward")}</ContextMenuButton>
        <ContextMenuButton icon={<MoveDown size={14} />} shortcut={arrangeShortcutLabels?.backward} onClick={() => onArrange("backward")}>{tChrome("shapeStyle.arrange.backward")}</ContextMenuButton>
        <ContextMenuButton icon={<SendToBack size={14} />} shortcut={arrangeShortcutLabels?.back} onClick={() => onArrange("back")}>{tChrome("shapeStyle.arrange.back")}</ContextMenuButton>
      </ContextMenuSubmenu>
      <ContextMenuSubmenu
        icon={<RotateCw size={14} />}
        label={tShape("menu.rotate")}
        open={openSubmenu === "rotation"}
        side={submenuSide}
        onOpen={() => setOpenSubmenu("rotation")}
        onClose={() => setOpenSubmenu((current) => current === "rotation" ? null : current)}
      >
        <ContextMenuButton icon={<RotateCw size={14} />} onClick={() => onTransform("rotateClockwise")}>{tShape("menu.rotateRight")}</ContextMenuButton>
        <ContextMenuButton icon={<RotateCcw size={14} />} onClick={() => onTransform("rotateCounterclockwise")}>{tShape("menu.rotateLeft")}</ContextMenuButton>
        <ContextMenuButton icon={<FlipHorizontal2 size={14} />} onClick={() => onTransform("horizontal")}>{tShape("menu.flipHorizontal")}</ContextMenuButton>
        <ContextMenuButton icon={<FlipVertical2 size={14} />} onClick={() => onTransform("vertical")}>{tShape("menu.flipVertical")}</ContextMenuButton>
      </ContextMenuSubmenu>

      {canAlign && (
        <>
          <div className="overlay-shape-context-menu-separator" role="separator" />
          <div className="overlay-shape-context-menu-grid" role="group" aria-label={tShape("menu.align")}>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyStart size={14} />} onClick={() => onAlign("left")}>{tShape("menu.alignLeft")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyCenter size={14} />} onClick={() => onAlign("center")}>{tShape("menu.alignCenter")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyEnd size={14} />} onClick={() => onAlign("right")}>{tShape("menu.alignRight")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyStart size={14} />} onClick={() => onAlign("top")}>{tShape("menu.alignTop")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyCenter size={14} />} onClick={() => onAlign("middle")}>{tShape("menu.alignMiddle")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyEnd size={14} />} onClick={() => onAlign("bottom")}>{tShape("menu.alignBottom")}</ContextMenuButton>
          </div>
        </>
      )}

      {canDistribute && (
        <>
          <div className="overlay-shape-context-menu-separator" role="separator" />
          <ContextMenuButton icon={<AlignHorizontalDistributeCenter size={14} />} onClick={() => onDistribute("horizontal")}>{tShape("menu.distributeHorizontal")}</ContextMenuButton>
          <ContextMenuButton icon={<AlignVerticalDistributeCenter size={14} />} onClick={() => onDistribute("vertical")}>{tShape("menu.distributeVertical")}</ContextMenuButton>
        </>
      )}

      <div className="overlay-shape-context-menu-separator" role="separator" />
      {onSaveAsMaterial && <ContextMenuButton icon={<PackagePlus size={14} />} onClick={onSaveAsMaterial}>{tShape("menu.saveAsMaterial")}</ContextMenuButton>}
      <ContextMenuButton icon={<Copy size={14} />} onClick={onDuplicate}>{tShape("menu.duplicate")}</ContextMenuButton>
      <ContextMenuButton icon={<Trash2 size={14} />} onClick={onDelete} danger>{tShape("menu.delete")}</ContextMenuButton>
    </div>
  );
}

export function ContextMenuButton({
  icon,
  children,
  danger = false,
  compact = false,
  disabled = false,
  shortcut,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
  compact?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={typeof children === "string" ? children : undefined}
      className={`${danger ? "danger" : ""} ${compact ? "compact" : ""}`.trim()}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function ContextMenuSubmenu({
  icon,
  label,
  open,
  side,
  onOpen,
  onClose,
  children,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  side: "left" | "right";
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openAndKeepOpen = useCallback(() => {
    cancelScheduledClose();
    onOpen();
  }, [cancelScheduledClose, onOpen]);
  const scheduleCloseIfPointerLeft = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (!rootRef.current?.matches(":hover") && !panelRef.current?.matches(":hover")) {
        onClose();
      }
    }, 300);
  }, [cancelScheduledClose, onClose]);
  const focusFirstItem = () => {
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const positionPanel = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) {
        return;
      }
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const margin = 8;
      const preferredLeft = side === "right"
        ? trigger.right - 3
        : trigger.left - panel.width + 3;
      const preferredTop = trigger.top - 5;
      setPanelPosition({
        left: Math.min(Math.max(preferredLeft, viewportLeft + margin), viewportRight - panel.width - margin),
        top: Math.min(Math.max(preferredTop, viewportTop + margin), viewportBottom - panel.height - margin),
      });
    };

    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("resize", positionPanel);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("resize", positionPanel);
    };
  }, [open, side]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  return (
    <div
      ref={rootRef}
      className="overlay-shape-context-submenu"
      onMouseEnter={openAndKeepOpen}
      onMouseLeave={scheduleCloseIfPointerLeft}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !panelRef.current?.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onFocus={openAndKeepOpen}
        onClick={() => open ? onClose() : openAndKeepOpen()}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAndKeepOpen();
            focusFirstItem();
          }
        }}
      >
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
        <ChevronRight size={14} className="overlay-shape-context-menu-caret" aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          className="overlay-shape-context-submenu-panel"
          role="menu"
          aria-label={label}
          style={{
            left: panelPosition?.left ?? 0,
            top: panelPosition?.top ?? 0,
            visibility: panelPosition ? "visible" : "hidden",
          }}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={scheduleCloseIfPointerLeft}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget) && !rootRef.current?.contains(event.relatedTarget)) {
              onClose();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              triggerRef.current?.focus();
            }
          }}
        >
          {children}
        </div>
      ), document.body)}
    </div>
  );
}
export interface OverlayContextMenuState { x: number; y: number; shapeId: string; }
