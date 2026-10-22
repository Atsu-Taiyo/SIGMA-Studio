"use client";
import { useEditorExtensions } from "@/components/editor/editor-extension-context";
import { TextFlowEditor } from "@/components/editor/TextFlowEditor";
import {
  createRunningRegionFieldValues,
  getRunningRegionBoundsMm,
  getRunningRegionOverlaySize,
  hasRunningRegionPageContent,
  isRunningRegionShownOnPage,
  mmToPx,
  pageRunningRegionHasContentOnPage,
  type MathFractionSizing,
  type PageLayout,
  type PageMetrics,
  type PageOverlay,
  type PageRunningRegion,
  type RunningRegionFieldValues,
  type RunningRegionPageRange,
} from "@/features/document";
import { type TextFlowBlock } from "@/features/text-editing";
import { useT } from "@/lib/i18n/react";
import type { CSSProperties,MouseEvent as ReactMouseEvent,PointerEvent as ReactPointerEvent } from "react";
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
import { DocumentWritableContext } from "../document-session-context";
import { PageRunningRegionOverlay } from "../PageRunningRegionOverlay";
import { type ClientPoint } from "./caret-focus";
import { OverlayCanvasEditor } from "./overlay-editor-surface";
import { PageMarginRuler } from "./page-chrome";
import { formatMm } from "./page-layout-format";
import { RunningRegionOptions } from "./running-region-options";
import { pageRunningRegionToTextFlowBlocks } from "./running-region-text-model";
import type { PageMarginEdge,RunningRegionEdge,RunningRegionKind } from "./types";
import { useOverlayPreviewHandoff } from "./use-overlay-preview-handoff";

const NOOP = () => {};

/**
 * 編集していないページのヘッダー/フッター。本文と**同じエディタ** (`TextFlowEditor`) を
 * 読み取り専用で描く。編集中のページ (`RunningRegionDirectEditor`) と同じ部品・同じ装飾なので、
 * 編集に入っても出ても、PDF でも見え方が変わらない (空白・差し込み・数式・書式)。
 * 置き場所は紙 (`.a4-page-sheet`) の中で、図形より下に描く。
 */
export function RunningRegionPageView({
  region,
  kind,
  layout,
  title,
  pageNumber,
  totalPages,
  metrics,
  mathFractionSizing,
}: {
  region?: PageRunningRegion;
  kind: RunningRegionKind;
  layout: PageLayout;
  title: string;
  pageNumber: number;
  totalPages: number;
  metrics: PageMetrics;
  mathFractionSizing?: MathFractionSizing | null;
}) {
  const blocks = useMemo(() => region ? pageRunningRegionToTextFlowBlocks(region, kind, pageNumber) : [], [kind, pageNumber, region]);
  const pageNumberStart = layout.pageNumberStart;
  const fieldValues = useMemo<RunningRegionFieldValues>(
    () => createRunningRegionFieldValues(title, pageNumber, totalPages, pageNumberStart),
    [pageNumber, pageNumberStart, title, totalPages],
  );
  if (!region?.enabled || !pageRunningRegionHasContentOnPage(region, pageNumber) || !isRunningRegionShownOnPage(region, pageNumber)) {
    return null;
  }

  // 箱は編集中の帯 (`RunningRegionBand`) と同じ数で決める。紙の枠線の内側を基準に
  // `right` / `bottom` で置くと、枠線のぶん (2px) 幅とフッターの高さが帯とずれる。
  const overlaySize = getRunningRegionOverlaySize(metrics.content.widthPx, region);
  const style = {
    top: `${mmToPx(getRunningRegionBoundsMm(layout, kind).topMm)}px`,
    left: `${metrics.margins.leftPx}px`,
    width: `${overlaySize.widthPx}px`,
    height: `${overlaySize.heightPx}px`,
  } as CSSProperties;

  return (
    <div className={`page-running-region ${kind} free`} style={style}>
      <PageRunningRegionOverlay
        overlay={region.overlay}
        widthPx={overlaySize.widthPx}
        heightPx={overlaySize.heightPx}
      />
      <div className="page-running-text-layer">
        <DocumentWritableContext.Provider value={false}>
          <TextFlowEditor
            blocks={blocks}
            selectedId={null}
            mathFractionSizing={mathFractionSizing}
            historyRevision={0}
            showPlaceholder={false}
            runningFieldValues={fieldValues}
            caretSurface={false}
            enableSelectionFormatMenu={false}
            enableBoxCommands={false}
            onSelect={NOOP}
            onChange={NOOP}
          />
        </DocumentWritableContext.Provider>
      </div>
    </div>
  );
}

