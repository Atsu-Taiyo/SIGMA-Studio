import type { PocketItem } from "../model/pocket-items";

/**
 * ポケットのカードをドラッグしているときだけ載せる MIME。中身は項目の ID だけで、本文の
 * クリップボード (SigmaDoc の payload や HTML) は載せない。
 *
 * `text/plain` や `text/html` を添えないのは、ドロップ先の ProseMirror が自分でその文字を
 * 挿入してしまい、ポケットの挿入と二重になるため。ポケットの項目は編集面の貼り付けと同じ
 * 経路で入れるので、ドラッグが運ぶのは「どの項目か」だけでよい。
 */
export const POCKET_DRAG_MIME = "application/x-sigma-pocket-item";

/** ドロップされた場所。座標は画面のもので、紙面の座標へ直せたときだけ `pagePoint` が入る。 */
export interface PocketDropLocation {
  readonly clientX: number;
  readonly clientY: number;
  /** 紙面 (ホワイトボードはカメラを引いた座標) の位置。直せない場所では null。 */
  readonly pagePoint: PocketPagePoint | null;
}

export interface PocketPagePoint {
  readonly x: number;
  readonly y: number;
}

/** 画面の座標での矩形。入れたものが飛んでいく元の位置に使う。 */
export interface PocketScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 紙面 (オーバーレイ) へ項目を置く役。紙面の座標系と図形の追加を知っているのは編集画面なので、
 * ポケットはその窓口だけを持ち、実装は `EditorShell` が登録する。
 */
export interface PocketPageHost {
  /**
   * 項目を紙面へ置く。置いたら true、置かない (本文のキャレットへ貼る) なら false。
   * `point` が null のときは置き場所の指定が無い挿入 (クリック) で、紙面が見えている範囲の
   * 中央など、置き場所を自分で決める。
   */
  placeOnPage(item: PocketItem, point: PocketPagePoint | null): boolean;
  /**
   * 落とされた位置へキャレットを置く直前に呼ぶ。そこをクリックしたのと同じく、編集面が持っている
   * 古い選択 (複数のブロックにまたがる範囲など) を解いておく。残っていると、貼り付けは
   * 落とした位置ではなく、その選択を置き換える形で入ってしまう。
   */
  beforePlaceCaret?(): void;
  /**
   * いま選ばれているもの (文章の範囲・図形) の、画面での位置。ポケットへ入れたとき、その部分が
   * ポケットへ飛んでいく動きの出発点になる。選択の位置が分からないときは null (動きは出さない)。
   */
  getSelectionRect?(): PocketScreenRect | null;
}

export function beginPocketDrag(dataTransfer: DataTransfer, id: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(POCKET_DRAG_MIME, id);
}

/** ドラッグ中 (dragover) は中身を読めないので、種類の一覧だけで見分ける。 */
export function isPocketDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(POCKET_DRAG_MIME));
}

/** ドロップされた項目の ID。ポケットのドラッグでなければ null。 */
export function readPocketDragItemId(dataTransfer: DataTransfer): string | null {
  const id = dataTransfer.getData(POCKET_DRAG_MIME);
  return id ? id : null;
}

let pageHost: PocketPageHost | null = null;

/** 紙面への配置の窓口を登録する。戻り値で解除する (別の登録に置き換わっていれば何もしない)。 */
export function registerPocketPageHost(host: PocketPageHost): () => void {
  pageHost = host;
  return () => {
    if (pageHost === host) {
      pageHost = null;
    }
  };
}

export function getPocketPageHost(): PocketPageHost | null {
  return pageHost;
}
