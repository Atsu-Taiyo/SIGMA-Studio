import { alphaByteToPercent, formatHex6, formatHex8, parseHexColor, percentToAlphaByte } from "@/lib/color";
import { fillOpacityToPercent, percentToFillOpacity } from "@/lib/fill-opacity";

/**
 * 箱の色 1 つを「色 + 不透明度」として扱うための往復。
 *
 * 図形の塗りは `fillColor` と `fillOpacity` を別々に持つが、箱の枠は色を文字列 1 つで持つ
 * (装飾の中に散らばる色ごとに不透明度の欄を足すのは現実的でない)。そこで不透明度は
 * `#rrggbbaa` の 8 桁 16 進に載せ、パレットの不透明度スライダーとは
 * 「色は `#rrggbb`、不透明度は 0〜1」の形で受け渡す。不透明のときは `#rrggbb` のまま保存する。
 *
 * 16 進で書かれていない値 (`transparent` や色名) は分解できない (`null`)。
 */
export interface BoxColorParts {
  /** `#rrggbb` */
  color: string;
  /** 0〜1。省略された色は不透明。 */
  opacity: number;
}

export function splitBoxColor(value: string | undefined): BoxColorParts | null {
  const parsed = value ? parseHexColor(value) : null;
  if (!parsed) {
    return null;
  }
  return {
    color: formatHex6(parsed.rgb),
    opacity: parsed.hasAlpha ? percentToFillOpacity(alphaByteToPercent(parsed.alpha)) : 1,
  };
}

export function joinBoxColor(color: string, opacity: number): string {
  const parsed = parseHexColor(color);
  if (!parsed) {
    return color;
  }
  const percent = fillOpacityToPercent(opacity);
  return percent >= 100 ? formatHex6(parsed.rgb) : formatHex8(parsed.rgb, percentToAlphaByte(percent));
}
