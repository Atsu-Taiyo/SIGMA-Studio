import { estimateBlockRects } from "@/features/document";
import type {
  EstimatedBlockRect,
  OverlayAnchor,
  OverlayShape,
  SigmaDocument,
} from "@/features/document";

/**
 * AI挿入経路が使う唯一の座標規約。
 *
 * - `shape.x` / `shape.y` は **ページ左上基準の絶対座標** (連続キャンバス座標)。
 * - `anchor.dx` / `anchor.dy` は **アンカーブロック左上からのデルタ**。
 *
 * レンダラの不変条件 (`features/drawing/anchor-position.ts` の
 * `resolveShapePosition`) が `x = blockLeft + dx` / `y = blockTop + dy` なので、
 * この2つを同じ数値にすると blockLeft/blockTop 分だけ二重加算になる。
 * MCPスキーマは x/y を絶対座標と宣言しているため、ここで推定ブロック矩形を
 * 使ってデルタへ変換するのが「意図と実装」を一致させる唯一の場所。
 *
 * 推定矩形は概算だが、描画位置は常に anchor から再計算されるので、推定誤差が
 * 画面に出ることはない (誤差は `shape.x/y` のキャッシュ値にだけ残り、DOM計測後の
 * `syncAnchoredShapesToRects` が上書きする)。
 */
export type AiOverlayBlockAnchor = Extract<OverlayAnchor, { type: "block" }>;

/** x/y も placement も指定されなかったときの「アンカーブロック直下」既定値。 */
export const AI_OVERLAY_DEFAULT_ANCHOR_DX = 0;
export const AI_OVERLAY_DEFAULT_ANCHOR_DY = 24;
/** 解決後の絶対座標がこれ未満にならないよう引き戻す (ページ外＝不可視・選択不能の防止)。 */
export const AI_OVERLAY_MIN_CANVAS_MARGIN_PX = 8;

/** `below` / `rightOf` でブロック端から空ける既定の余白。 */
const AI_OVERLAY_DEFAULT_EDGE_GAP_PX = 8;
/** `above` / `leftOf` は図形サイズが不明なので、はみ出し分を見込んだ目安値。 */
const AI_OVERLAY_DEFAULT_ABOVE_OFFSET_Y = 120;
const AI_OVERLAY_DEFAULT_SIDE_OFFSET_X = 200;

export interface AiOverlayPlacementRequest {
  anchorBlockId: string;
  position: "below" | "above" | "rightOf" | "leftOf";
  offsetX?: number;
  offsetY?: number;
}

export interface AiOverlayPlacementInput {
  /** 配置の基準になるドラフト文書 (`session.draftDocument`)。 */
  document: SigmaDocument;
  /** 挿入対象ブロック。`placement.anchorBlockId` が指定されればそちらが優先される。 */
  anchorBlockId: string;
  /** ページ左上基準の絶対座標。 */
  x?: number;
  y?: number;
  placement?: AiOverlayPlacementRequest;
  reserveSpace?: boolean;
  /** 推定済みブロック矩形。省略時は `document` から推定する (同一文書ならキャッシュされる)。 */
  blockRects?: Map<string, EstimatedBlockRect>;
}

export interface AiOverlayPlacement {
  x: number;
  y: number;
  anchor: AiOverlayBlockAnchor;
}

const blockRectCache = new WeakMap<SigmaDocument, Map<string, EstimatedBlockRect>>();

/**
 * 同一ドラフト文書に対するブロック矩形推定をメモ化する。SigmaDocument は
 * 編集のたびに新しいオブジェクトになるので、キャッシュが古い値を返すことはない。
 */
export function getAiOverlayBlockRects(document: SigmaDocument): Map<string, EstimatedBlockRect> {
  const cached = blockRectCache.get(document);
  if (cached) {
    return cached;
  }
  const rects = estimateBlockRects(document);
  blockRectCache.set(document, rects);
  return rects;
}

/**
 * AI挿入ツールの座標入力 (絶対 x/y または意味ベース placement) から、
 * 絶対座標とブロックアンカーデルタの整合したペアを作る。
 */
export function resolveAiOverlayPlacement(input: AiOverlayPlacementInput): AiOverlayPlacement {
  const blockId = input.placement?.anchorBlockId ?? input.anchorBlockId;
  const rects = input.blockRects ?? getAiOverlayBlockRects(input.document);
  const rect = rects.get(blockId);
  const rawDelta = input.placement
    ? getPlacementDelta(input.placement, rect)
    : getCoordinateDelta(input.x, input.y, rect);
  const delta = clampDeltaOntoCanvas(rawDelta, rect);

  return {
    // rect が引けない (推定に現れないブロック) 場合は変換のしようがないので、
    // デルタをそのまま絶対値として扱う。DOM計測後に anchor 経由で解決し直される。
    x: (rect?.left ?? 0) + delta.dx,
    y: (rect?.top ?? 0) + delta.dy,
    anchor: {
      type: "block",
      blockId,
      dx: delta.dx,
      dy: delta.dy,
      ...(input.reserveSpace === undefined ? {} : { reserveSpace: input.reserveSpace }),
    },
  };
}

