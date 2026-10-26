import {
  createPageArrangement,
  displayCanvasSize,
  IDENTITY_PAGE_SHIFT,
  pageIndexAtDisplayPoint,
  pageShift,
  type ArrangementPoint,
  type FlowDisplacement,
  type PageArrangement,
} from "@/features/rendering/core";
import { FLOW_DX_ATTRIBUTE } from "./flow-probe";
import { getEffectiveZoom } from "@/features/rendering/adapters";

/**
 * ページの並び (`features/rendering/core/page-arrangement.ts`) を DOM から読む口。
 *
 * 紙面 (`.page-canvas`) は並べ方を属性で公開する。ポインタや描かれた矩形を紙面座標へ換算する
 * DOM ヘルパーは、props を通さずにここから並べ方を読んで表示 → モデルの逆変換を掛ける。
 * 1 列では `null` を返すので、呼び出し側は従来の計算をそのまま通せる。
 */
export const PAGE_ARRANGEMENT_ATTRIBUTE = "data-page-arrangement";
const PAGE_WIDTH_ATTRIBUTE = "data-page-width";
const PAGE_HEIGHT_ATTRIBUTE = "data-page-height";
const PAGE_STRIDE_ATTRIBUTE = "data-page-stride";

/** 本文の変位を描いた要素に添える、そのページのずらし (`FlowDisplacement.pageShiftX/Y`)。 */
export const FLOW_PAGE_SHIFT_X_ATTRIBUTE = "data-flow-page-shift-x";
export const FLOW_PAGE_SHIFT_Y_ATTRIBUTE = "data-flow-page-shift-y";

/** `.page-canvas` に付ける属性。1 列では何も足さない (DOM を従来と同じに保つ)。 */
export function getCanvasArrangementAttributes(arrangement: PageArrangement): Record<string, string> {
  if (arrangement.columns === 1) return {};
  return {
    [PAGE_ARRANGEMENT_ATTRIBUTE]: arrangement.mode,
    [PAGE_WIDTH_ATTRIBUTE]: String(arrangement.pageWidth),
  };
}

/** 要素が載る紙面の並べ方。1 列 (または紙面の外) なら null。 */
export function readCanvasPageArrangement(element: Element | null | undefined): PageArrangement | null {
  const canvas = element?.closest?.<HTMLElement>(".page-canvas");
  if (!canvas || canvas.getAttribute(PAGE_ARRANGEMENT_ATTRIBUTE) !== "spread") return null;
  const pageWidth = Number(canvas.getAttribute(PAGE_WIDTH_ATTRIBUTE));
  const pageHeight = Number(canvas.getAttribute(PAGE_HEIGHT_ATTRIBUTE));
  const stride = Number(canvas.getAttribute(PAGE_STRIDE_ATTRIBUTE));
  if (!(pageWidth > 0) || !(pageHeight > 0) || !(stride >= pageHeight)) return null;
  return createPageArrangement({ mode: "spread", pageWidth, pageHeight, pageGap: stride - pageHeight });
}

/** 変位を描く要素の属性に足すページのずらし。ずらしが無ければ空。 */
export function getFlowPageShiftAttributes(displacement: FlowDisplacement | undefined): Record<string, string> {
  if (!displacement || (!displacement.pageShiftX && !displacement.pageShiftY)) return {};
  return {
    [FLOW_PAGE_SHIFT_X_ATTRIBUTE]: String(displacement.pageShiftX ?? 0),
    [FLOW_PAGE_SHIFT_Y_ATTRIBUTE]: String(displacement.pageShiftY ?? 0),
  };
}

/**
 * 本文の要素が描かれているページのずらし。いちばん近い「変位を描いた要素」(ユニットか最上位
 * ブロック) が持つ値を使う。変位の無い要素はその外側と同じ場所 (同じページ) にある。
 */
export function readFlowPageShift(element: Element): ArrangementPoint {
  const host = element.closest(`[${FLOW_DX_ATTRIBUTE}]`);
  if (!host) return IDENTITY_PAGE_SHIFT;
  const x = Number(host.getAttribute(FLOW_PAGE_SHIFT_X_ATTRIBUTE) ?? 0);
  const y = Number(host.getAttribute(FLOW_PAGE_SHIFT_Y_ATTRIBUTE) ?? 0);
  return x === 0 && y === 0 ? IDENTITY_PAGE_SHIFT : { x, y };
}

/**
 * 紙面の表示座標 (拡大前の px) の点が載るページのずらし。ページの中の位置で決める計算
 * (段の判定など) は、これを引いた値で行い、描く位置へ戻すときに足す。1 列では 0。
 */
export function pageShiftAtCanvasPoint(element: Element | null | undefined, point: ArrangementPoint): ArrangementPoint {
  const arrangement = readCanvasPageArrangement(element);
  return arrangement ? pageShift(arrangement, pageIndexAtDisplayPoint(arrangement, point)) : IDENTITY_PAGE_SHIFT;
}

/**
 * 本文の図形の層 (紙面全体の座標) に属する要素なら、その紙面の並べ方。ヘッダー・フッターの層は
 * 用紙の中の座標なので null (用紙ごと動かして描くので、中の座標はそのまま)。1 列でも null。
 */
export function readBodyLayerArrangement(element: Element | null | undefined): PageArrangement | null {
  if (!element || element.closest(".a4-page-sheet, .page-layout-controls")) return null;
  return readCanvasPageArrangement(element);
}

/**
 * 描かれた本文の要素の矩形を、図形の層の座標 (モデル座標) で読む。`scale` は画面 px → 層の px。
 * 2 ページ並びでは層は並べた紙面の大きさなので、横幅から倍率を出し、要素のページのずらしを引く。
 * 1 列では従来どおり層の寸法 (`coordWidth` × `coordHeight`) に合わせる。
 */
export function createBodyLayerRectReader(
  layerElement: Element,
  layerRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  coordWidth: number,
  coordHeight: number,
): {
  scaleX: number;
  scaleY: number;
  shiftOf: (element: Element) => ArrangementPoint;
} {
  const arrangement = readBodyLayerArrangement(layerElement);
  if (layerElement.closest(".page-canvas") && !layerElement.closest(".a4-page-sheet, .page-layout-controls")) {
    // Paper millimetres are quantized to Chromium layout units. Inferring a
    // scale from those rounded dimensions moves stored anchors on every save.
    // Body flow already measures in CSS px with the actual zoom removed.
    return {
      scaleX: 1 / getEffectiveZoom(layerElement, "x"),
      scaleY: 1 / getEffectiveZoom(layerElement, "y"),
      shiftOf: arrangement ? readFlowPageShift : () => IDENTITY_PAGE_SHIFT,
    };
  }
  if (!arrangement) {
    return {
      scaleX: coordWidth / layerRect.width,
      scaleY: coordHeight / layerRect.height,
      shiftOf: () => IDENTITY_PAGE_SHIFT,
    };
  }
  const scale = displayCanvasSize(arrangement, 1).width / layerRect.width;
  return { scaleX: scale, scaleY: scale, shiftOf: readFlowPageShift };
}
