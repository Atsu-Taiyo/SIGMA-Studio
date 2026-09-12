"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { buildShapesSvgPreview } from "@/lib/ai/ai-edit-shape-preview";
import type {
  AiAppliedDiffChange,
  AiAppliedDocumentDiff,
  AiAppliedShapeDiffEntry,
} from "@/lib/ai/applied-document-diff";
import {
  buildAppliedDiffRows,
  countAppliedDiffLines,
  type AppliedDiffChangedRow,
  type AppliedDiffContextRow,
  type AppliedDiffRow,
} from "@/lib/ai/applied-diff-lines";
import type { InlineDiffSegment } from "@/lib/ai/inline-diff";

import { InlineContent } from "@/features/rendering/adapters/react";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

import styles from "./AiAppliedDocumentDiff.module.css";

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export interface AiAppliedDiffStat {
  change: AiAppliedDiffChange;
  count: number;
  /**
   * 数えている物の id。**文言ではない。** 集計のキーにも並び順にも使うので、
   * ここを訳語にするとまとまり方と並びが言語で変わる。文言は `ai.diff.noun.<id>`。
   */
  noun: AiAppliedDiffNounId;
}

export const AI_APPLIED_DIFF_NOUN_IDS = ["line", "shape", "graph", "table", "image"] as const;

export type AiAppliedDiffNounId = (typeof AI_APPLIED_DIFF_NOUN_IDS)[number];

function shapeNoun(entry: AiAppliedShapeDiffEntry): AiAppliedDiffNounId {
  if (entry.shape.type === "graph2dShape") return "graph";
  if (entry.shape.type === "tableShape") return "table";
  if (entry.shape.type === "image") return "image";
  return "shape";
}

// buildAppliedDiffRows(diff)は構造をたどるので無料ではない。行を描画する側(コンポーネント)は
// 既に計算済みのrowsを持っているはずなので、そこから集計だけ行う内部ヘルパーを分け、
// 二重計算を避ける。エクスポートされるbuildAppliedDiffStats(diff)はテスト/外部呼び出し向けに
// 従来どおりdiffだけ渡せば動くAPIを維持する。
function statsFromRows(rows: AppliedDiffRow[], shapes: AiAppliedShapeDiffEntry[]): AiAppliedDiffStat[] {
  const stats = new Map<string, AiAppliedDiffStat>();
  const bump = (change: AiAppliedDiffChange, noun: AiAppliedDiffStat["noun"], count: number) => {
    if (count <= 0) {
      return;
    }
    const key = `${change}:${noun}`;
    const current = stats.get(key);
    stats.set(key, { change, noun, count: (current?.count ?? 0) + count });
  };

  const lineCounts = countAppliedDiffLines(rows);
  bump("added", "line", lineCounts.added);
  bump("removed", "line", lineCounts.removed);
  for (const entry of shapes) {
    bump(entry.change, shapeNoun(entry), 1);
  }

  const order: AiAppliedDiffChange[] = ["added", "removed"];
  return [...stats.values()].sort((a, b) => {
    const changeOrder = order.indexOf(a.change) - order.indexOf(b.change);
    // 並びは **id** で決める (訳語で並べると言語ごとに順番が変わる)。
    return changeOrder || a.noun.localeCompare(b.noun);
  });
}

/** GitHubの +n/-n に相当する、構造化SigmaDoc向けの実差分集計。 */
export function buildAppliedDiffStats(
  diff: AiAppliedDocumentDiff,
  tEditor: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): AiAppliedDiffStat[] {
  return statsFromRows(buildAppliedDiffRows(diff, tEditor), diff.shapes);
}

function ShapeDiffPreview({
  change,
  entries,
}: {
  change: AiAppliedDiffChange;
  entries: AiAppliedShapeDiffEntry[];
}) {
  const preview = buildShapesSvgPreview(entries.map((entry) => entry.shape), {});
  if (!preview) {
    return null;
  }
  return (
    <div className={styles.shapeRow} data-change={change}>
      <span className={styles.gutter} aria-hidden="true">{change === "added" ? "+" : "−"}</span>
      <div
        className={styles.shapeStage}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
    </div>
  );
}

function DiffSegments({ segments }: { segments: InlineDiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        segment.changed
          ? (
              <mark key={index} className={styles.mark}>
                <InlineContent nodes={segment.nodes} />
              </mark>
            )
          : <InlineContent key={index} nodes={segment.nodes} />
      ))}
    </>
  );
}

function AreaLabel({ label }: { label: string }) {
  return (
    <div className={styles.areaLabelRow}>
      <span className={styles.gutter} aria-hidden="true" />
      <span className={styles.areaLabel}>{label}</span>
    </div>
  );
}

