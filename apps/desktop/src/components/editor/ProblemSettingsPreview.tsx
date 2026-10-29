"use client";

import type { CSSProperties, ReactNode } from "react";

import {
  formatProblemNumberLabel,
  getProblemFontStyle,
  getProblemFrameLayoutStyle,
  getProblemNumberLayoutStyle,
  type InlineNode,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
} from "@/features/document";
import { isProblemLeadFolded } from "@/features/rendering/core";
import { getProblemNumberFontSize } from "@/features/text-editing";
import { getCustomFrameStyle } from "@/lib/custom-frame";
import { useT } from "@/lib/i18n/react";
import { getProblemCustomFrame, getProblemFrameStyleId, problemFrameClassName } from "@/lib/problem-frame";

import styles from "./ProblemSettingsDialog.module.css";

/** プレビューで強調する部分。ダイアログで触っている欄に対応する。 */
export type ProblemSettingsPreviewPart = "font" | "number" | "lead" | "frame" | ProblemAreaKind;

/** 1 つのエリアから見せる文字の上限。長い問題文でもプレビューの高さを抑える。 */
const PREVIEW_TEXT_LIMIT = 90;

/**
 * 問題を紙面と同じクラス・同じ変数で小さく描く。番号・導入文・問題文・枠・書体がその場で変わり、
 * 触っている欄の部分を色で示す。中身は先頭の文字だけを抜き出す (数式は TeX のまま薄く見せる)。
 */
export function ProblemSettingsPreview({
  problem,
  highlight,
}: {
  problem: ProblemNode;
  highlight: ProblemSettingsPreviewPart | null;
}) {
  const t = useT("settings");
  const showNumber = problem.numbering?.enabled !== false;
  const leadShown = !isProblemLeadFolded(problem);
  const number = formatProblemNumberLabel(problem.numbering?.value ?? 1, problem.numbering);
  const framed = problem.frame?.enabled === true;
  const frameStyleId = framed ? getProblemFrameStyleId(problem) : undefined;
  const frameCustom = framed ? getProblemCustomFrame(problem) : undefined;
  const rootStyle = {
    ...getProblemNumberLayoutStyle(problem.numbering),
    ...getProblemFontStyle(problem.fontFamily),
  } as CSSProperties;
  const marker = (
    <span
      className="problem-number-marker"
      data-preview-part="number"
      style={{ fontSize: `${getProblemNumberFontSize(problem)}pt` }}
    >
      {number}
    </span>
  );
  const row = (area: ProblemAreaKind, withNumber: boolean, emptyLabel: string) => (
    <div className={`problem-area-paper-content ${withNumber ? "with-number" : ""}`}>
      {withNumber ? marker : null}
      <div className={`problem-area-paper-body ${styles.previewText}`} data-preview-part={area}>
        {renderAreaText(problem[area]) ?? <span className={styles.previewEmpty}>{emptyLabel}</span>}
      </div>
    </div>
  );
  const extraAreas = (["hints", "solution"] as const).filter((area) => problem[area].length > 0);

  return (
    <div
      className={styles.previewProblem}
      data-testid="problem-settings-preview"
      data-highlight={highlight ?? undefined}
      style={rootStyle}
    >
      {leadShown ? (
        <div className={styles.previewLead} data-preview-area="lead">
          {row("lead", showNumber, t("problem.previewLeadEmpty"))}
        </div>
      ) : null}
      <div
        // 枠は紙面と同じクラスで描く (CustomFrameEditor のプレビューと同じ組み方)。
        className={framed
          ? `${problemFrameClassName("problem-area-flow-unit with-frame", frameStyleId)} first-frame-area last-frame-area ${styles.previewFrame}`
          : styles.previewPlain}
        data-preview-part="frame"
        style={{
          ...(frameCustom ? getCustomFrameStyle(frameCustom, "px") : {}),
          ...getProblemFrameLayoutStyle(framed ? problem.frame : undefined),
        } as CSSProperties}
      >
        {row("prompt", showNumber && !leadShown, t("problem.previewPromptEmpty"))}
      </div>
      {extraAreas.map((area) => (
        <div key={area} className={styles.previewExtra}>
          <span className={styles.previewAreaLabel}>{t(`problem.areas.${area}`)}</span>
          {row(area, false, "")}
        </div>
      ))}
    </div>
  );
}

/** エリアの先頭の文字を、文字ごとの書体・太さを保ったまま抜き出す。何も無ければ null。 */
function renderAreaText(blocks: readonly ProblemAreaBlock[]): ReactNode {
  const parts: ReactNode[] = [];
  let length = 0;
  const visitInline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (length >= PREVIEW_TEXT_LIMIT) return;
      const text = node.type === "text" ? node.text : node.tex;
      const clipped = text.slice(0, PREVIEW_TEXT_LIMIT - length);
      length += clipped.length;
      parts.push(node.type === "text" ? (
        <span
          key={parts.length}
          style={{
            fontFamily: node.fontFamily,
            fontWeight: node.marks?.includes("bold") ? 700 : undefined,
            fontStyle: node.marks?.includes("italic") ? "italic" : undefined,
          }}
        >
          {clipped}
        </span>
      ) : (
        <span key={parts.length} className={styles.previewMath}>{clipped}</span>
      ));
    }
  };
  const visitBlock = (block: unknown) => {
    if (length >= PREVIEW_TEXT_LIMIT || typeof block !== "object" || block === null) return;
    const record = block as Record<string, unknown>;
    if (Array.isArray(record.children) && record.children.every((child) => typeof child === "object" && child !== null && "type" in child
      && (child.type === "text" || child.type === "mathInline"))) {
      if (parts.length > 0) parts.push(" ");
      visitInline(record.children as InlineNode[]);
      return;
    }
    for (const key of ["children", "blocks", "items"]) {
      if (Array.isArray(record[key])) (record[key] as unknown[]).forEach(visitBlock);
    }
  };
  blocks.forEach(visitBlock);
  if (parts.length === 0) return null;
  if (length >= PREVIEW_TEXT_LIMIT) parts.push("…");
  return parts;
}
