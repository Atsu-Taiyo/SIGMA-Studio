import type { EditorClipboardPayload } from "@/lib/editor-clipboard";
import type { Graph2DPreset, Graph3DPreset } from "@/features/document";
import type { SharedFillState } from "./overlay-canvas/style-patch";
import type { OverlayArrowhead, OverlayAsset, OverlayDash, OverlayPoint, OverlayShape, OverlayTextSize } from "./overlay-canvas/types";

export const FLUSH_OVERLAY_CHANGES_EVENT = "sigma-studio:flush-overlay-changes";

/**
 * A style shown but not persisted, for controls that follow a drag.
 *
 * A window event rather than an overlay action: an action is shell state, so a slider would update
 * the whole shell on every tick, and a preview dispatched while the palette unmounts would race the
 * commit that replaced it in the same batch. `null` drops the preview.
 */
export const OVERLAY_STYLE_PREVIEW_EVENT = "sigma-studio:overlay-style-preview";

export type OverlayStylePreviewEvent = CustomEvent<{ style: OverlaySelectionStylePatch | null }>;

export function dispatchOverlayStylePreview(style: OverlaySelectionStylePatch | null): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(OVERLAY_STYLE_PREVIEW_EVENT, { detail: { style } }));
}

/** How a persisted overlay change participates in the document-level history. */
export type OverlayChangeHistory = "record" | "coalesce";

export interface OverlayChangeOptions {
  history?: OverlayChangeHistory;
  /**
   * undo のコアレスキー。本文と図形が混ざったペースト / カットで、本文側が鋳造した
   * キーをここへ通すと 1 つの undo エントリに畳まれる
   * (`text-flow/clipboard-history-group.ts`)。
   */
  historyGroup?: string;
}

/**
 * ページ設定の変更だけが持てるオプション。
 *
 * `silent` を共有の `OverlayChangeOptions` へ足すと、overlay の変更でも渡せる形になるのに
 * そちらは見ていない (無言で効かないオプションになる)。尊重する経路の型にだけ持たせる。
 */
export interface PageLayoutChangeOptions extends OverlayChangeOptions {
  /**
   * ステータス行を更新しない。浮遊コントロールのように「見ながら何度も切り替える」
   * 操作で毎回メッセージを出すと、直前の保存状態など読みたい表示を潰してしまう。
   */
  silent?: boolean;
}

export type OverlayCommand =
  | "select"
  | "rectangle"
  | "circle"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "heptagon"
  | "octagon"
  | "nonagon"
  | "decagon"
  | "hendecagon"
  | "dodecagon"
  | "blockArrow"
  | "arc"
  | "sector"
  | "threePointArc"
  | "arrow"
  | "line"
  | "polyline"
  | "curve"
  | "freehand"
  | "highlight"
  | "text"
  | "callout"
  | "graph"
  | "graph3d"
  | "table";

export type OverlayArrangeAction = "front" | "back" | "forward" | "backward";
export type OverlayAlignAction = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type OverlayDistributeAxis = "horizontal" | "vertical";

export interface OverlaySelectionStylePatch {
  color?: string;
  fillColor?: string;
  strokeOpacity?: number;
  fillOpacity?: number;
  fill?: "none" | "solid";
  dash?: OverlayDash;
  size?: OverlayTextSize;
  opacity?: number;
  arrowheadStart?: OverlayArrowhead;
  arrowheadEnd?: OverlayArrowhead;
}

export interface OverlaySelectionSummary {
  /** Transient empty selection in absolute, unzoomed canvas coordinates. */
  region?: { x: number; y: number; w: number; h: number };
  /** The active text session survives focus moving into the formatting toolbar. */
  textEditing?: { shapeId: string; kind: "text" | "table" };
  selectedCount: number;
  selectedShapeIds: string[];
  selectedShapes: OverlayShape[];
  selectedAssets: Record<string, OverlayAsset>;
  locked: boolean;
  hidden: boolean;
  grouped: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canStyleStroke: boolean;
  canStyleFill: boolean;
  canStyleLine: boolean;
  canStyleLineEndpoints: boolean;
  arrowheadStart: OverlayArrowhead | null;
  arrowheadEnd: OverlayArrowhead | null;
  /** The selection's own fill, so the toolbar shows the document rather than the last value applied. */
  fill: SharedFillState;
}

