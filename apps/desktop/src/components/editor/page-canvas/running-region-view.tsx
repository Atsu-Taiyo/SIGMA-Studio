"use client";
import { useEditorExtensions } from "@/components/editor/editor-extension-context";
import { TextFlowEditor } from "@/components/editor/TextFlowEditor";
import {
  getRunningRegionBoundsMm,
  getRunningRegionOverlaySize,
  mmToPx,
  type PageLayout,
  type PageMetrics,
  type PageOverlay,
  type PageRunningRegion,
} from "@/features/document";
import { type TextFlowBlock } from "@/features/text-editing";
import { useT } from "@/lib/i18n/react";
import type { MouseEvent as ReactMouseEvent,PointerEvent as ReactPointerEvent } from "react";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import type { OverlayTool } from "../overlay-canvas/types";
import type {
  OverlayActionRequest,
  OverlayArrangeAction,
  OverlayChangeOptions,
  OverlayCommandRequest,
  OverlayImageRequest,
  OverlayModeStatus,
  OverlaySelectionSummary,
  OverlaySelectPointRequest,
} from "../page-overlay-types";
import { PageRunningRegionOverlay } from "../PageRunningRegionOverlay";
import { type ClientPoint } from "./caret-focus";
import { OverlayCanvasEditor } from "./overlay-editor-surface";
import { PageMarginRuler } from "./page-chrome";
import { pageRunningRegionToTextFlowBlocks } from "./running-region-text-model";
import type { PageMarginEdge,RunningRegionEdge,RunningRegionKind } from "./types";
import { useOverlayPreviewHandoff } from "./use-overlay-preview-handoff";

