"use client";

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { PrintBoxBlock } from "@/components/print/print-static-blocks";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import styles from "./BoxSettingsPreview.module.css";

/**
 * 紙面での箱の組み方。プレビューはこの幅・この字の大きさで組んでから、入れ物の幅へ縮める。
 * 縮めずに入れ物の幅で組み直すと、折り返し・余白と文字の比・角丸の見え方が紙面と変わる。
 */
export interface BoxPreviewPaper {
  /** 紙面での箱の外形の幅 (CSS px)。 */
  widthPx: number;
  /** 紙面の本文の字の大きさ (`--editor-font-size` の値。例 `12pt`)。 */
  fontSize?: string;
}

/** 紙面の箱の幅が分からないとき (テストや紙面の外から開いたとき) の組版幅。A4 1 段の本文幅に近い。 */
const FALLBACK_PAPER_WIDTH_PX = 640;
/** 長い箱でもプレビューを軽く保つ。枠の見た目 (四隅・下の余白まで) を見るにはこれで足りる。 */
export const BOX_PREVIEW_BODY_BLOCK_LIMIT = 6;
/** 紙面の本物と同じ `data-sigma-doc-id` を 2 つ並べない (計測やアンカーが先に見つけた方を採る)。 */
export const BOX_PREVIEW_ID_PREFIX = "box-settings-preview:";
const PREVIEW_COLUMN_GAP_MM = 8;

/**
 * 箱の設定のプレビュー。紙面・印刷と同じ静的描画 ({@link PrintBoxBlock}) で、その箱のタイトルと
 * 本文をそのまま描く。設定ダイアログは変更をすぐ教材へ書くので、ここに渡る値は紙面の箱と同じ。
 *
 * 紙面での箱の幅で組み、入れ物に収まるよう `transform` だけで縮める (等倍を超えて拡大しない)。
 * `transform` は配置の大きさを変えないので、縮めた後の高さを入れ物に与える。
 */
export function BoxSettingsPreview({
  box,
  title,
  subtitle,
  body,
  paper,
  mathFractionSizing,
}: {
  box: Pick<BoxBlockNode, "id" | "styleId" | "frame">;
  title: InlineNode[];
  subtitle?: InlineNode[];
  body?: BoxBlockChildBlock[];
  paper?: BoxPreviewPaper;
  mathFractionSizing?: MathFractionSizing | null;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ scale: number; height: number } | null>(null);
  // cornerbox の四隅の切り欠きは箱の高さで大きさが決まる。紙面と同じく描いた箱の高さから求める。
  const [boxHeightPx, setBoxHeightPx] = useState<number>();
  const paperWidthPx = paper?.widthPx && paper.widthPx > 0 ? paper.widthPx : FALLBACK_PAPER_WIDTH_PX;

  const previewBox = useMemo((): BoxBlockNode => withPreviewIds({
    type: "boxBlock",
    id: box.id,
    styleId: box.styleId,
    ...(box.frame ? { frame: box.frame } : {}),
    title,
    ...(subtitle ? { subtitle } : {}),
    blocks: previewBody(body, box.id),
  }), [body, box.frame, box.id, box.styleId, subtitle, title]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const sheet = sheetRef.current;
    if (!viewport || !sheet) {
      return;
    }
    const update = () => {
      const available = viewport.clientWidth;
      const scale = available > 0 ? Math.min(1, available / sheet.offsetWidth) : 1;
      const height = Math.ceil(sheet.offsetHeight * scale);
      setFit((previous) => (previous && previous.scale === scale && previous.height === height ? previous : { scale, height }));
      const boxElement = sheet.querySelector<HTMLElement>(".print-box-block");
      setBoxHeightPx(boxElement ? boxElement.offsetHeight : undefined);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [paperWidthPx]);

  const sheetStyle = {
    "--box-preview-paper-width": `${paperWidthPx}px`,
    ...(paper?.fontSize ? { "--editor-font-size": paper.fontSize } : {}),
    ...(fit ? { transform: `scale(${fit.scale})` } : {}),
  } as CSSProperties;
  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      style={fit ? { height: `${fit.height}px` } : undefined}
      data-preview-scale={fit ? String(Math.round(fit.scale * 1000) / 1000) : undefined}
    >
      <div ref={sheetRef} className={`${styles.sheet} text-flow-editor`} style={sheetStyle}>
        <PrintBoxBlock
          block={previewBox}
          columnGapMm={PREVIEW_COLUMN_GAP_MM}
          mathFractionSizing={mathFractionSizing ?? undefined}
          cornerReferenceHeightPx={boxHeightPx}
        />
      </div>
    </div>
  );
}

function previewBody(body: BoxBlockChildBlock[] | undefined, boxId: string): BoxBlockChildBlock[] {
  if (body && body.length > 0) {
    return body.slice(0, BOX_PREVIEW_BODY_BLOCK_LIMIT);
  }
  // 箱の本文は空でも 1 段落を持つ。中身を渡されないときも同じ高さの空の段落で組む。
  return [{ type: "paragraph", id: `${boxId}-body`, children: [] }];
}

/** すべての `id` (と段組みの段の先頭 id) に接頭辞を付けた深いコピー。 */
function withPreviewIds<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withPreviewIds) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" && typeof child === "string") {
      copy[key] = `${BOX_PREVIEW_ID_PREFIX}${child}`;
    } else if (key === "columnStartIds" && Array.isArray(child)) {
      copy[key] = child.map((id) => (typeof id === "string" ? `${BOX_PREVIEW_ID_PREFIX}${id}` : id));
    } else {
      copy[key] = withPreviewIds(child);
    }
  }
  return copy as T;
}
