"use client";

import { History } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  buildProblemAreaPrintUnits,
  PrintBlock,
  PrintProblemArea,
} from "@/components/print/print-static-blocks";
import { HeadingNumberingProvider } from "@/components/editor/text-flow/HeadingNumberingContext";
import { ProblemNumberingProvider } from "@/components/editor/text-flow/ProblemNumberingContext";
import {
  getPageMetrics,
  type MathFractionSizing,
  type OverlayAsset,
  type ProblemAreaKind,
  type SigmaBlock,
} from "@/features/document";
import { buildShapesSvgPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { EditableBlock } from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { formatProblemNumber } from "@/lib/problem-numbering";

import {
  toDisplayProposalHunk,
  type AiProposalChange,
  type AiProposalContent,
  type AiProposalContentHunk,
  type AiProposalDisplayHunk,
  type AiProposalNumbering,
  type AiProposalShapeChange,
} from "../model/proposal-content";
import styles from "./AiProposalContentView.module.css";

/**
 * 提案内容の見せ方。
 * - `page`: 紙面の流れの中に置く。段幅のまま、紙面と同じ組版で描く。寸法の上限も内部の
 *   スクロールも持たない (はみ出しや改ページは置く側が決める)。消える側は描かない
 *   (本文側が薄い赤で示している)。
 * - `panel`: サイドバー・⌘K パネル・チャット。紙面の段幅で組んでから `transform: scale` で
 *   パネルの幅へ縮める (CSS の `zoom` は組版を作り直すので使わない — docs/architecture.md)。
 *   消える側と足される側の両方を描く。
 */
export type AiProposalContentSurface = "page" | "panel";

export interface AiProposalContentViewProps {
  content: AiProposalContent;
  surface: AiProposalContentSurface;
  mathFractionSizing?: MathFractionSizing;
  /** `panel` で組むときの段幅 (px)。省略時は既定の用紙の段幅。 */
  paperWidthPx?: number;
  /** 提案がどうなったか (チャットの図形サムネ)。破棄されたものは薄く描く。 */
  outcome?: "pending" | "applied" | "dismissed" | "reverted";
  /** 内容の下に添える短い説明 (「挿入した図形」など)。 */
  caption?: string;
}

const PREVIEW_COLUMN_GAP_MM = 8;
const DEFAULT_PANEL_PAPER_WIDTH_PX = getPageMetrics().flow.columnWidthPx;
const SHAPE_CHANGES: readonly AiProposalChange[] = ["removed", "added"];

/** 区分の呼び名は本文編集面と同じ語 (`editor.block.problem*` / `editor.pageCanvas.areaPrompt`)。 */
function problemAreaLabel(area: ProblemAreaKind, problemNumber: number | undefined, tEditor: Translate<"editor">): string {
  if (area === "lead") return tEditor("block.problemLead");
  if (area === "prompt") {
    return typeof problemNumber === "number"
      ? tEditor("pageCanvas.areaPrompt", { replace: { number: formatProblemNumber(problemNumber) } })
      : tEditor("block.problemPrompt");
  }
  if (area === "hints") return tEditor("block.problemHints");
  return tEditor("block.problemSolution");
}

/** 1 ブロックを紙面と同じ静的描画で描く。問題はエリアごとの紙面の単位に分ける。 */
function ProposalBlock({
  block,
  problemNumber,
  mathFractionSizing,
}: {
  block: EditableBlock;
  problemNumber?: number;
  mathFractionSizing?: MathFractionSizing;
}) {
  if (block.type === "problem") {
    return (
      <>
        {buildProblemAreaPrintUnits(block, problemNumber).map((unit) => (
          <PrintProblemArea
            key={unit.id}
            problemId={unit.problemId}
            area={unit.area}
            blocks={unit.blocks}
            minHeightMm={unit.minHeightMm}
            problemNumber={unit.problemNumber}
            numberFontSize={unit.numberFontSize}
            hasFrame={unit.hasFrame}
            frameStyleId={unit.frameStyleId}
            frameCustom={unit.frameCustom}
            isFirstProblemArea={unit.isFirstProblemArea}
            isFirstProblemFrameArea={unit.isFirstProblemFrameArea}
            isLastProblemFrameArea={unit.isLastProblemFrameArea}
            columnGapMm={PREVIEW_COLUMN_GAP_MM}
            mathFractionSizing={mathFractionSizing}
          />
        ))}
      </>
    );
  }

  // リスト項目はモデルがリストに包んで渡す (`presentListItem`)。包まれずに来ても、子の項目と
  // 続きの段落を落とさないよう 1 項目の箇条書きとして描く。
  const printable: SigmaBlock = block.type === "listItem"
    ? { id: block.id, type: "list", listType: "bullet", items: [block] }
    : block as SigmaBlock;
  return (
    <PrintBlock
      unit={{ type: "block", id: printable.id, block: printable, pagination: printable.pagination }}
      columnGapMm={PREVIEW_COLUMN_GAP_MM}
      mathFractionSizing={mathFractionSizing}
    />
  );
}

/**
 * `panel` の紙。段幅で組んだ紙を、入れ物の幅に合わせて縮める。`transform` は配置の大きさを
 * 変えないので、縮めた後の高さを入れ物に与える。
 */
function PanelPaper({ paperWidthPx, children }: { paperWidthPx: number; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ scale: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const paper = paperRef.current;
    if (!viewport || !paper) {
      return;
    }
    const update = () => {
      const available = viewport.clientWidth;
      const scale = available > 0 ? Math.min(1, available / paperWidthPx) : 1;
      const height = Math.ceil(paper.offsetHeight * scale);
      setFit((previous) => (previous && previous.scale === scale && previous.height === height ? previous : { scale, height }));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(paper);
    return () => observer.disconnect();
  }, [paperWidthPx]);

  const paperStyle: CSSProperties = {
    width: `${paperWidthPx}px`,
    ...(fit ? { transform: `scale(${fit.scale})` } : {}),
  };
  return (
    <div ref={viewportRef} className={styles.panelViewport} style={fit ? { height: `${fit.height}px` } : undefined}>
      <div ref={paperRef} className={`${styles.paper} text-flow-editor`} style={paperStyle}>
        {children}
      </div>
    </div>
  );
}

/** 両側が並ぶパネルだけで出す +/− の印 (色だけで変更前/変更後を伝えない)。紙面は足される側だけなので出さない。 */
function DiffGutter({ change }: { change: AiProposalChange }) {
  return <span className={styles.gutter} aria-hidden="true">{change === "added" ? "+" : "−"}</span>;
}

function ProposalSide({
  change,
  blocks,
  numbering,
  surface,
  paperWidthPx,
  mathFractionSizing,
}: {
  change: AiProposalChange;
  blocks: EditableBlock[];
  numbering: AiProposalNumbering;
  surface: AiProposalContentSurface;
  paperWidthPx: number;
  mathFractionSizing?: MathFractionSizing;
}) {
  const t = useT("ai");
  const printed = (
    <HeadingNumberingProvider numbers={numbering.headings}>
      <ProblemNumberingProvider numbers={numbering.problems}>
        {blocks.map((block) => (
          <ProposalBlock
            key={block.id}
            block={block}
            problemNumber={numbering.problems.get(block.id)}
            mathFractionSizing={mathFractionSizing}
          />
        ))}
      </ProblemNumberingProvider>
    </HeadingNumberingProvider>
  );
  return (
    <div
      className={styles.side}
      data-change={change}
      role="group"
      aria-label={change === "added" ? t("diff.after") : t("diff.before")}
    >
      {surface === "panel" && <DiffGutter change={change} />}
      {surface === "panel" ? (
        <PanelPaper paperWidthPx={paperWidthPx}>{printed}</PanelPaper>
      ) : (
        <div className={`${styles.paper} text-flow-editor`}>{printed}</div>
      )}
    </div>
  );
}

function ProposalHunk({
  hunk,
  display,
  surface,
  paperWidthPx,
  mathFractionSizing,
}: {
  hunk: AiProposalContentHunk;
  display: AiProposalDisplayHunk;
  surface: AiProposalContentSurface;
  paperWidthPx: number;
  mathFractionSizing?: MathFractionSizing;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  const showRemoved = surface === "panel" && display.removed.length > 0;
  return (
    <section className={styles.hunk} data-ai-proposal-hunk="" data-problem-area={hunk.problemArea?.area}>
      {hunk.problemArea && (
        <span className={styles.areaLabel} data-ai-proposal-area-label="">
          {problemAreaLabel(
            hunk.problemArea.area,
            hunk.numbering.added.problems.get(hunk.problemArea.problemId),
            tEditor,
          )}
        </span>
      )}
      <div className={styles.hunkBody}>
        {hunk.notes.map((note, index) => (
          <p key={index} className={styles.note} data-ai-proposal-note="">
            <History size={13} aria-hidden="true" />
            <span>{note || t("card.title.edit")}</span>
          </p>
        ))}
        {showRemoved && (
          <ProposalSide
            change="removed"
            blocks={display.removed}
            numbering={display.numbering.removed}
            surface={surface}
            paperWidthPx={paperWidthPx}
            mathFractionSizing={mathFractionSizing}
          />
        )}
        {display.added.length > 0 && (
          <ProposalSide
            change="added"
            blocks={display.added}
            numbering={display.numbering.added}
            surface={surface}
            paperWidthPx={paperWidthPx}
            mathFractionSizing={mathFractionSizing}
          />
        )}
      </div>
    </section>
  );
}

/**
 * 同じ側の図形をまとめて 1 枚の SVG に切り抜く。画像・3D の絵は `assets` から引く
 * (渡さないと絵が欠ける)。
 */
const ProposalShapeGroup = memo(function ProposalShapeGroup({
  change,
  entries,
  surface,
}: {
  change: AiProposalChange;
  entries: AiProposalShapeChange[];
  surface: AiProposalContentSurface;
}) {
  const t = useT("ai");
  const assets = useMemo(
    () => Object.assign({}, ...entries.map((entry) => entry.assets)) as Record<string, OverlayAsset>,
    [entries],
  );
  const shapeSvg = buildShapesSvgPreview(entries.map((entry) => entry.shape), assets);
  if (!shapeSvg) {
    return null;
  }
  return (
    <figure
      className={styles.shapeGroup}
      data-change={change}
      aria-label={change === "added" ? t("diff.after") : t("diff.before")}
    >
      {surface === "panel" && <DiffGutter change={change} />}
      <div className={styles.shapeStage} dangerouslySetInnerHTML={{ __html: shapeSvg.svg }} />
    </figure>
  );
});

/**
 * AI 提案の内容 (本文の塊と図形) を描く唯一の部品。本文カード・サイドバー・⌘K パネル・
 * チャットの図形サムネはすべてこれを使う。描くのは表示専用のコピーで、変わった単語だけを塗り、
 * id を付け替えて紙面の本物と同じ `data-sigma-doc-id` を出さない (`toDisplayProposalHunk`)。
 */
export function AiProposalContentView({
  content,
  surface,
  mathFractionSizing,
  paperWidthPx = DEFAULT_PANEL_PAPER_WIDTH_PX,
  outcome,
  caption,
}: AiProposalContentViewProps) {
  const hunks = useMemo(
    () => content.hunks.map((hunk) => ({ hunk, display: toDisplayProposalHunk(hunk) })),
    [content.hunks],
  );
  const shapeGroups = useMemo(
    () => SHAPE_CHANGES
      .filter((change) => surface === "panel" || change === "added")
      .map((change) => ({ change, entries: content.shapes.filter((entry) => entry.change === change) }))
      .filter((group) => group.entries.length > 0),
    [content.shapes, surface],
  );

  if (hunks.length === 0 && shapeGroups.length === 0) {
    return null;
  }

  // 説明を添えるときは、内容と説明を 1 つの図 (figure + figcaption) にまとめて読み上げる。
  const Root = caption ? "figure" : "div";
  return (
    <Root className={styles.content} data-ai-proposal-content="" data-surface={surface} data-outcome={outcome}>
      {hunks.map(({ hunk, display }, index) => (
        <ProposalHunk
          key={`${hunk.anchorBlockId}:${index}`}
          hunk={hunk}
          display={display}
          surface={surface}
          paperWidthPx={paperWidthPx}
          mathFractionSizing={mathFractionSizing}
        />
      ))}
      {shapeGroups.length > 0 && (
        <div className={styles.shapes} data-ai-proposal-shapes="">
          {shapeGroups.map((group) => (
            <ProposalShapeGroup key={group.change} change={group.change} entries={group.entries} surface={surface} />
          ))}
        </div>
      )}
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </Root>
  );
}