export function RunningRegionControls({
  marginEditing,
  layout,
  metrics,
  pageTopPx,
  pageNumber,
  editingKind,
  editingPageNumber,
  focusRequest,
  historyRevision,
  onEdit,
  onBlocksChange,
  onContentHeightChange,
  onEdgePointerDown,
  onMarginPointerDown,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  runningRegionOverlayEditing,
  onRunningRegionOverlayEditingChange,
  onRunningRegionOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  marginEditing: boolean;
  layout: PageLayout;
  metrics: PageMetrics;
  pageTopPx: number;
  pageNumber: number;
  editingKind: RunningRegionKind | null;
  editingPageNumber: number;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  onEdgePointerDown: (
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onMarginPointerDown: (
    edge: PageMarginEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  runningRegionOverlayEditing: boolean;
  onRunningRegionOverlayEditingChange: (editing: boolean) => void;
  onRunningRegionOverlayChange: (
    kind: RunningRegionKind,
    overlay: PageOverlay,
    options?: OverlayChangeOptions,
  ) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditorText = useT("editor");
  return (
    <div className="page-layout-control-sheet" style={{ top: `${pageTopPx}px` }}>
      {marginEditing && (
        <div
          className="page-content-guide"
          style={{
            top: `${metrics.margins.topPx}px`,
            left: `${metrics.margins.leftPx}px`,
            width: `${metrics.content.widthPx}px`,
            height: `${metrics.content.heightPx}px`,
          }}
        />
      )}
      {marginEditing && (
        <PageMarginRuler
          layout={layout}
          metrics={metrics}
          onMarginPointerDown={onMarginPointerDown}
        />
      )}
      <RunningRegionBand
        kind="header"
        label={tEditorText("running.header")}
        region={layout.header}
        metrics={metrics}
        layout={layout}
        pageNumber={pageNumber}
        editing={editingKind === "header" && pageNumber === editingPageNumber}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onBlocksChange={onBlocksChange}
        onContentHeightChange={onContentHeightChange}
        onEdgePointerDown={onEdgePointerDown}
        overlayCommandRequest={overlayCommandRequest}
        overlayImageRequest={overlayImageRequest}
        overlayActionRequest={overlayActionRequest}
        overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
        overlayEditing={runningRegionOverlayEditing && editingKind === "header"}
        onOverlayEditingChange={onRunningRegionOverlayEditingChange}
        onOverlayChange={onRunningRegionOverlayChange}
        onOverlayCommandHandled={onOverlayCommandHandled}
        onOverlayImageHandled={onOverlayImageHandled}
        onOverlayActionHandled={onOverlayActionHandled}
        onOverlayModeStatusChange={onOverlayModeStatusChange}
        onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
        onOverlayActiveToolChange={onOverlayActiveToolChange}
      />
      <RunningRegionBand
        kind="footer"
        label={tEditorText("running.footer")}
        region={layout.footer}
        metrics={metrics}
        layout={layout}
        pageNumber={pageNumber}
        editing={editingKind === "footer" && pageNumber === editingPageNumber}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onBlocksChange={onBlocksChange}
        onContentHeightChange={onContentHeightChange}
        onEdgePointerDown={onEdgePointerDown}
        overlayCommandRequest={overlayCommandRequest}
        overlayImageRequest={overlayImageRequest}
        overlayActionRequest={overlayActionRequest}
        overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
        overlayEditing={runningRegionOverlayEditing && editingKind === "footer"}
        onOverlayEditingChange={onRunningRegionOverlayEditingChange}
        onOverlayChange={onRunningRegionOverlayChange}
        onOverlayCommandHandled={onOverlayCommandHandled}
        onOverlayImageHandled={onOverlayImageHandled}
        onOverlayActionHandled={onOverlayActionHandled}
        onOverlayModeStatusChange={onOverlayModeStatusChange}
        onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
        onOverlayActiveToolChange={onOverlayActiveToolChange}
      />
    </div>
  );
}

export function RunningRegionBand({
  kind,
  label,
  region,
  metrics,
  layout,
  pageNumber,
  editing,
  focusRequest,
  historyRevision,
  onEdit,
  onBlocksChange,
  onContentHeightChange,
  onEdgePointerDown,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  overlayEditing,
  onOverlayEditingChange,
  onOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  kind: RunningRegionKind;
  label: string;
  region?: PageRunningRegion;
  metrics: PageMetrics;
  layout: PageLayout;
  pageNumber: number;
  editing: boolean;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  onEdgePointerDown: (
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  overlayEditing: boolean;
  onOverlayEditingChange: (editing: boolean) => void;
  onOverlayChange: (kind: RunningRegionKind, overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditor = useT("editor");
  if (!region?.enabled) {
    return null;
  }

  const bounds = getRunningRegionBoundsMm(layout, kind);
  const top = mmToPx(bounds.topMm);
  // Shared with `PageRunningRegionView`: the band used to subtract the page sheet's 2px border
  // while the displayed region did not. An SVG `viewBox` hid the difference; React places shapes at
  // absolute px, so the two surfaces have to agree on the overlay's coordinate space.
  const { heightPx: height, widthPx: width } = getRunningRegionOverlaySize(
    metrics.content.widthPx,
    region,
  );

  return (
    <div
      className={`page-running-editor-band ${kind} ${editing ? "editing" : ""}`}
      style={{
        top: `${top}px`,
        left: `${metrics.margins.leftPx}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onEdit(kind, pageNumber);
      }}
    >
      {editing && <span className="page-running-editor-label">{label}</span>}
      {editing && (
        <RunningRegionDirectEditor
          kind={kind}
          label={label}
          region={region}
          focusRequest={focusRequest}
          historyRevision={historyRevision}
          onBlocksChange={onBlocksChange}
          onContentHeightChange={onContentHeightChange}
          overlayEditing={overlayEditing}
          overlayCommandRequest={overlayCommandRequest}
          overlayImageRequest={overlayImageRequest}
          overlayActionRequest={overlayActionRequest}
          overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
          overlayWidth={width}
          overlayHeight={height}
          onOverlayEditingChange={onOverlayEditingChange}
          onOverlayChange={onOverlayChange}
          onOverlayCommandHandled={onOverlayCommandHandled}
          onOverlayImageHandled={onOverlayImageHandled}
          onOverlayActionHandled={onOverlayActionHandled}
          onOverlayModeStatusChange={onOverlayModeStatusChange}
          onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
          onOverlayActiveToolChange={onOverlayActiveToolChange}
        />
      )}
      {editing && (
        <>
          <button
            type="button"
            className="page-running-edge start"
            aria-label={tEditor("running.startEdge", { replace: { region: label } })}
            title={tEditor("running.startEdge", { replace: { region: label } })}
            onPointerDown={(event) => onEdgePointerDown(kind, "start", event)}
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            className="page-running-edge end"
            aria-label={tEditor("running.endEdge", { replace: { region: label } })}
            title={tEditor("running.endEdge", { replace: { region: label } })}
            onPointerDown={(event) => onEdgePointerDown(kind, "end", event)}
            onClick={(event) => event.stopPropagation()}
          />
        </>
      )}
    </div>
  );
}

export function RunningRegionDirectEditor({
  kind,
  label,
  region,
  focusRequest,
  historyRevision,
  onBlocksChange,
  onContentHeightChange,
  overlayEditing,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  overlayWidth,
  overlayHeight,
  onOverlayEditingChange,
  onOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  kind: RunningRegionKind;
  label: string;
  region: PageRunningRegion;
  focusRequest: number;
  historyRevision: number;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  overlayEditing: boolean;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  overlayWidth: number;
  overlayHeight: number;
  onOverlayEditingChange: (editing: boolean) => void;
  onOverlayChange: (kind: RunningRegionKind, overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditor = useT("editor");
  const { auxiliarySurfaceExtensions } = useEditorExtensions();
  const {
    overlayEditPolicy,
    overlayShapeDecorations,
    textFlowEditPolicy,
  } = auxiliarySurfaceExtensions ?? {};
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [selectedRunningBlockId, setSelectedRunningBlockId] = useState<string | null>(null);
  const [runningSelectPointRequest, setRunningSelectPointRequest] = useState<OverlaySelectPointRequest | null>(null);
  const runningSelectPointRequestIdRef = useRef(0);
  const blocks = useMemo(() => pageRunningRegionToTextFlowBlocks(region, kind), [kind, region]);
  // The interactive layer sits above the running text at `z-index: 3` with `pointer-events: auto`,
  // so mounting it for a shapeless header would swallow every click meant for the text editor. The
  // removed SVG ghost returned null in exactly this case (the serializer bailed on an empty shape
  // list); the display surface has no such constraint because it is never interactive.
  const runningOverlayHasShapes = useMemo(
    () => (region.overlay?.overlaySnapshot?.shapes?.length ?? 0) > 0,
    [region.overlay?.overlaySnapshot],
  );

  const focusRunningRegionTextEditor = useCallback(() => {
    window.setTimeout(() => {
      const editable = editorRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus({ preventScroll: true });
    }, 0);
  }, []);

  useEffect(() => {
    if (overlayEditing) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const editable = editorRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, overlayEditing]);

  useLayoutEffect(() => {
    if (overlayEditing) {
      return;
    }

    const shell = editorRef.current?.querySelector<HTMLElement>(".text-flow-shell");
    if (!shell) {
      return;
    }

    const measuredHeight = Math.max(shell.scrollHeight, shell.getBoundingClientRect().height);
    onContentHeightChange(kind, measuredHeight);
  }, [blocks, kind, onContentHeightChange, overlayEditing, overlayWidth]);

  const nextRunningSelectPointRequestId = useCallback(() => {
    runningSelectPointRequestIdRef.current += 1;
    return Date.now() * 1000 + runningSelectPointRequestIdRef.current;
  }, []);

  const requestRunningRegionOverlaySelection = useCallback((
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    startCrop: boolean,
    dragEndScreenPoint?: ClientPoint,
  ) => {
    if (bounds.width <= 0 || bounds.height <= 0 || overlayWidth <= 0 || overlayHeight <= 0) {
      return;
    }

    onOverlayEditingChange(true);
    setRunningSelectPointRequest({
      id: nextRunningSelectPointRequestId(),
      point: {
        x: ((clientX - bounds.left) / bounds.width) * overlayWidth,
        y: ((clientY - bounds.top) / bounds.height) * overlayHeight,
      },
      screenPoint: {
        x: clientX,
        y: clientY,
      },
      dragEndPoint: dragEndScreenPoint
        ? {
            x: ((dragEndScreenPoint.x - bounds.left) / bounds.width) * overlayWidth,
            y: ((dragEndScreenPoint.y - bounds.top) / bounds.height) * overlayHeight,
          }
        : undefined,
      startCrop,
      focusTextOnMiss: false,
    });
  }, [nextRunningSelectPointRequestId, onOverlayEditingChange, overlayHeight, overlayWidth]);

  const completeRunningPreviewHandoff = useCallback((bounds: DOMRect, start: ClientPoint, end: ClientPoint) => {
    requestRunningRegionOverlaySelection(bounds, start.x, start.y, false, end);
  }, [requestRunningRegionOverlaySelection]);
  const activateRunningOverlayEditing = useCallback(() => onOverlayEditingChange(true), [onOverlayEditingChange]);
  const startRunningRegionOverlayPreviewPointerHandoff = useOverlayPreviewHandoff(completeRunningPreviewHandoff, activateRunningOverlayEditing);

  const handleRunningRegionOverlayPreviewPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    startRunningRegionOverlayPreviewPointerHandoff(event, event.currentTarget.getBoundingClientRect());
  }, [startRunningRegionOverlayPreviewPointerHandoff]);

  const handleRunningRegionOverlayPreviewDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    requestRunningRegionOverlaySelection(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      true,
    );
  }, [requestRunningRegionOverlaySelection]);

  const handleRunningRegionSelectPointHandled = useCallback((requestId: number, hitShape: boolean) => {
    setRunningSelectPointRequest((current) => current?.id === requestId ? null : current);
    if (!hitShape) {
      onOverlayEditingChange(false);
      focusRunningRegionTextEditor();
    }
  }, [focusRunningRegionTextEditor, onOverlayEditingChange]);

  return (
    <div
      className={`page-running-direct-editor ${kind}`}
      role="group"
      aria-label={tEditor("running.edit", { replace: { region: label } })}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="page-running-direct-flow" ref={editorRef}>
        <TextFlowEditor
          blocks={blocks}
          selectedId={selectedRunningBlockId}
          placeholder={tEditor("running.placeholder", { replace: { region: label } })}
          historyRevision={historyRevision}
          showPlaceholder
          onSelect={setSelectedRunningBlockId}
          onChange={(_previousIds, nextBlocks) => onBlocksChange(kind, nextBlocks)}
          onFocusChange={(focused, blockIds) => {
            if (focused && !selectedRunningBlockId) {
              setSelectedRunningBlockId(blockIds[0] ?? null);
            }
          }}
          editPolicy={textFlowEditPolicy}
        />
      </div>
      {overlayEditing ? (
        <div className="page-running-direct-overlay editing">
          <OverlayCanvasEditor
            key={`${kind}-running-overlay`}
            externalRevision={historyRevision}
            overlay={region.overlay ?? {}}
            canvasWidth={overlayWidth}
            canvasHeight={overlayHeight}
            bleedValues={{ x: 0, top: 0 }}
            imageInsertAreaWidth={overlayWidth}
            imageInsertAreaHeight={overlayHeight}
            commandRequest={overlayCommandRequest}
            imageRequest={overlayImageRequest}
            actionRequest={overlayActionRequest}
            arrangeShortcutLabels={overlayArrangeShortcutLabels}
            selectPointRequest={runningSelectPointRequest}
            editPolicy={overlayEditPolicy}
            shapeDecorations={overlayShapeDecorations}
            onCommandHandled={onOverlayCommandHandled}
            onImageHandled={onOverlayImageHandled}
            onActionHandled={onOverlayActionHandled}
            onSelectPointHandled={handleRunningRegionSelectPointHandled}
            onRequestTextMode={() => {
              setRunningSelectPointRequest(null);
              onOverlayEditingChange(false);
              focusRunningRegionTextEditor();
            }}
            onModeStatusChange={onOverlayModeStatusChange}
            onSelectionSummaryChange={onOverlaySelectionSummaryChange}
            onActiveToolChange={onOverlayActiveToolChange}
            onChange={(nextOverlay, options) => onOverlayChange(kind, nextOverlay, options)}
          />
        </div>
      ) : (
        runningOverlayHasShapes ? (
          <PageRunningRegionOverlay
            overlay={region.overlay}
            widthPx={overlayWidth}
            heightPx={overlayHeight}
            className="page-running-direct-overlay preview"
            interactive
            onPointerDown={handleRunningRegionOverlayPreviewPointerDown}
            onDoubleClick={handleRunningRegionOverlayPreviewDoubleClick}
          />
        ) : null
      )}
    </div>
  );
}
