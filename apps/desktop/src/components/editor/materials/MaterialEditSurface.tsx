"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowRight,
  Bold,
  ChartSpline,
  Circle,
  Cuboid,
  FileQuestion,
  Italic,
  ListPlus,
  Minus,
  MousePointer2,
  PenLine,
  Sigma,
  Rows3,
  Square,
  Trash2,
  Type,
  Underline,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BlockEditor } from "@/components/editor/BlockEditor";
import {
  EditorToolbar,
  EditorToolbarGroup,
  EditorToolbarIconButton,
  EditorToolbarSeparator,
  EDITOR_TOOLBAR_ICON_SIZE,
} from "@/components/editor/EditorToolbar";
import {
  type OverlayActionRequest,
  type OverlayActionRequestInput,
  type OverlayCommand,
  type OverlayCommandRequest,
  type OverlayImageRequest,
  DEFAULT_OVERLAY_MODE_STATUS_LABEL_ID,
  type OverlayModeStatus,
  type OverlaySelectPointRequest,
  type OverlaySelectionSummary,
} from "@/components/editor/page-overlay-types";
import {
  createEmptyOverlaySnapshot,
  normalizeOverlaySnapshot,
  type SigmaBlock,
  type SigmaDocument,
  type PageOverlay,
  type RichBlock,
} from "@/features/document";
import { canBoxResize, getShapeBounds, resizeBoxShape } from "@/features/drawing";
import { getShapesSelectionBounds } from "@/features/drawing";
import { TextFlowEditor, type TextFlowBlock } from "@/components/editor/TextFlowEditor";
import {
  addRichBlockToProblem,
  createBlock,
  duplicateTopLevelBlock,
  findBlock,
  moveTopLevelBlock,
  removeBlockFromDocument,
  updateBlockInDocument,
  type EditableBlock,
} from "@/lib/document-tree";
import type { MaterialContent } from "@/types/material";
import type { OverlayPoint, OverlayShape, OverlayTool } from "@/components/editor/overlay-canvas/types";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";
import { applyRememberedBoxFrame } from "@/lib/remembered-box-style";

const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
const DEFAULT_MATERIAL_CANVAS_WIDTH = 680;
const DEFAULT_MATERIAL_CANVAS_HEIGHT = 520;
const MATERIAL_CANVAS_PADDING = 80;

const EMPTY_OVERLAY_SELECTION: OverlaySelectionSummary = {
  selectedCount: 0,
  selectedShapeIds: [],
  selectedShapes: [],
  selectedAssets: {},
  locked: false,
  hidden: false,
  grouped: false,
  canAlign: false,
  canDistribute: false,
  canStyleStroke: false,
  canStyleFill: false,
  canStyleLine: false,
  canStyleLineEndpoints: false,
  arrowheadStart: null,
  arrowheadEnd: null,
  fill: { kind: "unavailable" },
};

/**
 * 文言ではなく**辞書キー**を持つ。module 直下のテーブルに訳文を入れると
 * 読み込み時の言語で焼き付き、言語を切り替えてもツールバーだけ元の言語で残る。
 */
const MATERIAL_OVERLAY_TOOLS: Array<{
  command: OverlayCommand;
  labelKey: `tool.${string}`;
  icon: typeof MousePointer2;
}> = [
  { command: "select", labelKey: "tool.select", icon: MousePointer2 },
  { command: "rectangle", labelKey: "tool.rectangle", icon: Square },
  { command: "circle", labelKey: "tool.circle", icon: Circle },
  { command: "line", labelKey: "tool.line", icon: Minus },
  { command: "arrow", labelKey: "tool.arrow", icon: ArrowRight },
  { command: "text", labelKey: "tool.text", icon: Type },
  { command: "graph", labelKey: "tool.graph", icon: ChartSpline },
  { command: "graph3d", labelKey: "tool.graph3d", icon: Cuboid },
  { command: "table", labelKey: "tool.table", icon: Rows3 },
];