export function RunningRegionControls({
  marginEditing,
  layout,
  metrics,
  pageTopPx,
  pageLeftPx = 0,
  pageNumber,
  title,
  totalPages,
  mathFractionSizing,
  editingKind,
  editingPageNumber,
  resizing,
  focusRequest,
  historyRevision,
  onEdit,
  onShownOnPageChange,
  onPageRangeChange,
  onPageContentChange,
  onClearPageContents,
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
  /** 2 ページ並びの右の列のページの左端 (表示座標)。1 列では 0。 */
  pageLeftPx?: number;
  pageNumber: number;
  /** 差し込み (`{title}` `{page}` `{total}`) に見せる値。 */
  title: string;
  totalPages: number;
  mathFractionSizing?: MathFractionSizing | null;
  editingKind: RunningRegionKind | null;
  editingPageNumber: number;
  /** いまドラッグしている帯の辺。 */
  resizing: { kind: RunningRegionKind; edge: RunningRegionEdge } | null;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  /** そのページだけ帯を出す/出さない。 */
  onShownOnPageChange: (kind: RunningRegionKind, pageNumber: number, shown: boolean) => void;
  /** 「すべて/先頭ページのみ/先頭以外」のまとまりで、どのページに出すかを決める。 */
  onPageRangeChange: (kind: RunningRegionKind, range: RunningRegionPageRange) => void;
  /** そのページだけ中身を変える/共通に戻す。 */
  onPageContentChange: (kind: RunningRegionKind, pageNumber: number, enabled: boolean) => void;
  /** ページ専用の中身をすべてやめて、共通の中身に戻す。 */
  onClearPageContents: (kind: RunningRegionKind) => void;
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
    <div className="page-layout-control-sheet" style={{ top: `${pageTopPx}px`, ...(pageLeftPx ? { left: `${pageLeftPx}px` } : {}) }}>
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
        title={title}
        totalPages={totalPages}
        mathFractionSizing={mathFractionSizing}
        editing={editingKind === "header" && pageNumber === editingPageNumber}
        resizingEdge={resizing?.kind === "header" ? resizing.edge : null}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onShownOnPageChange={onShownOnPageChange}
        onPageRangeChange={onPageRangeChange}
        onPageContentChange={onPageContentChange}
        onClearPageContents={onClearPageContents}
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
        title={title}
        totalPages={totalPages}
        mathFractionSizing={mathFractionSizing}
        editing={editingKind === "footer" && pageNumber === editingPageNumber}
        resizingEdge={resizing?.kind === "footer" ? resizing.edge : null}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onShownOnPageChange={onShownOnPageChange}
        onPageRangeChange={onPageRangeChange}
        onPageContentChange={onPageContentChange}
        onClearPageContents={onClearPageContents}
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
  title,
  totalPages,
  mathFractionSizing,
  editing,
  resizingEdge = null,
  focusRequest,
  historyRevision,
  onEdit,
  onShownOnPageChange,
  onPageRangeChange,
  onPageContentChange,
  onClearPageContents,
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
  title: string;
  totalPages: number;
  mathFractionSizing?: MathFractionSizing | null;
  editing: boolean;
  /** この帯のドラッグ中の辺。辺の上に寸法を出す。 */
  resizingEdge?: RunningRegionEdge | null;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  onShownOnPageChange: (kind: RunningRegionKind, pageNumber: number, shown: boolean) => void;
  onPageRangeChange: (kind: RunningRegionKind, range: RunningRegionPageRange) => void;
  onPageContentChange: (kind: RunningRegionKind, pageNumber: number, enabled: boolean) => void;
  onClearPageContents: (kind: RunningRegionKind) => void;
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
  const bandRef = useRef<HTMLDivElement | null>(null);
  if (!region?.enabled) {
    return null;
  }

  const shownOnPage = isRunningRegionShownOnPage(region, pageNumber);
  // `{page}` `{total}` に出す番号。表示するページの指定・ページ専用の中身は組版上のページ (`pageNumber`) のまま。
  const fieldValues = createRunningRegionFieldValues(title, pageNumber, totalPages, layout.pageNumberStart);
  const bounds = getRunningRegionBoundsMm(layout, kind);
  const top = mmToPx(bounds.topMm);
  // Shared with `PageRunningRegionView`: the band used to subtract the page sheet's 2px border
  // while the displayed region did not. An SVG `viewBox` hid the difference; React places shapes at
  // absolute px, so the two surfaces have to agree on the overlay's coordinate space.
  const { heightPx: height, widthPx: width } = getRunningRegionOverlaySize(
    metrics.content.widthPx,
    region,
  );
  // 上の辺と下の辺がそれぞれ何を動かすか。ヘッダーは上の辺が用紙の端からの位置、下の辺が高さ。
  // フッターは逆に、上の辺が高さ、下の辺が用紙の下端からの位置。
  const heightText = tEditor("running.heightValue", { replace: { value: formatMm(region.heightMm) } });
  const offsetText = tEditor(kind === "header" ? "running.fromTopValue" : "running.fromBottomValue", {
    replace: { value: formatMm(region.offsetMm) },
  });
  const edgeValues: Record<RunningRegionEdge, string> = kind === "header"
    ? { start: offsetText, end: heightText }
    : { start: heightText, end: offsetText };

  return (
    <div
      ref={bandRef}
      className={`page-running-editor-band ${kind} ${editing ? "editing" : ""} ${resizingEdge ? "resizing" : ""} ${shownOnPage ? "" : "page-hidden"}`}
      title={editing ? undefined : tEditor("running.editHint", { replace: { region: label } })}
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
      {editing && (
        <RunningRegionDirectEditor
          kind={kind}
          label={label}
          region={region}
          pageNumber={pageNumber}
          fieldValues={fieldValues}
          mathFractionSizing={mathFractionSizing}
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
          {(["start", "end"] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              className={`page-running-edge ${edge} ${resizingEdge === edge ? "active" : ""}`}
              aria-label={`${tEditor(edge === "start" ? "running.startEdge" : "running.endEdge", { replace: { region: label } })} ${edgeValues[edge]}`}
              onPointerDown={(event) => onEdgePointerDown(kind, edge, event)}
              onClick={(event) => event.stopPropagation()}
            >
              {/* いまの値。辺に触れている間 (ホバー・ドラッグ) だけ出す。 */}
              <span className="page-running-edge-value" aria-hidden="true">{edgeValues[edge]}</span>
            </button>
          ))}
        </>
      )}
      <RunningRegionOptions
        kind={kind}
        label={label}
        region={region}
        bandRef={bandRef}
        pageNumber={pageNumber}
        totalPages={totalPages}
        fieldValues={fieldValues}
        editing={editing}
        shownOnPage={shownOnPage}
        ownContent={hasRunningRegionPageContent(region, pageNumber)}
        onShownOnPageChange={(shown) => onShownOnPageChange(kind, pageNumber, shown)}
        onPageRangeChange={(range) => onPageRangeChange(kind, range)}
        onClearOwnContents={() => onClearPageContents(kind)}
        onOwnContentChange={(enabled) => {
          onPageContentChange(kind, pageNumber, enabled);
          // 変えるときは、そのまま書き始められるように編集に入る。
          if (enabled) {
            onEdit(kind, pageNumber);
          }
        }}
      />
    </div>
  );
}