function ChangedBodyRow({ row }: { row: AppliedDiffChangedRow }) {
  return (
    <div className={styles.bodyRow} data-change={row.type}>
      <span className={styles.gutter} aria-hidden="true">{row.type === "added" ? "+" : "−"}</span>
      <div className={`${styles.bodyContent} ai-inline-preview-content text-flow-editor`}>
        <DiffSegments segments={row.segments} />
      </div>
    </div>
  );
}

function ContextBodyRow({ nodes }: { nodes: AppliedDiffContextRow["nodes"] }) {
  return (
    <div className={styles.bodyRow} data-change="context">
      <span className={styles.gutter} aria-hidden="true" />
      <div className={`${styles.bodyContent} ai-inline-preview-content text-flow-editor`}>
        <InlineContent nodes={nodes} />
      </div>
    </div>
  );
}

function CollapsedBodyRow({ row, onExpand }: { row: Extract<AppliedDiffRow, { type: "collapsed" }>; onExpand: () => void }) {
  const t = useT("ai");
  return (
    <button type="button" className={styles.collapsedRow} onClick={onExpand}>
      <span className={styles.gutter} aria-hidden="true">…</span>
      <span className={styles.collapsedLabel}>{t("diff.collapsed", { replace: { count: row.count } })}</span>
    </button>
  );
}

function BodyRows({ rows }: { rows: AppliedDiffRow[] }) {
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<number>>(() => new Set());
  let lastLabel: string | undefined;
  const elements: ReactNode[] = [];

  rows.forEach((row, index) => {
    if (row.type === "collapsed") {
      if (expandedKeys.has(index)) {
        row.rows.forEach((contextRow, nestedIndex) => {
          if (contextRow.label !== undefined && contextRow.label !== lastLabel) {
            elements.push(<AreaLabel key={`${index}-${nestedIndex}-label`} label={contextRow.label} />);
            lastLabel = contextRow.label;
          }
          elements.push(<ContextBodyRow key={contextRow.key} nodes={contextRow.nodes} />);
        });
      } else {
        elements.push(
          <CollapsedBodyRow
            key={`collapsed-${index}`}
            row={row}
            onExpand={() => setExpandedKeys((current) => new Set(current).add(index))}
          />,
        );
      }
      lastLabel = row.rows[row.rows.length - 1]?.label ?? lastLabel;
      return;
    }

    if (row.label !== undefined && row.label !== lastLabel) {
      elements.push(<AreaLabel key={`${row.key}-label`} label={row.label} />);
      lastLabel = row.label;
    }

    elements.push(
      row.type === "context"
        ? <ContextBodyRow key={row.key} nodes={row.nodes} />
        : <ChangedBodyRow key={`${row.type}-${row.key}`} row={row} />,
    );
  });

  return <>{elements}</>;
}

/** 適用済み/提案中のAI編集差分を、GitHub風の統一差分(unified diff)として描画する。 */
export function AiAppliedDocumentDiffView({ diff }: { diff: AiAppliedDocumentDiff }) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const rows = useMemo(() => buildAppliedDiffRows(diff, tEditor), [diff, tEditor]);
  const stats = useMemo(() => statsFromRows(rows, diff.shapes), [rows, diff.shapes]);
  const removedShapes = diff.shapes.filter((entry) => entry.change === "removed");
  const addedShapes = diff.shapes.filter((entry) => entry.change === "added");

  if (stats.length === 0) {
    return null;
  }

  return (
    <div className={styles.diff} aria-label={t("diff.title")}>
      <div className={styles.stats} aria-label={t("diff.statsAria")}>
        {stats.map((stat) => (
          <span key={`${stat.change}:${stat.noun}`} className={styles.stat} data-change={stat.change}>
            {t("diff.stat", {
              count: stat.count,
              replace: {
                sign: stat.change === "added" ? "+" : "\u2212",
                count: stat.count,
                // `count` を渡すと i18next が複数形を選ぶ (英語だけ語形が変わる)。
                noun: t(`diff.noun.${stat.noun}`, { count: stat.count }),
              },
            })}
          </span>
        ))}
      </div>
      {rows.length > 0 && (
        <div className={styles.body}>
          <BodyRows rows={rows} />
        </div>
      )}
      {(removedShapes.length > 0 || addedShapes.length > 0) && (
        <div className={styles.shapes}>
          {removedShapes.length > 0 && <ShapeDiffPreview change="removed" entries={removedShapes} />}
          {addedShapes.length > 0 && <ShapeDiffPreview change="added" entries={addedShapes} />}
        </div>
      )}
    </div>
  );
}
