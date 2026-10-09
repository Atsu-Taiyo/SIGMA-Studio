"use client";

import { useMemo } from "react";

import type { SigmaDocument } from "@/features/document";
import {
  collectProblemDisplayHiddenBlockIds,
  collectProblemDisplayHiddenShapeIds,
  isProblemDisplayFiltered,
  type ProblemDisplayFilter,
} from "@/features/rendering/core";

import type { EditorExtensionContextValue } from "../editor-extension-context";
import type { OverlayShapeDecoration } from "../overlay-canvas/editor-extension";

/** 絞り込みで隠した図形に付けるクラス。見せず、当たり判定も持たせない (CSS は graph-and-text-editing.css)。 */
export const PROBLEM_DISPLAY_HIDDEN_SHAPE_CLASS = "problem-display-hidden-shape";

const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface ProblemDisplayEditing {
  /** 編集面に描かれていないブロック。検索は探さず数えず、置換もしない。 */
  hiddenBlockIds: ReadonlySet<string>;
  /** 編集面に足す図形の編集方針。絞っていなければ undefined。 */
  editorExtensions: EditorExtensionContextValue | undefined;
}

/**
 * 設定 > 表示 で問題の領域を絞ったまま編集するための、編集面への指示。
 *
 * 隠した領域に錨を下ろした図形は、錨の先が描かれないので前回の位置に浮く。それを見せず (`overlayShapeDecorations`)、
 * 選ばせず動かさせず (`lockedShapeIds` / `unselectableShapeIds`)、保存時の付け替えや錨の補修でも書き換えさせない
 * (`preservedShapeIds`)。錨を持たない図形も、絞った紙面の近くの本文へ錨を推定されないよう書き換えから外す
 * (見せて編集はできる。人が動かしたときの錨はふだんどおり付く)。
 *
 * 打鍵のたびに文書は新しくなるが、集合の中身が同じなら同じ値を返す (編集面の全ユニットを描き直させない)。
 */
export function useProblemDisplayEditing(
  document: SigmaDocument,
  display: ProblemDisplayFilter | undefined,
): ProblemDisplayEditing {
  const active = display !== undefined && isProblemDisplayFiltered(display);
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes;
  const hiddenBlockIds = active ? collectProblemDisplayHiddenBlockIds(document.content, display) : EMPTY_IDS;
  const hiddenShapeIds = active && shapes
    ? collectProblemDisplayHiddenShapeIds(document.content, shapes, display, hiddenBlockIds)
    : EMPTY_IDS;
  const unanchoredShapeIds = active && shapes
    ? shapes.filter((shape) => shape.anchor === undefined && !hiddenShapeIds.has(shape.id)).map((shape) => shape.id)
    : [];

  const hiddenBlockKey = idKey(hiddenBlockIds);
  const hiddenShapeKey = idKey(hiddenShapeIds);
  const unanchoredShapeKey = idKey(unanchoredShapeIds);
  const stableHiddenBlockIds = useMemo(
    () => new Set(splitKey(hiddenBlockKey)) as ReadonlySet<string>,
    [hiddenBlockKey],
  );
  const editorExtensions = useMemo(
    () => active ? buildProblemDisplayEditorExtensions(splitKey(hiddenShapeKey), splitKey(unanchoredShapeKey)) : undefined,
    [active, hiddenShapeKey, unanchoredShapeKey],
  );
  return { hiddenBlockIds: stableHiddenBlockIds, editorExtensions };
}

export function buildProblemDisplayEditorExtensions(
  hiddenShapeIds: readonly string[],
  unanchoredShapeIds: readonly string[],
): EditorExtensionContextValue | undefined {
  if (hiddenShapeIds.length === 0 && unanchoredShapeIds.length === 0) {
    return undefined;
  }
  const hidden = new Set(hiddenShapeIds);
  const decoration: OverlayShapeDecoration = { className: PROBLEM_DISPLAY_HIDDEN_SHAPE_CLASS };
  return {
    overlayEditPolicy: {
      lockedShapeIds: hidden,
      unselectableShapeIds: hidden,
      preservedShapeIds: new Set([...hiddenShapeIds, ...unanchoredShapeIds]),
    },
    ...(hidden.size > 0
      ? { overlayShapeDecorations: new Map(hiddenShapeIds.map((id) => [id, decoration])) }
      : {}),
  };
}

function idKey(ids: Iterable<string>): string {
  return [...ids].sort().join("\u0000");
}

function splitKey(key: string): string[] {
  return key ? key.split("\u0000") : [];
}
