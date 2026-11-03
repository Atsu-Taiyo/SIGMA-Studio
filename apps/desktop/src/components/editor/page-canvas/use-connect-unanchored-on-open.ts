"use client";
import { normalizeOverlaySnapshot, type PageOverlay } from "@/features/document";
import { useEffect, useRef, type RefObject } from "react";
import type { MeasuredBlock } from "../overlay-canvas/anchor";
import { connectUnanchoredShapesToBody, type BodyPageBand } from "../overlay-canvas/connect-unanchored-shapes";
import { isTextFlowMeasurementReady } from "../text-flow/measurement-revision";

/**
 * 紙面が落ち着いたとみなすまでの静けさ。開いた直後の計測は、ページ割りの変位を描く前・字体が載る前の
 * 位置を返すことがある (MISS.md R25 と同じ穴)。その位置で錨のずれを測ると、落ち着いた後に図形がずれる。
 */
const OPEN_SETTLE_MS = 300;
/** 字体の読み込みや本文の描き込みを待つ上限 (回数 × `OPEN_SETTLE_MS`)。越えたら今回は繋がない。 */
const MAX_SETTLE_ATTEMPTS = 20;

interface ConnectUnanchoredOnOpenInputs {
  docId: string;
  /**
   * 繋ぐ教材か。ホワイトボード (図形は絶対座標)、PowerPoint / PDF の取り込みのように紙面の座標そのものが
   * 正本の教材 (`metadata.source.layoutMode: "fixedOverlay"`)、書き込まない読み取り面では false。
   */
  enabled: boolean;
  /** 紙面の一部を描いていない間 (設定 > 表示 の絞り込み)。本文の高さが本来と違うので、外れるまで待つ。 */
  paused: boolean;
  flowRef: RefObject<HTMLDivElement | null>;
  /** 図形が繋げるブロック (入れ子を含む) の実測。本文の幾何が動くたびに新しい配列になる。 */
  blocks: MeasuredBlock[];
  band: BodyPageBand;
  overlayRef: RefObject<PageOverlay>;
  onReanchorOverlayRef: RefObject<(overlay: PageOverlay) => void>;
  /** 書き換えない図形 (機能が守る `preservedShapeIds` と AI が編集中の `lockedShapeIds`)。 */
  untouchableShapeIdsRef: RefObject<ReadonlySet<string>>;
}

/**
 * 教材を開いたとき、本文と繋がっていない図形 (錨が無い・ページに固定) を、その図形がある高さの本文へ 1 回だけ
 * 繋ぐ。すでに繋がっている図形は変えない。どこへ繋ぐかは `connectUnanchoredShapesToBody`。
 *
 * 開いている間に後から入った図形には使わない: 貼り付けなど、その場で選んだ繋ぎ方を操作の途中で書き換えない。
 * 錨の無い図形は、これまでどおり計測のたびの補修 (`attachUnanchoredShapesToMeasuredBlocks`) が繋ぐ。
 */
export function useConnectUnanchoredOnOpen({
  docId,
  enabled,
  paused,
  flowRef,
  blocks,
  band,
  overlayRef,
  onReanchorOverlayRef,
  untouchableShapeIdsRef,
}: ConnectUnanchoredOnOpenInputs): void {
  const passRef = useRef<{ docId: string; done: boolean }>({ docId, done: false });
  const { pageStridePx, contentTopPx, contentHeightPx } = band;

  useEffect(() => {
    if (passRef.current.docId !== docId) {
      passRef.current = { docId, done: false };
    }
    const pass = passRef.current;
    if (pass.done) {
      return;
    }
    if (!enabled) {
      pass.done = true;
      return;
    }
    if (paused || blocks.length === 0) {
      return;
    }

    let timer: number | null = null;
    let attempts = 0;
    // 本文の幾何が動くたびにこの effect が貼り直され、待ちも初めからになる (最後の変化から静けさを数える)。
    const attempt = () => {
      timer = null;
      if (pass.done) {
        return;
      }
      const flow = flowRef.current;
      const fonts = typeof window === "undefined" ? undefined : window.document.fonts;
      const settled = flow !== null && isTextFlowMeasurementReady(flow) && (!fonts || fonts.status === "loaded");
      if (!settled) {
        attempts += 1;
        if (attempts < MAX_SETTLE_ATTEMPTS) {
          timer = window.setTimeout(attempt, OPEN_SETTLE_MS);
        }
        return;
      }
      pass.done = true;
      const overlay = overlayRef.current;
      const snapshot = overlay?.overlaySnapshot;
      if (!overlay || !snapshot) {
        return;
      }
      const normalized = normalizeOverlaySnapshot(snapshot);
      const shapes = connectUnanchoredShapesToBody(
        normalized.shapes,
        blocks,
        { pageStridePx, contentTopPx, contentHeightPx },
        { untouchableShapeIds: untouchableShapeIdsRef.current ?? undefined },
      );
      if (shapes === normalized.shapes) {
        return;
      }
      const nextOverlay: PageOverlay = {
        ...overlay,
        overlaySnapshot: { ...normalized, shapes },
        updatedAt: new Date().toISOString(),
      };
      overlayRef.current = nextOverlay;
      // 本文の変更ではない派生の書き換えなので、undo の段を増やさない (削除後の付け替えと同じ口)。
      onReanchorOverlayRef.current?.(nextOverlay);
    };
    timer = window.setTimeout(attempt, OPEN_SETTLE_MS);
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [blocks, contentHeightPx, contentTopPx, docId, enabled, flowRef, onReanchorOverlayRef, overlayRef, pageStridePx, paused, untouchableShapeIdsRef]);
}
