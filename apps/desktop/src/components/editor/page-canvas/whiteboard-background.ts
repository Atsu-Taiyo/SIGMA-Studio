import { WHITEBOARD_BASE_CELL_PX, type PageBackground } from "@/features/document";

export { WHITEBOARD_BASE_CELL_PX };

/**
 * ホワイトボードの下地パターン。**純関数のみ・DOM 非依存**。
 *
 * CSS 側に置けない理由: 「間隔が一定より狭くなったら描かない」は倍率の関数だが、
 * `calc()` に条件分岐が無いので CSS 変数の算術では表現できない。25% まで縮めると
 * 間隔 6px に直径 2px の点が並んで砂嵐になるため、しきい値は必須。
 * ここへ持ち出すのはパターン (image / size / position) だけで、
 * 色・レイヤ構造・下地色は `.whiteboard-background` の CSS に残す。
 */

/**
 * この実効間隔以下では描かない (潰れて砂嵐になる)。
 *
 * 9px = 倍率 37.5%。醜いのは 25% (間隔 6px に直径 2px の点) であって、50% (12px) は
 * 全体を俯瞰する普通の作業倍率なので、そこで空間の手がかりを失わせない値にしている。
 */
export const WHITEBOARD_PATTERN_MIN_SPACING_PX = 9;

/** ここまで線形にフェードインし、以降は不透明 (15px = 倍率 62.5%)。 */
export const WHITEBOARD_PATTERN_FADE_SPACING_PX = 15;

/** 点の濃さ。線より濃いのは、点のほうが面積が小さく同じ濃度だと見えないため。 */
const DOT_ALPHA = 0.22;
const GRID_LINE_ALPHA = 0.16;

/** フェードは要素の opacity ではなくパターンのアルファに載せる (理由は下の patternImage)。 */
function ink(alpha: number, fade: number): string {
  return `rgba(85, 85, 85, ${Number((alpha * fade).toFixed(4))})`;
}

export interface WhiteboardBackgroundInput {
  background: PageBackground | undefined;
  /** 倍率 (%)。 */
  zoom: number;
  /** パン (画面px)。 */
  panX: number;
  panY: number;
}

export interface WhiteboardBackgroundStyle {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
}

/**
 * 点も線も **画面 px 固定** で描く。ワールド単位で描くと、拡大するほど点が太って
 * 「下地」ではなく「模様」になる。間隔だけが倍率に連動する。
 */
/**
 * 点も線も **画面 px 固定** で描く。ワールド単位で描くと、拡大するほど点が太って
 * 「下地」ではなく「模様」になる。間隔だけが倍率に連動する。
 *
 * しきい値付近のフェードは要素の `opacity` ではなくここのアルファに載せる。
 * `.whiteboard-background` は下地色 (`background-color`) の唯一の出典でもあるので、
 * 要素ごと薄くすると**下地の色まで一緒に消えて**キャンバスの地が透ける。
 */
function patternImage(background: Exclude<PageBackground, "none">, fade: number): string {
  if (background === "grid") {
    const line = ink(GRID_LINE_ALPHA, fade);
    return [
      `linear-gradient(to right, ${line} 0 1px, transparent 1px)`,
      `linear-gradient(to bottom, ${line} 0 1px, transparent 1px)`,
    ].join(", ");
  }

  return `radial-gradient(circle, ${ink(DOT_ALPHA, fade)} 0 1px, transparent 1.25px)`;
}

export function getWhiteboardBackgroundStyle({
  background,
  zoom,
  panX,
  panY,
}: WhiteboardBackgroundInput): WhiteboardBackgroundStyle | null {
  if (background !== "grid" && background !== "dots") {
    return null;
  }

  const spacing = WHITEBOARD_BASE_CELL_PX * (zoom / 100);
  if (!Number.isFinite(spacing)) {
    return null;
  }

  const fadeRange = WHITEBOARD_PATTERN_FADE_SPACING_PX - WHITEBOARD_PATTERN_MIN_SPACING_PX;
  const fade = Math.min(1, (spacing - WHITEBOARD_PATTERN_MIN_SPACING_PX) / fadeRange);
  if (fade <= 0) {
    // 完全に透明なパターンを敷いても意味がないので、そこは「描かない」に寄せる。
    return null;
  }

  return {
    backgroundImage: patternImage(background, fade),
    backgroundSize: `${spacing}px ${spacing}px`,
    backgroundPosition: `${panX}px ${panY}px`,
  };
}