export type OverlayActionRequestInput =
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "arrange"; action: OverlayArrangeAction }
  | { type: "align"; action: OverlayAlignAction }
  | { type: "distribute"; axis: OverlayDistributeAxis }
  | { type: "group" }
  | { type: "ungroup" }
  | { type: "toggleLock" }
  | { type: "toggleHidden" }
  | { type: "style"; style: OverlaySelectionStylePatch }
  | { type: "insertTextAtPoint"; point: { x: number; y: number } }
  /**
   * 本文の選択範囲にぶら下がっている図形を、本文の選択を保ったまま選ぶ。
   *
   * 本文にキャレットがある状態から要求されるので、オーバーレイ側はフォーカスを奪わない
   * (奪うと本文の選択が消え、混在選択の意味が無くなる)。
   */
  /** `allShapes` は本文の全選択から来た要求。この面の図形を全部選ぶ。 */
  | { type: "selectShapesForBlocks"; blockIds: string[]; allShapes?: boolean }
  /**
   * Paste shapes the shell received while the overlay was not mounted — the case when the copy
   * came from another material tab. Requesting the action mounts the overlay editor, and the
   * request is handled one tick later, by which time the canvas knows its own size.
   */
  | {
      type: "pasteShapes";
      payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>;
      /** コピー元ブロック id → 貼り付けで生まれたブロック id。 */
      anchorBlockIdMap?: Record<string, string>;
      /** 本文と 1 つの undo エントリに畳むためのコアレスキー。 */
      historyGroup?: string;
    };

export type OverlayActionRequest = OverlayActionRequestInput & { id: number };

export interface OverlayCommandRequest {
  id: number;
  command: OverlayCommand;
  graphPreset?: Graph2DPreset;
  graph3dPreset?: Graph3DPreset;
}

export interface OverlayImageRequest {
  id: number;
  files: File[];
  point?: OverlayPoint;
}

export interface OverlaySelectPointRequest {
  id: number;
  point: {
    x: number;
    y: number;
  };
  screenPoint?: {
    x: number;
    y: number;
  };
  dragEndPoint?: {
    x: number;
    y: number;
  };
  startCrop?: boolean;
  focusTextOnMiss?: boolean;
  startMarquee?: boolean;
  targetShapeId?: string;
}

export type OverlayModeId =
  | "document"
  | "overlay.select"
  | "overlay.move"
  | "overlay.resize"
  | "overlay.rotate"
  | "overlay.anchor"
  | "overlay.marquee"
  | "overlay.textEditing"
  | "overlay.imageCropping"
  | "overlay.graphEditing"
  | "overlay.graph3dEditing"
  | "overlay.tableEditing"
  | "overlay.originPicking"
  | "overlay.graphFillPicking"
  | "overlay.curveDrawing"
  | "overlay.insertDrag";

/**
 * 操作状態の呼び名。**`shape` namespace の `mode.<id>` を引くための識別子で、文言ではない。**
 * 状態は overlay → シェル → 素材エディタと props を渡り歩くので、ここに訳文を載せると
 * 受け取った側が日本語を英文に埋め込む (「外側だけ訳す」問題) を作りやすい。
 * `OverlayModeId` と別なのは、1つの mode が入力ツール次第で別の呼び名になるから
 * (`overlay.curveDrawing` は折れ線 / 曲線 / 3点円弧の3通り)。
 */
export const OVERLAY_MODE_STATUS_LABEL_IDS = [
  "moving",
  "resizing",
  "rotating",
  "anchoring",
  "marquee",
  "textEditing",
  "imageCropping",
  "graphEditing",
  "graph3dEditing",
  "tableEditing",
  "originPicking",
  "fillPicking",
  "threePointArc",
  "polyline",
  "curve",
  "placeShape",
  "pickViewport",
  "insert",
  "shape",
  "select",
  // 状態がまだ無い面の既定 (`DEFAULT_OVERLAY_MODE_STATUS_LABEL_ID`)。
  // `getModeStatus` は返さないが、辞書のキーとしては同じ列に載せて検査対象にする。
  "selection",
] as const;

export type OverlayModeStatusLabelId = (typeof OVERLAY_MODE_STATUS_LABEL_IDS)[number];

/** overlay をまだ触っていない面が読み上げる既定の呼び名。 */
export const DEFAULT_OVERLAY_MODE_STATUS_LABEL_ID: OverlayModeStatusLabelId = "selection";

export interface OverlayModeStatus {
  id: OverlayModeId;
  labelId: OverlayModeStatusLabelId;
}
