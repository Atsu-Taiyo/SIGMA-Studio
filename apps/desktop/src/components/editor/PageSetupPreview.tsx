"use client";

import { useState } from "react";
import type { ColumnRule, PageLayout } from "@/features/document";
import { useT } from "@/lib/i18n/react";
import { ColumnRuleDialog } from "./ColumnRuleDialog";

import styles from "./PageSettingsDialog.module.css";

/** プレビューで強調する部分。ダイアログで触っている欄に対応する。 */
export type PageSetupPreviewPart =
  | "paper"
  | "marginTop"
  | "marginRight"
  | "marginBottom"
  | "marginLeft"
  | "columns"
  | "header"
  | "footer";

const PREVIEW_MAX_WIDTH_PX = 208;
const PREVIEW_MAX_HEIGHT_PX = 280;
/** 本文の行に見立てる棒の間隔と太さ (mm)。用紙の大きさで変えない: 余白や段の比率だけを見せる。 */
const LINE_PITCH_MM = 7;
const LINE_THICKNESS_MM = 2.2;

/**
 * 用紙・余白・段・ヘッダー/フッターを縮小して描く。座標は mm のまま `viewBox` に載せ、
 * 線と文字だけを画面の px に合わせる。触っている欄の部分を色で示す。
 */
export function PageSetupPreview({
  layout,
  highlight,
  onColumnRuleChange,
}: {
  layout: PageLayout;
  highlight: PageSetupPreviewPart | null;
  onColumnRuleChange?: (rule: ColumnRule | undefined) => void;
}) {
  const t = useT("settings");
  const [ruleOpen, setRuleOpen] = useState(false);
  const widthMm = Math.max(1, layout.pageSize.widthMm);
  const heightMm = Math.max(1, layout.pageSize.heightMm);
  const scale = Math.min(PREVIEW_MAX_WIDTH_PX / widthMm, PREVIEW_MAX_HEIGHT_PX / heightMm);
  const px = (value: number) => value / scale;
  const { top, right, bottom, left } = layout.marginsMm;
  const bodyWidthMm = Math.max(0, widthMm - left - right);
  const bodyHeightMm = Math.max(0, heightMm - top - bottom);
  const columnCount = Math.max(1, layout.flow.columnCount);
  const gapMm = layout.flow.columnGapMm;
  const columnWidthMm = Math.max(0, (bodyWidthMm - gapMm * (columnCount - 1)) / columnCount);
  const header = layout.header?.enabled ? layout.header : undefined;
  const footer = layout.footer?.enabled ? layout.footer : undefined;
  const lineCount = Math.max(0, Math.floor((bodyHeightMm - px(4)) / LINE_PITCH_MM));
  const fontSizeMm = px(10);
  const rule = layout.flow.columnRule;

  const marginRect = (part: PageSetupPreviewPart) => {
    switch (part) {
      case "marginTop": return { x: 0, y: 0, width: widthMm, height: top };
      case "marginBottom": return { x: 0, y: heightMm - bottom, width: widthMm, height: bottom };
      case "marginLeft": return { x: 0, y: 0, width: left, height: heightMm };
      case "marginRight": return { x: widthMm - right, y: 0, width: right, height: heightMm };
      default: return null;
    }
  };
  const highlightRect = highlight ? marginRect(highlight) : null;

  return (
    <>
    <svg
      className={styles.previewSvg}
      data-testid="page-setup-preview"
      data-highlight={highlight ?? undefined}
      width={widthMm * scale}
      height={heightMm * scale}
      viewBox={`0 0 ${widthMm} ${heightMm}`}
      role={onColumnRuleChange ? "group" : "img"}
      aria-label={t("page.preview")}
    >
      <rect className={styles.previewPaper} x={0} y={0} width={widthMm} height={heightMm} />
      {highlightRect ? (
        <rect className={styles.previewMarginHighlight} {...highlightRect} />
      ) : null}
      {Array.from({ length: columnCount }, (_, index) => {
        const x = left + index * (columnWidthMm + gapMm);
        return (
          <g key={index}>
            <rect
              className={styles.previewBody}
              data-active={highlight === "columns" || undefined}
              x={x}
              y={top}
              width={columnWidthMm}
              height={bodyHeightMm}
            />
            {Array.from({ length: lineCount }, (_, line) => (
              <rect
                key={line}
                className={styles.previewLine}
                x={x + px(3)}
                y={top + px(3) + line * LINE_PITCH_MM}
                width={Math.max(0, columnWidthMm * (line % 5 === 4 ? 0.55 : 0.92) - px(6))}
                height={Math.min(LINE_THICKNESS_MM, LINE_PITCH_MM / 2)}
                rx={px(1)}
              />
            ))}
          </g>
        );
      })}
      {Array.from({ length: columnCount - 1 }, (_, index) => {
        const x = left + (index + 1) * columnWidthMm + (index + 0.5) * gapMm;
        const double = rule?.style === "double";
        const line = (offset: number, key: number) => rule && rule.style !== "none" && <line
          key={key} x1={x + offset} x2={x + offset} y1={top} y2={top + bodyHeightMm}
          stroke={rule.color} strokeWidth={px(double ? rule.widthPx / 3 : rule.widthPx)}
          strokeDasharray={rule.style === "dashed" ? `${px(8)} ${px(5)}` : rule.style === "dotted" ? `${px(1)} ${px(5)}` : undefined}
          strokeLinecap={rule.style === "dotted" ? "round" : undefined}
        />;
        return <g key={index} data-testid="page-setup-column-rule">
          {double ? [line(-px(rule.widthPx / 3), 0), line(px(rule.widthPx / 3), 1)] : line(0, 0)}
          {onColumnRuleChange && <rect
            x={x - px(6)} y={top} width={px(12)} height={bodyHeightMm} fill="transparent"
            role="button" tabIndex={0} aria-label={t("columnRule.title")} style={{ cursor: "pointer" }}
            onClick={() => setRuleOpen(true)}
            onContextMenu={event => { event.preventDefault(); setRuleOpen(true); }}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setRuleOpen(true); } }}
          ><title>{t("columnRule.title")}</title></rect>}
        </g>;
      })}
      {header ? (
        <RunningBand
          y={header.offsetMm}
          heightMm={header.heightMm}
          x={left}
          widthMm={bodyWidthMm}
          active={highlight === "header"}
          label={t("page.previewHeader")}
          fontSizeMm={fontSizeMm}
          minVisibleMm={px(1)}
        />
      ) : null}
      {footer ? (
        <RunningBand
          y={heightMm - footer.offsetMm - footer.heightMm}
          heightMm={footer.heightMm}
          x={left}
          widthMm={bodyWidthMm}
          active={highlight === "footer"}
          label={t("page.previewFooter")}
          fontSizeMm={fontSizeMm}
          minVisibleMm={px(1)}
        />
      ) : null}
      <rect className={styles.previewPaperEdge} x={0} y={0} width={widthMm} height={heightMm} />
    </svg>
    {ruleOpen && onColumnRuleChange && <ColumnRuleDialog
      documentScope value={rule} columnCount={columnCount} onApply={onColumnRuleChange} onClose={() => setRuleOpen(false)}
    />}
    </>
  );
}

function RunningBand({
  x,
  y,
  widthMm,
  heightMm,
  active,
  label,
  fontSizeMm,
  minVisibleMm,
}: {
  x: number;
  y: number;
  widthMm: number;
  heightMm: number;
  active: boolean;
  label: string;
  fontSizeMm: number;
  minVisibleMm: number;
}) {
  // 0mm の帯も線として見せる (表示を入れたのに何も描かれないと、入ったのか分からない)。
  const drawnHeight = Math.max(heightMm, minVisibleMm);
  const labelFits = heightMm >= fontSizeMm * 1.2;
  return (
    <g className={styles.previewBand} data-active={active || undefined}>
      <rect x={x} y={y + (heightMm - drawnHeight) / 2} width={widthMm} height={drawnHeight} />
      {labelFits ? (
        <text x={x + fontSizeMm * 0.4} y={y + heightMm / 2} fontSize={fontSizeMm} dominantBaseline="central">
          {label}
        </text>
      ) : null}
    </g>
  );
}
