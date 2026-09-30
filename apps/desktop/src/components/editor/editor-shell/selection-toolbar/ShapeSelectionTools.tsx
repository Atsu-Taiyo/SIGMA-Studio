"use client";

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
  ChartColumnBig,
  Copy,
  Crop,
  Crosshair,
  Droplets,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Lock,
  LockOpen,
  Maximize2,
  MoveDown,
  MoveUp,
  MoreHorizontal,
  PackagePlus,
  PaintBucket,
  PenLine,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SendToBack,
  Settings2,
  Trash2,
  Ungroup,
} from "lucide-react";
import { useRef, type ReactNode } from "react";

import { EditorToolbarMenuButton } from "@/components/editor/EditorToolbar";
import { LineEndpointMenuButton } from "@/components/editor/editor-shell/formatting-icons";
import { ShapeTypeMenuButton } from "@/components/editor/editor-shell/shape-type-menu";
import { OverlayLineDashMenuButton, OverlayLineWidthMenuButton } from "@/components/editor/overlay-line-style-menus";
import {
  dispatchOverlayStylePreview,
  type OverlayAlignAction,
  type OverlayArrangeAction,
  type OverlayDistributeAxis,
} from "@/components/editor/page-overlay-types";
import { useT } from "@/lib/i18n/react";

import { getSharedOverlayLineDash, getSharedOverlayLineSize } from "../overlay-helpers";
import type { SelectionToolbarShapeBinding, SelectionToolbarTextBinding } from "./binding";
import {
  ColorPalette,
  ToolColorMenu,
  ToolDivider,
  ToolIconButton,
  ToolLabelButton,
  ToolMenu,
  TOOLBAR_ICON_SIZE,
  useToolbarMenus,
} from "./controls";
import {
  fillPreviewPatch,
  planShapeTools,
  readSharedOpacity,
  readSharedStrokeColor,
  readSharedStrokeOpacity,
  strokeColorPatch,
  strokePreviewPatch,
} from "./model";
import { TextSelectionTools } from "./TextSelectionTools";

type ShapeMenuId =
  | "shapeType"
  | "stroke"
  | "fill"
  | "lineWidth"
  | "lineDash"
  | "lineStart"
  | "lineEnd"
  | "opacity"
  | "more";

/**
 * 図形・画像・グラフ・表を選んだときの操作バー。何を選んだかで並びが変わる:
 *
 * 並びは上部ツールバーと同じ: 枠線色 → 塗りつぶし → 線種・線幅・両端 → 図形の種類を変更。
 *
 * - 四角・円など: 枠線 / 塗りつぶし / 線種・線幅 / 図形の種類
 * - 直線・矢印・弧: 枠線 / 線種・線幅 / 左端・右端 (矢印の向きや丸など) / 図形の種類
 * - 画像: トリミング / 差し替え / 元のサイズ / トリミング解除
 * - グラフ・表: 設定 / トリミング / 原点 / 領域の塗り / グラフ化
 * - 文字図形: 本文と同じ文字書式
 * - 塗り・枠線の不透明度は、それぞれの色パレットの中で決める (専用のボタンは出さない)
 *   色を選べない図形 (画像・グラフなど) だけ、図形まるごとの透明度ボタンが出る
 * - どれにも: 重なり順・回転反転・ロック・複製・削除 (「…」にまとめる)
 */