export function RunningRegionDirectEditor({
  kind,
  label,
  region,
  pageNumber,
  fieldValues,
  mathFractionSizing,
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
  /** 編集しているページ。ページ専用の中身があれば、その文字を編集する。 */
  pageNumber: number;
  /** 差し込みに見せる、このページの値 (編集していないページと同じ見え方にする)。 */
  fieldValues?: RunningRegionFieldValues;
  mathFractionSizing?: MathFractionSizing | null;
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
  const blocks = useMemo(() => pageRunningRegionToTextFlowBlocks(region, kind, pageNumber), [kind, pageNumber, region]);
  const fieldTitle = fieldValues?.title;
  const fieldPage = fieldValues?.page;
  const fieldTotal = fieldValues?.total;
  const stableFieldValues = useMemo<RunningRegionFieldValues | null>(
    () => (fieldTitle === undefined || fieldPage === undefined || fieldTotal === undefined
      ? null
      : { title: fieldTitle, page: fieldPage, total: fieldTotal }),
    [fieldPage, fieldTitle, fieldTotal],
  );
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

    // 測るのは文字の行だけ。枠の内側の余白 (`.text-flow-shell` の padding) を数えると、
    // 1 行のヘッダーでも帯が 12mm 前後より低くできなかった。エディタが描き終わる前
    // (`.text-flow-editor` がまだ無い) の空の枠は測らない: 中身が減ったと読み違える。
    // 描き終わり・折り返しの変化は ResizeObserver で拾う。
    const report = () => {
      const content = shell.querySelector<HTMLElement>(".text-flow-editor");
      if (content) {
        onContentHeightChange(kind, content.offsetHeight);
      }
    };
    report();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    observer?.observe(shell);
    return () => observer?.disconnect();
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
          mathFractionSizing={mathFractionSizing}
          runningFieldValues={stableFieldValues}
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