export interface AnchorAbsoluteShapeInput {
  document: SigmaDocument;
  anchorBlockId: string;
  blockRects?: Map<string, EstimatedBlockRect>;
  /** AIが明示した既存の block アンカーも付け替える (問題エリア指定時など)。 */
  force?: boolean;
}

/**
 * すでに絶対 x/y を持つ図形 (素材クローン、`insert_overlay_shape` の生 shape) に、
 * その絶対座標と整合するブロックアンカーを与える。
 *
 * - `type:"shape"` アンカー (グラフ所有ラベル) は本文リフローではなく親図形に追従する
 *   ので常に温存する。
 * - `type:"page"` / アンカー無しは、AI挿入図形が本文リフローに追従するよう block へ
 *   変換する。絶対座標が分かっているこの時点で変換すれば位置が保たれる
 *   (後段の正規化フォールバックまで持ち越すと位置情報を失う)。
 */
export function anchorAbsoluteShape<T extends OverlayShape>(
  shape: T,
  input: AnchorAbsoluteShapeInput,
): T {
  if (shape.anchor?.type === "shape") {
    return shape;
  }
  if (shape.anchor?.type === "block" && !input.force) {
    return shape;
  }

  const rects = input.blockRects ?? getAiOverlayBlockRects(input.document);
  const rect = rects.get(input.anchorBlockId);

  return {
    ...shape,
    anchor: {
      type: "block",
      blockId: input.anchorBlockId,
      dx: shape.x - (rect?.left ?? 0),
      dy: shape.y - (rect?.top ?? 0),
    },
  };
}

/**
 * ページ外へ飛び出す配置を、キャンバス内へ引き戻す。
 *
 * `above` / `leftOf` は「アンカーブロックの外側」を意味するのでデルタ自体は負でよいが、
 * ページ先頭付近のブロックに対して既定オフセットを引くと絶対座標が負になり、図形が
 * 画面外に出て選択もできなくなる。デルタを固定クランプすると「上に置いて」が効かなく
 * なるため、クランプするのは **解決後の絶対座標** だけにして、はみ出した分だけデルタを
 * 戻す (rect が引けない場合は絶対座標が確定しないので何もしない)。
 */
function clampDeltaOntoCanvas(
  delta: { dx: number; dy: number },
  rect: EstimatedBlockRect | undefined,
): { dx: number; dy: number } {
  if (!rect) {
    return delta;
  }
  const overflowX = Math.max(0, AI_OVERLAY_MIN_CANVAS_MARGIN_PX - (rect.left + delta.dx));
  const overflowY = Math.max(0, AI_OVERLAY_MIN_CANVAS_MARGIN_PX - (rect.top + delta.dy));
  return {
    dx: delta.dx + overflowX,
    dy: delta.dy + overflowY,
  };
}

function getCoordinateDelta(
  x: number | undefined,
  y: number | undefined,
  rect: EstimatedBlockRect | undefined,
): { dx: number; dy: number } {
  return {
    dx: x === undefined ? AI_OVERLAY_DEFAULT_ANCHOR_DX : x - (rect?.left ?? 0),
    dy: y === undefined ? AI_OVERLAY_DEFAULT_ANCHOR_DY : y - (rect?.top ?? 0),
  };
}

/**
 * 意味ベース配置のデルタ。offset は MCP スキーマの宣言どおり「アンカーブロックの端
 * からの距離」として扱う。デルタの原点はブロック左上なので、`below` / `rightOf` は
 * ブロック自身の高さ・幅を足さないと図形がブロック本文に重なる。
 *
 * `above` / `leftOf` に図形サイズを足さないのは、この関数が図形の寸法を受け取らない
 * ため (ブロック上端・左端からの距離という宣言どおりの意味で、既定値は目安)。
 */
function getPlacementDelta(
  placement: AiOverlayPlacementRequest,
  rect: EstimatedBlockRect | undefined,
): { dx: number; dy: number } {
  switch (placement.position) {
    case "above":
      return {
        dx: placement.offsetX ?? 0,
        dy: -(placement.offsetY ?? AI_OVERLAY_DEFAULT_ABOVE_OFFSET_Y),
      };
    case "rightOf":
      return {
        dx: (rect?.width ?? 0) + (placement.offsetX ?? AI_OVERLAY_DEFAULT_EDGE_GAP_PX),
        dy: placement.offsetY ?? 0,
      };
    case "leftOf":
      return {
        dx: -(placement.offsetX ?? AI_OVERLAY_DEFAULT_SIDE_OFFSET_X),
        dy: placement.offsetY ?? 0,
      };
    case "below":
    default:
      return {
        dx: placement.offsetX ?? 0,
        dy: (rect?.height ?? 0) + (placement.offsetY ?? AI_OVERLAY_DEFAULT_EDGE_GAP_PX),
      };
  }
}
