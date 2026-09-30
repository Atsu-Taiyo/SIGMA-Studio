/** 選択バーのフォントサイズ候補 (pt)。よく使う値だけ。ほかは − / ＋ で 1 pt ずつ。 */
export const FONT_SIZE_PRESETS = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

const MIN_FONT_SIZE = 0.1;

/** 現在のサイズから 1 段 (±1pt) 動かした値。上部ツールバーの ± と同じ刻みと丸め。 */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const base = Number.isFinite(current) && current > 0 ? current : 12;
  return Math.max(MIN_FONT_SIZE, Math.round((base + direction) * 1000) / 1000);
}
