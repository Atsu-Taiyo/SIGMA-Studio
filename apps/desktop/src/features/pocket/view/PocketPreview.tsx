"use client";

import { Shapes } from "lucide-react";
import { useMemo } from "react";

import { PrintBlock, PrintProblemArea, buildProblemAreaPrintUnits } from "@/components/print/print-static-blocks";
import type { OverlayAsset, OverlayShape, SigmaBlock } from "@/features/document";
import { getShapesSelectionBounds } from "@/features/drawing";
import { MathPreview } from "@/features/rendering/adapters/react";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";

import type { PocketPreview } from "../model/pocket-preview";
import styles from "./PocketPreview.module.css";

/** 図形の周りの余白 (図形の座標系)。 */
const SHAPES_PADDING_PX = 8;
/** 描く図形の数の上限。大量に選んでいても、カードの描画で固まらない。 */
const SHAPES_RENDER_LIMIT = 60;
const PREVIEW_COLUMN_GAP_MM = 8;

/**
 * 図形を切り抜いた自己完結の SVG を、画像として描く。
 *
 * DOM へ SVG の文字列を展開せず `<img>` の data URL にする: 画像として読み込んだ SVG は
 * スクリプトも外部資源も動かさないので、コピー元の内容がどうであれ紙面に影響しない。
 */
function createShapesImageSource(shapes: OverlayShape[], assets: Record<string, OverlayAsset>): string | null {
  const drawn = shapes.slice(0, SHAPES_RENDER_LIMIT);
  const bounds = getShapesSelectionBounds(drawn);
  if (!bounds) {
    return null;
  }
  const svg = exportOverlaySvg(drawn, assets, {
    width: Math.max(1, bounds.w + SHAPES_PADDING_PX * 2),
    height: Math.max(1, bounds.h + SHAPES_PADDING_PX * 2),
    offsetX: bounds.x - SHAPES_PADDING_PX,
    offsetY: bounds.y - SHAPES_PADDING_PX,
  });
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

function ShapesPreview({ shapes, assets }: { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> }) {
  const source = useMemo(() => createShapesImageSource(shapes, assets), [shapes, assets]);
  return source ? (
    // eslint-disable-next-line @next/next/no-img-element -- 切り抜いた図形の data URL で、最適化の対象ではない
    <img className={styles.shapes} src={source} alt="" draggable={false} />
  ) : (
    <Shapes className={styles.fallbackIcon} size={20} aria-hidden="true" />
  );
}

function BlockPreview({ block }: { block: SigmaBlock }) {
  if (block.type === "problem") {
    return (
      <>
        {buildProblemAreaPrintUnits(block).map((unit) => (
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
          />
        ))}
      </>
    );
  }
  return (
    <PrintBlock
      unit={{ type: "block", id: block.id, block, pagination: block.pagination }}
      columnGapMm={PREVIEW_COLUMN_GAP_MM}
    />
  );
}

/**
 * 本文のブロックを、紙面と同じ静的描画 (数式・太字・色・箱・問題の枠まで) で小さく見せる。
 * 組版幅のまま描いて縮小し、下は薄く消して「続きがある」ことを示す。操作は受けない。
 */
function BlocksPreview({ blocks }: { blocks: SigmaBlock[] }) {
  return (
    <div className={styles.blocksViewport}>
      <div className={styles.blocksPage}>
        {blocks.map((block) => (
          <BlockPreview key={block.id} block={block} />
        ))}
      </div>
    </div>
  );
}

function TextPreview({ text }: { text: string }) {
  return <p className={styles.text}>{text}</p>;
}

function MathOnlyPreview({ tex }: { tex: string }) {
  return (
    <div className={styles.math}>
      <MathPreview tex={tex} displayMode />
    </div>
  );
}

/** カードの中身。種類ごとに「それがどう見えるか」で描き分ける。 */
export function PocketItemPreview({ preview }: { preview: PocketPreview }) {
  switch (preview.kind) {
    case "blocks":
      return <BlocksPreview blocks={preview.blocks} />;
    case "shapes":
      return (
        <div className={styles.figure}>
          <ShapesPreview shapes={preview.shapes} assets={preview.assets} />
        </div>
      );
    case "mixed":
      return (
        <div className={styles.mixed}>
          <TextPreview text={preview.text} />
          <div className={styles.figure}>
            <ShapesPreview shapes={preview.shapes} assets={preview.assets} />
          </div>
        </div>
      );
    case "math":
      return <MathOnlyPreview tex={preview.tex} />;
    case "text":
      return <TextPreview text={preview.text} />;
  }
}
