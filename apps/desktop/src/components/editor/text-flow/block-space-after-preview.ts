/**
 * ブロック下余白つまみを掴んでいる間だけ生きる、小さなストア。
 *
 * **持つのは 2 つだけ**
 *
 * 1. cohort (掴んだブロックと、それに追従するブロックの id) — pointerdown で 1 回決まり、
 *    ドラッグ中は変わらない。購読者 (各 `TextFlowEditor`) はこれを読んで decoration の印を
 *    付け替える。
 * 2. 平行移動量 (px) — 60Hz で動く。これは **購読者に流さない**。登録された紙面の親要素へ
 *    CSS custom property として直接書くだけなので、pointermove 1 回あたりのコストは
 *    `setProperty` 1 回きり (React 再レンダー 0・ProseMirror transaction 0・レイアウト 0)。
 *
 * **なぜ props ではなくモジュールのストアか**
 *
 * 下余白に追従する面は 1 つではない。本文ユニット・問題エリア・段組の各面に加えて、ページを
 * またぐブロックの複製も同じブロックを描く。props で配ると「1 箇所に渡し忘れて継ぎ目だけ
 * 追従しない」が構造的に起こりうるが、ストアなら全部が同じ 1 つの値を読む。
 *
 * 掴めるつまみは同時に 1 つなので、中身は「無し」か「1 件」しか取らない。
 */

import { BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE } from "@/features/document";

export interface BlockSpaceAfterPreview {
  /** 掴んでいるブロック。自身は動かない (下の余白が伸びるので、動くのは後続)。 */
  blockId: string;
  /** ProseMirror の面が印を付けるブロック (殻ごと動くユニットの中身は含まない)。 */
  followerBlockIds: readonly string[];
}

let preview: BlockSpaceAfterPreview | null = null;
let deltaPx = 0;
const roots = new Set<HTMLElement>();
const listeners = new Set<() => void>();

/**
 * 平行移動量を書き込む先 (紙面の親)。ズームの `transform: scale()` の内側なので、
 * canvas px のまま書けば拡大率は自動で乗る。
 */
export function registerBlockSpaceAfterPreviewRoot(element: HTMLElement): () => void {
  roots.add(element);
  // 掴んだ後にマウントされた面 (ページ窓に入ってきた紙) も、いまの値から描き始める。
  writeDelta(element);
  return () => {
    roots.delete(element);
    element.style.removeProperty(BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE);
  };
}

/** ドラッグ開始。購読者へ 1 回だけ知らせる (各面が decoration の印を付ける)。 */
export function beginBlockSpaceAfterPreview(next: BlockSpaceAfterPreview): void {
  preview = next;
  deltaPx = 0;
  writeAllDeltas();
  notify();
}

/**
 * ポインタの移動ぶん。**購読者は呼ばない** — ここが毎フレーム走るので、通知を挟むと
 * 紙面全体の装飾が 60Hz で走り直す (それが直したかった重さそのもの)。
 */
export function setBlockSpaceAfterPreviewDeltaPx(nextDeltaPx: number): void {
  if (!preview || nextDeltaPx === deltaPx) {
    return;
  }
  deltaPx = nextDeltaPx;
  writeAllDeltas();
}

/** ドラッグ終了 (確定・破棄のどちらも)。印と移動量をまとめて外す。 */
export function endBlockSpaceAfterPreview(): void {
  if (!preview) {
    return;
  }
  preview = null;
  deltaPx = 0;
  for (const element of roots) {
    element.style.removeProperty(BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE);
  }
  notify();
}

export function getBlockSpaceAfterPreview(): BlockSpaceAfterPreview | null {
  return preview;
}

export function subscribeBlockSpaceAfterPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function writeAllDeltas(): void {
  for (const element of roots) {
    writeDelta(element);
  }
}

function writeDelta(element: HTMLElement): void {
  if (!preview) {
    return;
  }
  element.style.setProperty(BLOCK_SPACE_AFTER_PREVIEW_CSS_VARIABLE, `${deltaPx}px`);
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}