interface MaterialEditSurfaceProps {
  content: MaterialContent;
  title: string;
  metadataPanel: ReactNode;
  saving?: boolean;
  formatTarget: string;
  onContentChange: (content: MaterialContent) => void;
}

type MaterialContentSegment =
  | { kind: "flow"; key: string; blocks: TextFlowBlock[] }
  | { kind: "block"; key: string; block: SigmaBlock };

const OverlayCanvasEditor = dynamic(() => import("@/components/editor/OverlayCanvasEditorClient"), {
  loading: () => <div className="overlay-canvas-loading" />,
});

export function MaterialEditSurface({
  content,
  title,
  metadataPanel,
  saving = false,
  formatTarget,
  onContentChange,
}: MaterialEditSurfaceProps) {
  const t = useT("workspace");

  // 新規ブロックの既定文言は文書へ焼き込まれるので、作成時の UI 言語で解決する。
  const tEditor = useT("editor");
  // 図形キャンバスの操作状態 (`OverlayModeStatus.labelId`) を読み上げるため。
  const tShape = useT("shape");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(() => content.blocks[0]?.id ?? null);
  const [overlaySelection, setOverlaySelection] = useState<OverlaySelectionSummary>(EMPTY_OVERLAY_SELECTION);
  const [activeOverlayTool, setActiveOverlayTool] = useState<OverlayTool>({ kind: "select" });
  const [overlayModeStatus, setOverlayModeStatus] = useState<OverlayModeStatus | null>(null);
  const [overlayInteractionEnabled, setOverlayInteractionEnabled] = useState(false);
  const [overlayExternalRevision, setOverlayExternalRevision] = useState(0);
  const [overlayCommandRequest, setOverlayCommandRequest] = useState<OverlayCommandRequest | null>(null);
  const [overlayImageRequest, setOverlayImageRequest] = useState<OverlayImageRequest | null>(null);
  const [overlayActionRequest, setOverlayActionRequest] = useState<OverlayActionRequest | null>(null);
  const [selectPointRequest, setSelectPointRequest] = useState<OverlaySelectPointRequest | null>(null);
  const overlayRequestIdRef = useRef(0);
  const contentLayerRef = useRef<HTMLDivElement | null>(null);
  const [contentLayerSize, setContentLayerSize] = useState({ width: DEFAULT_MATERIAL_CANVAS_WIDTH, height: 0 });

  const segments = useMemo(() => createMaterialContentSegments(content.blocks), [content.blocks]);
  const effectiveSelectedBlockId = selectedBlockId && materialContentHasBlock(content, selectedBlockId)
    ? selectedBlockId
    : content.blocks[0]?.id ?? null;
  const overlay = useMemo<PageOverlay>(() => ({
    overlaySnapshot: content.overlaySnapshot,
  }), [content.overlaySnapshot]);
  const overlayShapeCanvasSize = useMemo(
    () => getMaterialOverlayCanvasSize(content.overlaySnapshot.shapes),
    [content.overlaySnapshot.shapes],
  );
  const materialCanvasSize = useMemo(() => ({
    width: Math.max(DEFAULT_MATERIAL_CANVAS_WIDTH, overlayShapeCanvasSize.width, contentLayerSize.width),
    height: Math.max(DEFAULT_MATERIAL_CANVAS_HEIGHT, overlayShapeCanvasSize.height, contentLayerSize.height),
  }), [contentLayerSize.height, contentLayerSize.width, overlayShapeCanvasSize.height, overlayShapeCanvasSize.width]);
  const selectedShape = useMemo(() => {
    if (overlaySelection.selectedShapeIds.length !== 1) {
      return null;
    }
    const selectedShapeId = overlaySelection.selectedShapeIds[0];
    return content.overlaySnapshot.shapes.find((shape) => shape.id === selectedShapeId) ?? null;
  }, [content.overlaySnapshot.shapes, overlaySelection.selectedShapeIds]);

  useEffect(() => {
    const node = contentLayerRef.current;
    if (!node) {
      return undefined;
    }

    const updateContentLayerSize = () => {
      const rect = node.getBoundingClientRect();
      const nextSize = {
        width: Math.ceil(Math.max(DEFAULT_MATERIAL_CANVAS_WIDTH, node.scrollWidth, rect.width)),
        height: Math.ceil(Math.max(0, node.scrollHeight, rect.height)),
      };
      setContentLayerSize((current) => (
        current.width === nextSize.width && current.height === nextSize.height ? current : nextSize
      ));
    };

    updateContentLayerSize();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(updateContentLayerSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content.blocks]);

  const nextOverlayRequestId = useCallback(() => {
    overlayRequestIdRef.current += 1;
    return overlayRequestIdRef.current;
  }, []);

  const addBlock = useCallback((type: SigmaBlock["type"]) => {
    // 箱は「前に決めた見た目」で入る (設定ダイアログで変えた色や罫がそのまま次にも効く)。
    const block = applyRememberedBoxFrame(createBlock(type, tEditor));
    onContentChange({
      ...content,
      blocks: [...content.blocks, block],
    });
    setOverlayInteractionEnabled(false);
    setSelectedBlockId(block.id);
  }, [content, onContentChange, tEditor]);

  const selectBlock = useCallback((blockId: string) => {
    setOverlayInteractionEnabled(false);
    setSelectedBlockId(blockId);
  }, []);

  const updateBlocks = useCallback((updater: (document: SigmaDocument) => SigmaDocument) => {
    const nextDocument = updater(materialContentToDocument(content));
    onContentChange(materialContentFromDocument(nextDocument, content));
  }, [content, onContentChange]);

  const replaceFlowBlocks = useCallback((previousIds: string[], nextBlocks: TextFlowBlock[], activeBlockId?: string | null) => {
    onContentChange({
      ...content,
      blocks: replaceMaterialTextFlowBlocks(content.blocks, previousIds, nextBlocks),
    });
    setSelectedBlockId(activeBlockId ?? nextBlocks[0]?.id ?? null);
  }, [content, onContentChange]);

  const updateOverlay = useCallback((nextOverlay: PageOverlay) => {
    onContentChange({
      ...content,
      overlaySnapshot: normalizeOverlaySnapshot(nextOverlay.overlaySnapshot ?? createEmptyOverlaySnapshot()),
    });
  }, [content, onContentChange]);

  const updateShape = useCallback((shapeId: string, updater: (shape: OverlayShape) => OverlayShape) => {
    onContentChange(updateMaterialContentShape(content, shapeId, updater));
    setOverlayExternalRevision((current) => current + 1);
  }, [content, onContentChange]);

  const deleteShape = useCallback((shapeId: string) => {
    onContentChange({
      ...content,
      overlaySnapshot: normalizeOverlaySnapshot({
        ...content.overlaySnapshot,
        shapes: content.overlaySnapshot.shapes.filter((shape) => shape.id !== shapeId),
      }),
    });
    setOverlaySelection(EMPTY_OVERLAY_SELECTION);
    setOverlayExternalRevision((current) => current + 1);
  }, [content, onContentChange]);

  const requestOverlayCommand = useCallback((command: OverlayCommand) => {
    setOverlayInteractionEnabled(true);
    setOverlayCommandRequest({ id: nextOverlayRequestId(), command });
  }, [nextOverlayRequestId]);

  const requestOverlayAction = useCallback((input: OverlayActionRequestInput) => {
    setOverlayInteractionEnabled(true);
    setOverlayActionRequest({ id: nextOverlayRequestId(), ...input });
  }, [nextOverlayRequestId]);

  const selectShapeFromList = useCallback((shape: OverlayShape) => {
    const bounds = getShapeBounds(shape);
    const point: OverlayPoint = {
      x: bounds.x + bounds.w / 2,
      y: bounds.y + bounds.h / 2,
    };
    setSelectPointRequest({
      id: nextOverlayRequestId(),
      point,
      targetShapeId: shape.id,
    });
    setOverlayInteractionEnabled(true);
  }, [nextOverlayRequestId]);

  const requestTextMode = useCallback(() => {
    setOverlayInteractionEnabled(false);
    setSelectedBlockId(effectiveSelectedBlockId);
  }, [effectiveSelectedBlockId]);

  return (
    <div className="material-edit-layout" role="group" aria-label={t("asset.editTitle", { replace: { title } })}>
      <div className="material-edit-stage">
        <MaterialToolbar
          activeOverlayTool={activeOverlayTool}
          overlayInteractionEnabled={overlayInteractionEnabled}
          onAddBlock={addBlock}
          onOverlayCommand={requestOverlayCommand}
          onOverlayDelete={() => requestOverlayAction({ type: "delete" })}
          overlaySelection={overlaySelection}
          formatTarget={formatTarget}
        />
        <div className="material-edit-canvas-shell">
          <div className="material-edit-paper">
            <div
              className="material-edit-composite"
              style={{
                width: materialCanvasSize.width,
                minHeight: materialCanvasSize.height,
              }}
            >
              <div ref={contentLayerRef} className="material-edit-content-layer">
                {content.blocks.length > 0 ? (
                  <div className="material-edit-blocks">
                    {segments.map((segment) => segment.kind === "flow" ? (
                      <div className="material-edit-flow-run" key={segment.key}>
                        <TextFlowEditor
                          blocks={segment.blocks}
                          selectedId={effectiveSelectedBlockId}
                          historyRevision={0}
                          showPlaceholder
                          placeholder={t("asset.bodyPlaceholder")}
                          materials={[]}
                          formatTarget={formatTarget}
                          onSelect={selectBlock}
                          onFocusChange={(focused, blockIds, activeBlockId) => {
                            if (focused) {
                              setOverlayInteractionEnabled(false);
                              setSelectedBlockId(activeBlockId ?? blockIds[0] ?? null);
                            }
                          }}
                          onChange={replaceFlowBlocks}
                        />
                      </div>
                    ) : (
                      <div className="material-edit-block-run" key={segment.key}>
                        <BlockEditor
                          block={segment.block}
                          selectedId={effectiveSelectedBlockId}
                          historyRevision={0}
                          formatTarget={formatTarget}
                          onSelect={selectBlock}
                          onChange={(blockId, updater) => updateBlocks((document) => updateBlockInDocument(
                            document,
                            blockId,
                            (node) => updater(node as SigmaBlock | RichBlock) as EditableBlock,
                          ))}
                          onDelete={(blockId) => updateBlocks((document) => removeBlockFromDocument(document, blockId))}
                          onDuplicate={(blockId) => updateBlocks((document) => duplicateTopLevelBlock(document, blockId))}
                          onMove={(blockId, direction) => updateBlocks((document) => moveTopLevelBlock(document, blockId, direction))}
                          onAddProblemBlock={(problemId, area, blockToAdd) => updateBlocks((document) => addRichBlockToProblem(document, problemId, area, blockToAdd))}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="material-edit-empty">
                    <Type size={18} />
                    <span>{t("asset.noBodyBlocks")}</span>
                  </div>
                )}
              </div>

              <div
                className={`material-edit-overlay-layer ${overlayInteractionEnabled ? "editing" : "text-mode"}`}
                style={{
                  width: materialCanvasSize.width,
                  height: materialCanvasSize.height,
                }}
                aria-label={tShape("material.surfaceAria", { replace: { status: tShape(`mode.${overlayModeStatus?.labelId ?? DEFAULT_OVERLAY_MODE_STATUS_LABEL_ID}`) } })}
              >
                <OverlayCanvasEditor
                  externalRevision={overlayExternalRevision}
                  overlay={overlay}
                  canvasWidth={materialCanvasSize.width}
                  canvasHeight={materialCanvasSize.height}
                  bleedValues={{ x: 0, top: 0 }}
                  imageInsertAreaWidth={materialCanvasSize.width}
                  imageInsertAreaHeight={materialCanvasSize.height}
                  commandRequest={overlayCommandRequest}
                  imageRequest={overlayImageRequest}
                  actionRequest={overlayActionRequest}
                  selectPointRequest={selectPointRequest}
                  onCommandHandled={(requestId) => {
                    if (overlayCommandRequest?.id === requestId) {
                      setOverlayCommandRequest(null);
                    }
                  }}
                  onImageHandled={(requestId) => {
                    if (overlayImageRequest?.id === requestId) {
                      setOverlayImageRequest(null);
                    }
                  }}
                  onActionHandled={(requestId) => {
                    if (overlayActionRequest?.id === requestId) {
                      setOverlayActionRequest(null);
                    }
                  }}
                  onSelectPointHandled={(requestId) => {
                    if (selectPointRequest?.id === requestId) {
                      setSelectPointRequest(null);
                    }
                  }}
                  onRequestTextMode={requestTextMode}
                  onModeStatusChange={setOverlayModeStatus}
                  onSelectionSummaryChange={setOverlaySelection}
                  onActiveToolChange={setActiveOverlayTool}
                  syncBlockAnchors={false}
                  onChange={updateOverlay}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <aside className="material-edit-side">
        {metadataPanel}
        <section className="material-edit-side-section">
          <div className="material-edit-side-title">{t("asset.shapePartsHeading")}</div>
          {content.overlaySnapshot.shapes.length > 0 ? (
            <div className="material-edit-shape-list">
              {content.overlaySnapshot.shapes.map((shape, index) => (
                <button
                  key={shape.id}
                  type="button"
                  className={`material-edit-shape-row${overlaySelection.selectedShapeIds.includes(shape.id) ? " selected" : ""}`}
                  onClick={() => selectShapeFromList(shape)}
                >
                  <span>{getMaterialShapeLabel(shape, tShape)}</span>
                  <small>{index + 1}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="material-edit-side-note">{t("asset.noShapes")}</p>
          )}
          {selectedShape && (
            <MaterialShapeEditor
              shape={selectedShape}
              saving={saving}
              onChange={(updater) => updateShape(selectedShape.id, updater)}
              onDelete={() => deleteShape(selectedShape.id)}
            />
          )}
        </section>
      </aside>
    </div>
  );
}

function MaterialToolbar({
  activeOverlayTool,
  overlayInteractionEnabled,
  overlaySelection,
  formatTarget,
  onAddBlock,
  onOverlayCommand,
  onOverlayDelete,
}: {
  activeOverlayTool: OverlayTool;
  overlayInteractionEnabled: boolean;
  overlaySelection: OverlaySelectionSummary;
  formatTarget: string;
  onAddBlock: (type: SigmaBlock["type"]) => void;
  onOverlayCommand: (command: OverlayCommand) => void;
  onOverlayDelete: () => void;
}) {
  const t = useT("workspace");

  const dispatchFormat = (command: string, value?: string) => {
    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, {
      detail: {
        command,
        ...(value === undefined ? {} : { value }),
        target: formatTarget,
      },
    }));
  };
  const insertInlineMath = () => {
    window.dispatchEvent(new CustomEvent(INSERT_INLINE_MATH_EVENT, {
      detail: { tex: "", edit: true, target: formatTarget },
    }));
  };

  return (
    <EditorToolbar ariaLabel={t("asset.toolbar")} bordered>
      <EditorToolbarGroup ariaLabel={t("asset.addBlockGroup")}>
        <EditorToolbarIconButton title={t("asset.addBody")} aria-label={t("asset.addBody")} onClick={() => onAddBlock("paragraph")}>
          <Type size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.addHeading")} aria-label={t("asset.addHeading")} onClick={() => onAddBlock("heading")}>
          <PenLine size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.addList")} aria-label={t("asset.addList")} onClick={() => onAddBlock("list")}>
          <ListPlus size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.addProblem")} aria-label={t("asset.addProblem")} onClick={() => onAddBlock("problem")}>
          <FileQuestion size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.addBox")} aria-label={t("asset.addBox")} onClick={() => onAddBlock("boxBlock")}>
          <Square size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
      </EditorToolbarGroup>
      <EditorToolbarSeparator />
      <EditorToolbarGroup ariaLabel={t("asset.formatGroup")}>
        <EditorToolbarIconButton title={t("asset.bold")} aria-label={t("asset.bold")} onClick={() => dispatchFormat("bold")}>
          <Bold size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.italic")} aria-label={t("asset.italic")} onClick={() => dispatchFormat("italic")}>
          <Italic size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.underline")} aria-label={t("asset.underline")} onClick={() => dispatchFormat("underline")}>
          <Underline size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.inlineMath")} aria-label={t("asset.inlineMath")} onClick={insertInlineMath}>
          <Sigma size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.alignLeft")} aria-label={t("asset.alignLeft")} onClick={() => dispatchFormat("textAlign", "left")}>
          <AlignLeft size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.alignCenter")} aria-label={t("asset.alignCenter")} onClick={() => dispatchFormat("textAlign", "center")}>
          <AlignCenter size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <EditorToolbarIconButton title={t("asset.alignRight")} aria-label={t("asset.alignRight")} onClick={() => dispatchFormat("textAlign", "right")}>
          <AlignRight size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
      </EditorToolbarGroup>
      <EditorToolbarSeparator />
      <EditorToolbarGroup ariaLabel={t("asset.shapeGroup")}>
        {MATERIAL_OVERLAY_TOOLS.map(({ command, labelKey, icon: Icon }) => {
          const label = t(labelKey as never) as string;
          const selected = overlayInteractionEnabled && (
            command === "select"
              ? activeOverlayTool.kind === "select"
              : activeOverlayTool.kind === "insert" && activeOverlayTool.command === command
          );
          return (
            <EditorToolbarIconButton
              key={command}
              active={selected}
              title={label}
              aria-label={label}
              aria-pressed={selected}
              onClick={() => onOverlayCommand(command)}
            >
              <Icon size={EDITOR_TOOLBAR_ICON_SIZE} />
            </EditorToolbarIconButton>
          );
        })}
        <EditorToolbarIconButton
          danger
          title={t("asset.deleteSelectedShape")}
          aria-label={t("asset.deleteSelectedShape")}
          disabled={overlaySelection.selectedCount === 0}
          onClick={onOverlayDelete}
        >
          <Trash2 size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
      </EditorToolbarGroup>
    </EditorToolbar>
  );
}

interface MaterialShapeEditorProps {
  shape: OverlayShape;
  saving: boolean;
  onChange: (updater: (shape: OverlayShape) => OverlayShape) => void;
  onDelete: () => void;
}

function MaterialShapeEditor({ shape, saving, onChange, onDelete }: MaterialShapeEditorProps) {
  const t = useT("workspace");
  const tShape = useT("shape");

  const bounds = getShapeBounds(shape);
  const canResize = canBoxResize(shape);
  const canRotate = shape.type !== "group" && shape.type !== "tableShape";
  const rotationDeg = ((shape.rotation ?? 0) * 180) / Math.PI;

  const updateNumber = (rawValue: string, updater: (shape: OverlayShape, value: number) => OverlayShape) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return;
    }
    onChange((current) => updater(current, value));
  };

  return (
    <div className="material-edit-shape-editor">
      <div className="material-edit-shape-editor-title">{getMaterialShapeLabel(shape, tShape)}</div>
      <div className="material-edit-number-grid">
        <label>
          <span>X</span>
          <input
            type="number"
            value={formatMaterialNumber(shape.x)}
            disabled={saving}
            onChange={(event) => updateNumber(event.target.value, (current, value) => ({ ...current, x: value }))}
          />
        </label>
        <label>
          <span>Y</span>
          <input
            type="number"
            value={formatMaterialNumber(shape.y)}
            disabled={saving}
            onChange={(event) => updateNumber(event.target.value, (current, value) => ({ ...current, y: value }))}
          />
        </label>
        <label>
          <span>{t("asset.width")}</span>
          <input
            type="number"
            min={1}
            disabled={saving || !canResize}
            value={formatMaterialNumber(bounds.w)}
            onChange={(event) => updateNumber(event.target.value, (current, value) => (
              canBoxResize(current) ? resizeBoxShape(current, { ...getShapeBounds(current), w: value }) : current
            ))}
          />
        </label>
        <label>
          <span>{t("asset.height")}</span>
          <input
            type="number"
            min={1}
            disabled={saving || !canResize}
            value={formatMaterialNumber(bounds.h)}
            onChange={(event) => updateNumber(event.target.value, (current, value) => (
              canBoxResize(current) ? resizeBoxShape(current, { ...getShapeBounds(current), h: value }) : current
            ))}
          />
        </label>
        <label>
          <span>{t("asset.rotation")}</span>
          <input
            type="number"
            step={5}
            disabled={saving || !canRotate}
            value={formatMaterialNumber(rotationDeg)}
            onChange={(event) => updateNumber(event.target.value, (current, value) => (
              canRotate ? { ...current, rotation: (value * Math.PI) / 180 } : current
            ))}
          />
        </label>
      </div>
      <button type="button" className="button danger subtle material-edit-delete-shape" disabled={saving} onClick={onDelete}>
        <Trash2 size={14} />
        {t("asset.deleteShape")}
      </button>
    </div>
  );
}

function createMaterialContentSegments(blocks: SigmaBlock[]): MaterialContentSegment[] {
  const segments: MaterialContentSegment[] = [];
  let flowBlocks: TextFlowBlock[] = [];

  const flushFlow = () => {
    if (flowBlocks.length === 0) {
      return;
    }
    segments.push({
      kind: "flow",
      key: `flow-${flowBlocks[0]?.id ?? segments.length}`,
      blocks: flowBlocks,
    });
    flowBlocks = [];
  };

  blocks.forEach((block) => {
    if (isMaterialTextFlowBlock(block)) {
      flowBlocks.push(block);
      return;
    }
    flushFlow();
    segments.push({ kind: "block", key: block.id, block });
  });
  flushFlow();

  return segments;
}

function isMaterialTextFlowBlock(block: SigmaBlock): block is Exclude<TextFlowBlock, { type: "problem" }> {
  return (
    block.type === "section" ||
    block.type === "heading" ||
    block.type === "paragraph" ||
    block.type === "list" ||
    block.type === "boxBlock" ||
    block.type === "layoutSection"
  );
}

function replaceMaterialTextFlowBlocks(
  content: SigmaBlock[],
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
): SigmaBlock[] {
  if (previousIds.length === 0) {
    return content;
  }

  const previousIdSet = new Set(previousIds);
  const firstIndex = content.findIndex((block) => previousIdSet.has(block.id));
  if (firstIndex < 0) {
    return content;
  }

  let deleteCount = 0;
  while (content[firstIndex + deleteCount] && previousIdSet.has(content[firstIndex + deleteCount].id)) {
    deleteCount += 1;
  }

  const next = [...content];
  next.splice(firstIndex, deleteCount, ...nextBlocks);
  return next;
}

function materialContentToDocument(content: MaterialContent): SigmaDocument {
  return {
    version: "2.0",
    docId: "material_edit",
    // ブロック操作ヘルパーを通すためだけの入れ物。`materialContentFromDocument` が
    // 戻すときに metadata は捨てられ、画面にも保存先にも出ない。表示文言ではないので
    // 翻訳しない。
    metadata: { title: "素材" },
    content: content.blocks,
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true, includeAnswers: true },
      answerBook: { showSolutions: true, showHints: true, includeAnswers: true, onlySolutions: true },
    },
  };
}

function materialContentFromDocument(document: SigmaDocument, current: MaterialContent): MaterialContent {
  return {
    ...current,
    blocks: document.content,
  };
}

function materialContentHasBlock(content: MaterialContent, blockId: string): boolean {
  return Boolean(findBlock(materialContentToDocument(content), blockId));
}

function updateMaterialContentShape(
  content: MaterialContent,
  shapeId: string,
  updater: (shape: OverlayShape) => OverlayShape,
): MaterialContent {
  return {
    ...content,
    overlaySnapshot: normalizeOverlaySnapshot({
      ...content.overlaySnapshot,
      shapes: content.overlaySnapshot.shapes.map((shape) => shape.id === shapeId ? updater(shape) : shape),
    }),
  };
}

function getMaterialOverlayCanvasSize(shapes: OverlayShape[]): { width: number; height: number } {
  const bounds = getShapesSelectionBounds(shapes);
  if (!bounds) {
    return {
      width: DEFAULT_MATERIAL_CANVAS_WIDTH,
      height: DEFAULT_MATERIAL_CANVAS_HEIGHT,
    };
  }
  return {
    width: Math.max(DEFAULT_MATERIAL_CANVAS_WIDTH, Math.ceil(bounds.x + bounds.w + MATERIAL_CANVAS_PADDING)),
    height: Math.max(DEFAULT_MATERIAL_CANVAS_HEIGHT, Math.ceil(bounds.y + bounds.h + MATERIAL_CANVAS_PADDING)),
  };
}

function formatMaterialNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 素材パネルに出す図形の短い呼び名。
 *
 * **呼び名の出典は `shape.shapeKind.*` 1 か所**にする (AI 向けの記述を作る
 * `describeOverlayShape` も同じ辞書を引く)。ここに 2 つ目の綴りを置くと、
 * 同じ図形が画面と AI 出力で違う名前になる。
 */
function getMaterialShapeLabel(shape: OverlayShape, tShape: Translate<"shape">): string {
  if (shape.type === "geo") {
    const geo = shape.props.geo;
    if (geo === "regularPolygon") {
      return tShape("shapeKind.regularPolygonSides", { replace: { sides: shape.props.polygonSides ?? 5 } });
    }
    if (geo === "ellipse") {
      return tShape("shapeKind.ellipseOrCircle");
    }
    const known = ["rectangle", "triangle", "diamond", "pentagon", "blockArrow"] as const;
    return (known as readonly string[]).includes(geo)
      ? tShape(`shapeKind.${geo}` as never) as string
      : tShape("shapeKind.generic");
  }
  if (shape.type === "arrow") return tShape("shapeKind.arrow");
  if (shape.type === "line") return tShape("shapeKind.line");
  if (shape.type === "arc") return tShape("shapeKind.arc");
  if (shape.type === "text") return tShape("shapeKind.text");
  if (shape.type === "image") return tShape("shapeKind.image");
  if (shape.type === "callout") return tShape("shapeKind.callout");
  if (shape.type === "graph2dShape") return tShape("shapeKind.graphPlain");
  if (shape.type === "graph3dShape") return tShape("shapeKind.graph3dPlain");
  if (shape.type === "tableShape") return tShape("shapeKind.tablePlain");
  if (shape.type === "chartShape") return tShape("shapeKind.chartPlain");
  if (shape.type === "group") return shape.props.name || tShape("shapeKind.group");
  return tShape("shapeKind.generic");
}
