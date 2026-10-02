"use client";
import {
  activatePageBreakMarkerOnClick,
  activatePageBreakMarkerOnMouseDown,
} from "@/components/editor/page-break-marker";
import { type PageLayout,type PageMetrics } from "@/features/document";
import { type FlowDisplacement } from "@/features/rendering/core";
import { type PageBreakMarkerKind } from "@/features/text-editing";
import { useT } from "@/lib/i18n/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { formatMm } from "./page-layout-format";
import type { PageMarginEdge } from "./types";

export function ColumnGuides({ metrics }: { metrics: PageMetrics }) {
  if (metrics.flow.columnCount <= 1 || metrics.flow.columnRule) {
    return null;
  }

  return (
    <div className="page-column-guides" aria-hidden="true">
      {Array.from({ length: metrics.flow.columnCount - 1 }, (_, index) => {
        const left = metrics.margins.leftPx +
          (index + 1) * metrics.flow.columnWidthPx +
          index * metrics.flow.columnGapPx +
          metrics.flow.columnGapPx / 2;

        return <span key={index} style={{ left: `${left}px` }} />;
      })}
    </div>
  );
}

export function getBodyVerticalSnapGuides(metrics: PageMetrics): number[] {
  const values: number[] = [];
  const addValue = (value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    if (!values.some((current) => Math.abs(current - value) < 0.001)) {
      values.push(value);
    }
  };
  const contentLeft = metrics.margins.leftPx;
  const contentRight = metrics.page.widthPx - metrics.margins.rightPx;

  addValue(contentLeft);
  addValue(contentRight);

  if (metrics.flow.columnCount > 1) {
    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    for (let index = 0; index < metrics.flow.columnCount; index += 1) {
      const columnLeft = contentLeft + index * columnStep;
      addValue(columnLeft);
      addValue(columnLeft + metrics.flow.columnWidthPx);
    }
  }

  return values;
}

export function PageMarginRuler({
  layout,
  metrics,
  onMarginPointerDown,
}: {
  layout: PageLayout;
  metrics: PageMetrics;
  onMarginPointerDown: (
    edge: PageMarginEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  const tEditor = useT("editor");
  return (
    <div className="page-margin-ruler" aria-label={tEditor("pageCanvas.marginRuler")}>
      <div
        className="page-margin-ruler-track"
        style={{
          left: `${metrics.margins.leftPx}px`,
          right: `${metrics.margins.rightPx}px`,
        }}
      />
      <button
        type="button"
        className="page-margin-ruler-handle left"
        style={{ left: `${metrics.margins.leftPx}px` }}
        aria-label={tEditor("pageCanvas.marginLeft")}
        title={tEditor("pageCanvas.marginLeft")}
        onPointerDown={(event) => onMarginPointerDown("left", event)}
      >
        <span>{formatMm(layout.marginsMm.left)}mm</span>
      </button>
      <button
        type="button"
        className="page-margin-ruler-handle right"
        style={{ right: `${metrics.margins.rightPx}px` }}
        aria-label={tEditor("pageCanvas.marginRight")}
        title={tEditor("pageCanvas.marginRight")}
        onPointerDown={(event) => onMarginPointerDown("right", event)}
      >
        <span>{formatMm(layout.marginsMm.right)}mm</span>
      </button>
    </div>
  );
}

export function PageBreakMarker({
  blockId,
  kind = "pageBreak",
  onRemove,
  displacement,
}: {
  blockId: string;
  kind?: PageBreakMarkerKind;
  onRemove?: (blockId: string) => void;
  /** 印は改ページする前のページの末尾に描く (直前の行と同じ変位)。 */
  displacement?: FlowDisplacement;
}) {
  // 区切り印の文言は本文編集面の語彙 (`editor` namespace)。
  const t = useT("editor");
  const label = kind === "columnBreak" ? t("pagination.columnBreak") : t("pagination.pageBreak");
  const removeLabel = t("pagination.removeBreak", { replace: { kind: label } });
  return (
    <div
      className="page-break-marker"
      data-page-break-marker=""
      data-page-break-block-id={blockId}
      style={displacement && (displacement.dx !== 0 || displacement.dy !== 0)
        ? { position: "relative", top: `${displacement.dy}px`, left: `${displacement.dx}px` }
        : undefined}
    >
      <span />
      <strong>{label}</strong>
      <span />
      {onRemove && (
        <button
          type="button"
          className="page-break-marker-remove"
          aria-label={removeLabel}
          onMouseDown={(event) => {
            activatePageBreakMarkerOnMouseDown(event, () => onRemove(blockId));
          }}
          onClick={(event) => {
            activatePageBreakMarkerOnClick(event, () => onRemove(blockId));
          }}
        >
          {t("pagination.removeBreakButton")}
        </button>
      )}
    </div>
  );
}