export function ShapeSelectionTools({
  shape,
  text,
}: {
  shape: SelectionToolbarShapeBinding;
  text: SelectionToolbarTextBinding;
}) {
  const t = useT("chrome");
  const tShape = useT("shape");
  const tEditor = useT("editor");
  const menus = useToolbarMenus<ShapeMenuId>();
  const strokeRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLButtonElement>(null);
  const lineWidthRef = useRef<HTMLButtonElement>(null);
  const lineDashRef = useRef<HTMLButtonElement>(null);
  const opacityRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const { selection } = shape;
  const plan = planShapeTools(selection);
  const openId = menus.openId;
  const onToggle = (id: string) => menus.toggle(id as ShapeMenuId);
  const onClose = (id: string) => menus.close(id as ShapeMenuId);
  const canEdit = shape.enabled && !selection.locked;
  const run = shape.request;
  const opacity = readSharedOpacity(selection.selectedShapes);
  const strokeColor = readSharedStrokeColor(selection.selectedShapes);
  const strokeOpacity = readSharedStrokeOpacity(selection.selectedShapes);

  // 図中の文字を編集している最中は、本文と同じ文字書式を出す。
  if (selection.textEditing) {
    return <TextSelectionTools text={text} scope="shape" />;
  }

  if (selection.locked) {
    return (
      <ToolLabelButton label={tEditor("selectionToolbar.unlock")} disabled={!shape.enabled} onClick={() => run({ type: "toggleLock" })}>
        <LockOpen size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
      </ToolLabelButton>
    );
  }

  const hasStyleControls = plan.shapeType || plan.fill || plan.stroke || plan.lineStyle || plan.lineEndpoints;

  return (
    <>
      {plan.text && (
        <>
          <TextSelectionTools text={text} scope="shape" />
          <ToolDivider />
        </>
      )}

      {plan.stroke && (
        <ToolColorMenu
          id="stroke"
          openId={openId}
          onToggle={onToggle}
          onClose={onClose}
          buttonRef={strokeRef}
          label={t("shapeStyle.stroke.label")}
          icon={<PenLine size={TOOLBAR_ICON_SIZE} aria-hidden="true" />}
          swatch={strokeColor}
          disabled={!canEdit}
          palette={({ close }) => (
            <ColorPalette
              value={strokeColor}
              opacity={strokeOpacity ?? 1}
              // 色か不透明度のどちらかが図形ごとに違うときは、1 つの値を見せない。
              mixed={strokeColor === null || strokeOpacity === null}
              allowTransparent
              transparentLabel={t("shapeStyle.stroke.transparent")}
              onPreview={(preview) => dispatchOverlayStylePreview(preview === null ? null : strokePreviewPatch(preview))}
              onOpacityChange={(nextOpacity) => shape.applyStyle({ strokeOpacity: nextOpacity })}
              onChange={(color, nextOpacity) => {
                if (color === null) {
                  shape.applyStyle({ strokeOpacity: 0 });
                } else {
                  shape.applyStyle(nextOpacity === undefined
                    ? strokeColorPatch(color, strokeOpacity)
                    : { color, strokeOpacity: nextOpacity });
                }
                close();
              }}
            />
          )}
        />
      )}

      {plan.fill && (
        <ToolColorMenu
          id="fill"
          openId={openId}
          onToggle={onToggle}
          onClose={onClose}
          buttonRef={fillRef}
          label={t("shapeStyle.fill.label")}
          icon={<PaintBucket size={TOOLBAR_ICON_SIZE} aria-hidden="true" />}
          swatch={shape.fillColor}
          disabled={!canEdit}
          palette={({ close }) => (
            <ColorPalette
              value={shape.fillColor}
              opacity={shape.fillOpacity}
              mixed={selection.fill.kind === "mixed"}
              allowTransparent
              transparentLabel={t("shapeStyle.fill.transparent")}
              onPreview={(preview) => dispatchOverlayStylePreview(preview === null ? null : fillPreviewPatch(preview))}
              onOpacityChange={(nextOpacity) => shape.applyStyle({ fillOpacity: nextOpacity })}
              onChange={(color, nextOpacity) => {
                // 「塗りなし」と「完全に透明な色」は別の文書なので、null は不透明度より先に見る。
                if (color === null) {
                  shape.applyStyle({ fill: "none" });
                } else {
                  shape.applyStyle(nextOpacity === undefined
                    ? shape.fillColorPatch(color)
                    : { fill: "solid", fillColor: color, fillOpacity: nextOpacity });
                }
                close();
              }}
            />
          )}
        />
      )}

      {plan.lineStyle && (
        <>
          <OverlayLineDashMenuButton
            buttonRef={lineDashRef}
            currentValue={getSharedOverlayLineDash(selection.selectedShapes, selection.solidEdge)}
            open={openId === "lineDash"}
            disabled={!canEdit}
            onToggle={() => menus.toggle("lineDash")}
            onSelect={(value) => {
              shape.applyStyle({ dash: value });
              menus.close("lineDash");
            }}
          />
          <OverlayLineWidthMenuButton
            buttonRef={lineWidthRef}
            currentValue={getSharedOverlayLineSize(selection.selectedShapes, selection.solidEdge)}
            open={openId === "lineWidth"}
            disabled={!canEdit}
            onToggle={() => menus.toggle("lineWidth")}
            onSelect={(value) => {
              shape.applyStyle({ size: value });
              menus.close("lineWidth");
            }}
          />
        </>
      )}

      {plan.lineEndpoints && (
        <>
          <LineEndpointMenuButton
            endpoint="start"
            currentValue={selection.arrowheadStart}
            open={openId === "lineStart"}
            disabled={!canEdit}
            onToggle={() => menus.toggle("lineStart")}
            onSelect={(value) => {
              shape.applyStyle({ arrowheadStart: value });
              menus.close("lineStart");
            }}
          />
          <LineEndpointMenuButton
            endpoint="end"
            currentValue={selection.arrowheadEnd}
            open={openId === "lineEnd"}
            disabled={!canEdit}
            onToggle={() => menus.toggle("lineEnd")}
            onSelect={(value) => {
              shape.applyStyle({ arrowheadEnd: value });
              menus.close("lineEnd");
            }}
          />
        </>
      )}

      {plan.shapeType && (
        <ShapeTypeMenuButton
          className="selection-toolbar-button"
          iconSize={TOOLBAR_ICON_SIZE}
          placement="top"
          disabled={!canEdit}
          open={openId === "shapeType"}
          onToggle={() => menus.toggle("shapeType")}
          onSelect={(command) => run({ type: "changeShapeType", command })}
        />
      )}

      {hasStyleControls && <ToolDivider />}

      {plan.image && (
        <>
          <ToolLabelButton label={tEditor("selectionToolbar.crop")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "imageCrop" })}>
            <Crop size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolLabelButton label={tEditor("selectionToolbar.replaceImage")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "imageReplace" })}>
            <RefreshCw size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolIconButton label={tShape("menu.imageNaturalSize")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "imageNaturalSize" })}>
            <Maximize2 size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolIconButton>
          {plan.image.hasCrop && (
            <ToolIconButton label={tShape("menu.imageResetCrop")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "imageResetCrop" })}>
              <RotateCcw size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
            </ToolIconButton>
          )}
          <ToolDivider />
        </>
      )}

      {plan.graph && (
        <>
          <ToolLabelButton label={tShape("menu.graphSettings").replace(/…$/, "")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "graphSettings" })}>
            <Settings2 size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolIconButton label={tShape("graph.trim")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "graphCrop" })}>
            <Crop size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolIconButton>
          <ToolIconButton label={tShape("graph.pickOrigin")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "graphOriginPick" })}>
            <Crosshair size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolIconButton>
          {plan.graph.canFillArea && (
            <ToolIconButton label={tShape("graph.fillArea")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "graphFillPick" })}>
              <PaintBucket size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
            </ToolIconButton>
          )}
          <ToolDivider />
        </>
      )}

      {plan.graph3d && (
        <>
          <ToolLabelButton label={tShape("graph3d.menuSettings")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "graph3dSettings" })}>
            <Settings2 size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolDivider />
        </>
      )}

      {plan.chart && (
        <>
          <ToolLabelButton label={tShape("chartPanel.title")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "chartSettings" })}>
            <Settings2 size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolDivider />
        </>
      )}

      {plan.table && (
        <>
          <ToolLabelButton label={tShape("table.createChart")} disabled={!canEdit} onClick={() => run({ type: "shapeCommand", command: "chartFromTable" })}>
            <ChartColumnBig size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </ToolLabelButton>
          <ToolDivider />
        </>
      )}

      {plan.group && (
        <ToolIconButton label={tShape("menu.group")} disabled={!canEdit} onClick={() => run({ type: "group" })}>
          <Group size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </ToolIconButton>
      )}
      {plan.ungroup && (
        <ToolIconButton label={tShape("menu.ungroup")} disabled={!canEdit} onClick={() => run({ type: "ungroup" })}>
          <Ungroup size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </ToolIconButton>
      )}

      {/* 図形まるごとの透明度。色パレットに不透明度がある図形には出さない (plan.opacity)。
          開いている間は、つまみを 1 まで動かしても (= 出す理由が消えても) 閉じない。 */}
      {(plan.opacity || openId === "opacity") && (
        <div className="shape-menu-anchor">
          <EditorToolbarMenuButton
            buttonRef={opacityRef}
            className="selection-toolbar-button"
            active={openId === "opacity"}
            title={tShape("menu.opacity")}
            aria-label={tShape("menu.opacity")}
            aria-haspopup="dialog"
            aria-expanded={openId === "opacity"}
            disabled={!canEdit}
            onClick={(event) => {
              event.stopPropagation();
              menus.toggle("opacity");
            }}
          >
            <Droplets size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </EditorToolbarMenuButton>
          <ToolMenu id="opacity" openId={openId} onClose={onClose} buttonRef={opacityRef} className="shape-menu selection-toolbar-opacity" role="dialog" ariaLabel={tShape("menu.opacity")}>
            <label>
              <span>{tShape("menu.opacity")}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={opacity ?? 1}
                aria-label={tShape("menu.opacity")}
                onChange={(event) => shape.applyStyle({ opacity: Number(event.target.value) })}
              />
              <output>{opacity === null ? t("format.mixed") : `${Math.round(opacity * 100)}%`}</output>
            </label>
          </ToolMenu>
        </div>
      )}

      {/* 重なり順・回転反転・整列・ロック・複製・削除 */}
      <div className="shape-menu-anchor">
        <EditorToolbarMenuButton
          buttonRef={moreRef}
          className="selection-toolbar-button"
          active={openId === "more"}
          title={tEditor("selectionToolbar.more")}
          aria-label={tEditor("selectionToolbar.more")}
          aria-haspopup="menu"
          aria-expanded={openId === "more"}
          disabled={!shape.enabled}
          onClick={(event) => {
            event.stopPropagation();
            menus.toggle("more");
          }}
        >
          <MoreHorizontal size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </EditorToolbarMenuButton>
        <ToolMenu id="more" openId={openId} onClose={onClose} buttonRef={moreRef} className="shape-menu selection-toolbar-more-menu" ariaLabel={tEditor("selectionToolbar.more")}>
          <MoreItem icon={<BringToFront size={16} />} label={t("shapeStyle.arrange.front")} onSelect={() => arrange("front")} />
          <MoreItem icon={<MoveUp size={16} />} label={t("shapeStyle.arrange.forward")} onSelect={() => arrange("forward")} />
          <MoreItem icon={<MoveDown size={16} />} label={t("shapeStyle.arrange.backward")} onSelect={() => arrange("backward")} />
          <MoreItem icon={<SendToBack size={16} />} label={t("shapeStyle.arrange.back")} onSelect={() => arrange("back")} />
          <div className="selection-toolbar-menu-separator" role="separator" />
          <MoreItem icon={<RotateCw size={16} />} label={tShape("menu.rotateRight")} onSelect={() => transform("rotateClockwise")} />
          <MoreItem icon={<RotateCcw size={16} />} label={tShape("menu.rotateLeft")} onSelect={() => transform("rotateCounterclockwise")} />
          <MoreItem icon={<FlipHorizontal2 size={16} />} label={tShape("menu.flipHorizontal")} onSelect={() => transform("horizontal")} />
          <MoreItem icon={<FlipVertical2 size={16} />} label={tShape("menu.flipVertical")} onSelect={() => transform("vertical")} />
          {plan.align && (
            <>
              <div className="selection-toolbar-menu-separator" role="separator" />
              <div className="selection-toolbar-icon-row" role="group" aria-label={tShape("menu.align")}>
                {ALIGN_ITEMS.map(({ action, icon, key }) => (
                  <MoreIconItem key={action} icon={icon} label={tShape(key)} onSelect={() => align(action)} />
                ))}
              </div>
            </>
          )}
          {plan.distribute && (
            <>
              <MoreItem icon={<AlignHorizontalDistributeCenter size={16} />} label={tShape("menu.distributeHorizontal")} onSelect={() => distribute("horizontal")} />
              <MoreItem icon={<AlignVerticalDistributeCenter size={16} />} label={tShape("menu.distributeVertical")} onSelect={() => distribute("vertical")} />
            </>
          )}
          <div className="selection-toolbar-menu-separator" role="separator" />
          <MoreItem icon={<Lock size={16} />} label={tEditor("selectionToolbar.lock")} onSelect={() => { run({ type: "toggleLock" }); menus.close("more"); }} />
          {shape.saveAsMaterial && (
            <MoreItem icon={<PackagePlus size={16} />} label={tShape("menu.saveAsMaterial")} onSelect={() => { shape.saveAsMaterial?.(); menus.close("more"); }} />
          )}
          <MoreItem icon={<Copy size={16} />} label={tShape("menu.duplicate")} onSelect={() => { run({ type: "duplicate" }); menus.close("more"); }} />
          <MoreItem icon={<Trash2 size={16} />} label={tShape("menu.delete")} danger onSelect={() => { run({ type: "delete" }); menus.close("more"); }} />
        </ToolMenu>
      </div>
    </>
  );

  function arrange(action: OverlayArrangeAction) {
    run({ type: "arrange", action });
    menus.close("more");
  }
  function transform(action: "rotateClockwise" | "rotateCounterclockwise" | "horizontal" | "vertical") {
    run({ type: "transform", action });
    menus.close("more");
  }
  function align(action: OverlayAlignAction) {
    run({ type: "align", action });
    menus.close("more");
  }
  function distribute(axis: OverlayDistributeAxis) {
    run({ type: "distribute", axis });
    menus.close("more");
  }
}

const ALIGN_ITEMS = [
  { action: "left", icon: <AlignHorizontalJustifyStart size={16} />, key: "menu.alignLeft" },
  { action: "center", icon: <AlignHorizontalJustifyCenter size={16} />, key: "menu.alignCenter" },
  { action: "right", icon: <AlignHorizontalJustifyEnd size={16} />, key: "menu.alignRight" },
  { action: "top", icon: <AlignVerticalJustifyStart size={16} />, key: "menu.alignTop" },
  { action: "middle", icon: <AlignVerticalJustifyCenter size={16} />, key: "menu.alignMiddle" },
  { action: "bottom", icon: <AlignVerticalJustifyEnd size={16} />, key: "menu.alignBottom" },
] as const satisfies ReadonlyArray<{ action: OverlayAlignAction; icon: ReactNode; key: string }>;

function MoreItem({
  icon,
  label,
  danger = false,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MoreIconItem({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon}
    </button>
  );
}
