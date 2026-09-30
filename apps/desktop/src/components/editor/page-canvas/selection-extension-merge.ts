import { createElement, Fragment } from "react";

import type { PageCanvasSelectionAction, PageCanvasSelectionExtension } from "./editor-extension";

/**
 * 選択に対する 2 つの拡張 — 編集操作 (`tools`) と、機能側 (AI など) の `feature` — を 1 つにまとめる。
 *
 * 紙面は選択の測定とポップオーバーの配置だけを持ち、何が並ぶかは拡張が決める。並びは
 * 編集操作が先、機能側のアクションが後 (「書式 | AIに依頼」)。候補の通知と解除は機能側のもので、
 * 編集操作は AI の参照候補を知らない。
 */
export function mergeSelectionExtensions(
  tools: PageCanvasSelectionExtension | undefined,
  feature: PageCanvasSelectionExtension | undefined,
): PageCanvasSelectionExtension | undefined {
  if (!tools) {
    return feature;
  }
  if (!feature) {
    return tools;
  }

  return {
    createAction: (source) => mergeSelectionActions(tools.createAction(source), feature.createAction(source)),
    clearCandidate: feature.clearCandidate,
    retainCandidateOnTextSelectionClear: feature.retainCandidateOnTextSelectionClear,
  };
}

function mergeSelectionActions(
  tools: PageCanvasSelectionAction | null,
  feature: PageCanvasSelectionAction | null,
): PageCanvasSelectionAction | null {
  if (!tools || !feature) {
    return tools ?? feature;
  }

  return {
    key: JSON.stringify([tools.key, feature.key]),
    render: (position) => createElement(Fragment, null, tools.render(position), feature.render(position)),
    notifyCandidate: feature.notifyCandidate,
  };
}
