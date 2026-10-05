"use client";

import { useMemo } from "react";

import type {
  AiAppliedDiffChange,
  AiAppliedDocumentDiff,
  AiAppliedShapeDiffEntry,
} from "@/lib/ai/applied-document-diff";
import { buildAppliedDiffRows, countAppliedDiffLines } from "@/lib/ai/applied-diff-lines";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

import { proposalContentToAppliedDiff, type AiProposalContent } from "../model/proposal-content";
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

/** GitHubの +n/-n に相当する、構造化SigmaDoc向けの実差分集計。 */
export function buildAppliedDiffStats(
  diff: AiAppliedDocumentDiff,
  tEditor: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): AiAppliedDiffStat[] {
  const stats = new Map<string, AiAppliedDiffStat>();
  const bump = (change: AiAppliedDiffChange, noun: AiAppliedDiffStat["noun"], count: number) => {
    if (count <= 0) {
      return;
    }
    const key = `${change}:${noun}`;
    const current = stats.get(key);
    stats.set(key, { change, noun, count: (current?.count ?? 0) + count });
  };

  const lineCounts = countAppliedDiffLines(buildAppliedDiffRows(diff, tEditor));
  bump("added", "line", lineCounts.added);
  bump("removed", "line", lineCounts.removed);
  for (const entry of diff.shapes) {
    bump(entry.change, shapeNoun(entry), 1);
  }

  const order: AiAppliedDiffChange[] = ["added", "removed"];
  return [...stats.values()].sort((a, b) => {
    const changeOrder = order.indexOf(a.change) - order.indexOf(b.change);
    // 並びは **id** で決める (訳語で並べると言語ごとに順番が変わる)。
    return changeOrder || a.noun.localeCompare(b.noun);
  });
}

/**
 * 提案内容 (保留中・適用済みのどちらも) の件数 (+n行 / −n図形 など)。内容そのものは
 * `AiProposalContentView` が描く。数える物が無ければ何も出さない。
 */
export function AiProposalDiffStats({ content }: { content: AiProposalContent }) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const stats = useMemo(
    () => buildAppliedDiffStats(proposalContentToAppliedDiff(content), tEditor),
    [content, tEditor],
  );

  if (stats.length === 0) {
    return null;
  }

  return (
    <div className={styles.stats} aria-label={t("diff.statsAria")}>
      {stats.map((stat) => (
        <span key={`${stat.change}:${stat.noun}`} className={styles.stat} data-change={stat.change}>
          {t("diff.stat", {
            count: stat.count,
            replace: {
              sign: stat.change === "added" ? "+" : "−",
              count: stat.count,
              // `count` を渡すと i18next が複数形を選ぶ (英語だけ語形が変わる)。
              noun: t(`diff.noun.${stat.noun}`, { count: stat.count }),
            },
          })}
        </span>
      ))}
    </div>
  );
}
