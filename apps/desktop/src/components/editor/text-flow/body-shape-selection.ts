import type { EditorState } from "@tiptap/pm/state";

/** シェル → 本文エディタ: 「いまの選択に、ぶら下がっている図形を足して選べ」。 */
export const SELECT_BODY_WITH_SHAPES_EVENT = "sigma-studio:select-body-with-shapes";

/** 本文エディタ → シェル: 選択が覆っているブロック id。シェルがこれを図形選択に変換する。 */
export const BODY_SELECTION_SHAPES_REQUEST_EVENT = "sigma-studio:body-selection-shapes-request";

export interface BodySelectionShapesRequestDetail {
  /** 文書順のブロック id。入れ子 (箱の中の段落など) も含む。 */
  blockIds: string[];
  /** 要求元エディタの DOM。シェルが「文書本文か」を判定する。 */
  source: HTMLElement;
  /**
   * 範囲を持たないキャレットからの全選択。この面の図形は全部選ぶ (アンカーも重なりも
   * 持たない余白の図形まで含めて「全部」にする)。
   */
  wholeDocument?: boolean;
}

export function requestBodySelectionShapes(detail: BodySelectionShapesRequestDetail): void {
  window.dispatchEvent(new CustomEvent(BODY_SELECTION_SHAPES_REQUEST_EVENT, { detail }));
}

/**
 * 選択範囲が実際に覆っているブロックの id を文書順で返す。
 *
 * 図形のアンカーは `[data-sigma-doc-id]` を持つブロックを名指しする。入れ子のブロック
 * (箱の中の段落) にもぶら下がれるので、深さで絞らず id を持つノードを全部見る。
 *
 * 境界に「触れているだけ」のブロックは外す。段落の末尾から次の段落の先頭までを選んだとき、
 * 文字を 1 つも含まない側のブロックまで拾うと、その段落の図形まで選択に混ざる。
 */
export function collectSelectedBlockIds(state: EditorState): string[] {
  const { from, to } = state.selection;
  return collectBlockIdsInRange(state, from, to);
}

/**
 * 範囲を明示する版。跨ぎ選択 (`text-run-span`) はユニットごとに担当範囲を持ち、PM の
 * `state.selection` はそのユニットの分しか指していないので、担当範囲を渡して集める。
 */
export function collectBlockIdsInRange(state: EditorState, from: number, to: number): string[] {
  if (to <= from) {
    return [];
  }

  const blockIds: string[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    const blockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
    if (!blockId || node.isText) {
      return true;
    }
    if (coversBlockContent(from, to, pos, node.nodeSize)) {
      blockIds.push(blockId);
    }
    return true;
  });
  return [...new Set(blockIds)];
}

/**
 * 空のブロックだけは「重なりの長さ 0」になるので、範囲が位置ごと覆っているかで判定する。
 * 中身のあるブロックは長さのある重なりを要求する (境界に触れただけを弾くのがここの目的)。
 */
function coversBlockContent(from: number, to: number, pos: number, nodeSize: number): boolean {
  const contentStart = pos + 1;
  const contentEnd = pos + nodeSize - 1;
  if (contentEnd <= contentStart) {
    return from <= contentStart && contentEnd <= to;
  }
  return from < contentEnd && contentStart < to;
}
