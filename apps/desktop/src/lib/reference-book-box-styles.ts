import {
  DEFAULT_BODY_FONT_FAMILY,
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  type BoxFrameSpec,
  type InlineNode,
} from "@/features/document";

/**
 * 参考書・入試の紙面に合わせた組み込みの箱 (青・赤チャート型、Focus Gold 型、共通テスト型)。
 * 公式テンプレート (`lib/official-templates`) もこの枠で組むので、テンプレートの見出しと
 * `/` や箱の設定から挿した箱は同じ見た目になる。
 *
 * 書体は紙面に近いものを OS の書体から選び、無ければ同梱の書体へ落とす。Mac ではヒラギノ、
 * Windows では游書体、どちらにも無ければ Noto Serif JP / M PLUS 1p (同梱) で描く。
 */

/** 本文の明朝 (リュウミン系の紙面に近い順)。 */
export const BOOK_MINCHO_FONT_FAMILY =
  '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, "BIZ UDPMincho", "Noto Serif JP", serif';
/** 見出し・札のゴシック (新ゴ・中ゴシック系の紙面に近い順)。太字はヒラギノ角ゴの W6 になる。 */
export const BOOK_GOTHIC_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, "BIZ UDPGothic", "M PLUS 1p", sans-serif';
/** 例題番号の欧文数字 (太いグロテスク)。 */
export const BOOK_NUMERAL_FONT_FAMILY =
  '"Helvetica Neue", Helvetica, Arial, "M PLUS 1p", sans-serif';
/** CHART・Focus・Focus Gold の番号などの欧文セリフ。 */
export const BOOK_LATIN_SERIF_FONT_FAMILY =
  '"Times New Roman", Times, "STIX Two Math", "Noto Serif JP", serif';
/** 参考書・共通テストの数式は Times 系のイタリック (東大型は TeX の既定のまま)。 */
export const BOOK_MATH_FONT_FAMILY = '"Times New Roman", Times, "STIX Two Math", serif';

/** 同梱の既定書体 (ここに無い書体は端末によって無いことがある)。 */
export const BUNDLED_GOTHIC_FONT_FAMILY = DEFAULT_BODY_FONT_FAMILY;
export const BUNDLED_MINCHO_FONT_FAMILY = DEFAULT_SERIF_BODY_FONT_FAMILY;

export interface ReferenceBookBoxStyle {
  id: string;
  commandName: string;
  displayName: string;
  frame: BoxFrameSpec;
  /** 新しく挿した箱のタイトル。`heading` は辞書の既定の題 (作成時の言語)。 */
  defaultTitle(heading: string): InlineNode[];
  /** 新しく挿した箱の左の札 (`titleSplit` の欄)。`label` は辞書の既定の札。 */
  defaultSubtitle?(label: string): InlineNode[];
}

const run = (text: string, style: { font: string; bold?: boolean; size?: number; color?: string }): InlineNode => ({
  type: "text",
  text,
  ...(style.bold ? { marks: ["bold" as const] } : {}),
  ...(style.color ? { color: style.color } : {}),
  fontFamily: style.font,
  ...(style.size ? { fontSize: style.size } : {}),
});

/**
 * 難易度の印 (★・ⓘ・＊) の書体。先頭の `SigmaMarks` は実在しない名前で、描くのは後ろの書体。
 * 見出しを「両端」に揃えた箱は、この名前の run の塊を帯の右端へ寄せる (`document-surface.css`)。
 * 点いた印と消えた印を色分けして 2 つの run にしても、離れずに右端へ並ぶ。
 */
export const BOOK_MARKS_FONT_FAMILY =
  '"SigmaMarks", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, "Noto Sans Symbols", "M PLUS 1p", sans-serif';

/** 難易度の印。点いた分と消えた分を色 (と字形) で分ける。 */
export function difficultyMarks(
  level: number,
  max: number,
  marks: { on: string; off?: string; color: string; offColor: string; size: number },
): InlineNode[] {
  const on = Math.max(0, Math.min(max, level));
  return [
    ...(on > 0 ? [run(marks.on.repeat(on), { font: BOOK_MARKS_FONT_FAMILY, size: marks.size, color: marks.color })] : []),
    ...(max - on > 0 ? [run((marks.off ?? marks.on).repeat(max - on), { font: BOOK_MARKS_FONT_FAMILY, size: marks.size, color: marks.offColor })] : []),
  ];
}

// ---------------------------------------------------------------- 赤チャート型

const CHART_RED_LEVELS = {
  "chart-red-rei": { label: "#747cb4", band: "linear-gradient(90deg, #c4c8dc, #dcdcec)", frame: "#7c809c", shadow: "#c8cad8", star: "#4b5096", starOff: "#8e91b8", share: 0.075, level: 1 },
  "chart-red-reidai": { label: "#d06858", band: "linear-gradient(90deg, #e8c0bc, #f0d8d4)", frame: "#9c8884", shadow: "#dcc6c2", star: "#c0504a", starOff: "#c98d86", share: 0.13, level: 3 },
  "chart-red-juyo": { label: "#842c2c", band: "linear-gradient(90deg, #c8a8ac, #dccccc)", frame: "#988488", shadow: "#d2c2c4", star: "#842c2c", starOff: "#a98a8c", share: 0.2, level: 4 },
} as const;

export type ChartRedLevel = keyof typeof CHART_RED_LEVELS;

export function chartRedExampleFrame(level: ChartRedLevel): BoxFrameSpec {
  const spec = CHART_RED_LEVELS[level];
  return {
    borderWidthPx: 1,
    borderColor: spec.frame,
    borderStyle: "solid",
    backgroundColor: "#ffffff",
    titleBackgroundColor: spec.band,
    titleAlign: "justify",
    titleFontWeight: "bold",
    titleFontFamily: BOOK_GOTHIC_FONT_FAMILY,
    bodyFontFamily: BOOK_MINCHO_FONT_FAMILY,
    cornerStyle: "sharp",
    paddingPx: { top: 22, right: 10, bottom: 7, left: 10 },
    decorations: [
      { type: "titleBand", heightPx: 22, backgroundColor: spec.band },
      {
        type: "titleSplit",
        subtitleShare: spec.share,
        gapPx: 0,
        order: "subtitleFirst",
        subtitleBackgroundColor: spec.label,
        subtitleColor: "#ffffff",
        subtitleAlign: "c",
      },
      { type: "shadow", offsetXPx: 1.5, offsetYPx: 1.5, blurPx: 0, spreadPx: 0, color: spec.shadow },
    ],
  };
}

/** 赤チャート型の見出し: 太いグロテスクの番号 │ ゴシックの題 …… 右端に★。 */
export function chartRedExampleTitle(level: ChartRedLevel, number: string, heading: string, stars: number): InlineNode[] {
  const spec = CHART_RED_LEVELS[level];
  return [
    run(number, { font: BOOK_NUMERAL_FONT_FAMILY, bold: true, size: 13 }),
    run(" │ ", { font: BOOK_GOTHIC_FONT_FAMILY, size: 9, color: "#7a7a7a" }),
    run(heading, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 9.5 }),
    ...difficultyMarks(stars, 5, { on: "★", off: "☆", color: spec.star, offColor: spec.starOff, size: 8.5 }),
  ];
}

export function chartRedExampleLabel(label: string): InlineNode[] {
  return [run(label, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 10, color: "#ffffff" })];
}

// ---------------------------------------------------------------- 青チャート型

export const CHART_BLUE_COLORS = {
  red: "#e62312",
  frame: "#ec6460",
  band: "#f9d2bb",
  guideFill: "#fdf0e8",
  emphasis: "#e8392b",
  markOn: "#e84034",
  markOff: "#bdb8b8",
} as const;

export function chartBlueExampleFrame(): BoxFrameSpec {
  return {
    borderWidthPx: 1.3,
    borderColor: CHART_BLUE_COLORS.frame,
    borderStyle: "solid",
    backgroundColor: "#ffffff",
    titleBackgroundColor: CHART_BLUE_COLORS.band,
    titleAlign: "justify",
    titleFontWeight: "bold",
    titleFontFamily: BOOK_GOTHIC_FONT_FAMILY,
    bodyFontFamily: BOOK_MINCHO_FONT_FAMILY,
    cornerStyle: "sharp",
    paddingPx: { top: 22, right: 10, bottom: 6, left: 10 },
    decorations: [
      { type: "titleBand", heightPx: 22, backgroundColor: CHART_BLUE_COLORS.band, ruleWidthPx: 1.3, ruleColor: CHART_BLUE_COLORS.frame },
      {
        type: "titleSplit",
        subtitleShare: 0.2,
        gapPx: 0,
        order: "subtitleFirst",
        subtitleBackgroundColor: CHART_BLUE_COLORS.red,
        subtitleColor: "#ffffff",
        subtitleAlign: "c",
      },
    ],
  };
}

/** 青チャート型の見出し: 番号と題 …… 右端に難易度の丸 (点いた分が赤)。 */
export function chartBlueExampleTitle(number: string, heading: string, level: number): InlineNode[] {
  return [
    run(number, { font: BOOK_NUMERAL_FONT_FAMILY, bold: true, size: 13 }),
    run("　", { font: BOOK_GOTHIC_FONT_FAMILY, size: 9 }),
    run(heading, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 9.5 }),
    ...difficultyMarks(level, 5, { on: "ⓘ", color: CHART_BLUE_COLORS.markOn, offColor: CHART_BLUE_COLORS.markOff, size: 9 }),
  ];
}

/** 「基本例題」は「基本」を大きく「例題」を小さく組む。 */
export function chartBlueExampleLabel(label: string): InlineNode[] {
  const head = label.slice(0, 2);
  const tail = label.slice(2);
  return [
    run(head, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 11, color: "#ffffff" }),
    ...(tail ? [run(tail, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 7, color: "#ffffff" })] : []),
  ];
}

// ---------------------------------------------------------------- Focus Gold 型

export const FOCUS_GOLD_COLORS = {
  ink: "#2c2828",
  cyan: "#00bcf0",
  pinkFill: "#fdf2f6",
  pinkMark: "#f8cce0",
  rule: "#6b6767",
  markOff: "#b9b6b8",
} as const;

export function focusGoldExampleFrame(): BoxFrameSpec {
  return {
    borderWidthPx: 1.6,
    borderColor: FOCUS_GOLD_COLORS.ink,
    borderStyle: "solid",
    backgroundColor: "#ffffff",
    titleBackgroundColor: "#ffffff",
    titleAlign: "justify",
    titleFontWeight: "bold",
    titleFontFamily: BOOK_GOTHIC_FONT_FAMILY,
    bodyFontFamily: BOOK_MINCHO_FONT_FAMILY,
    cornerStyle: "round",
    radiusPx: 6,
    paddingPx: { top: 22, right: 12, bottom: 8, left: 14 },
    decorations: [
      { type: "titleBand", heightPx: 22, backgroundColor: "#ffffff", ruleWidthPx: 0.6, ruleColor: FOCUS_GOLD_COLORS.rule },
      {
        type: "titleSplit",
        subtitleShare: 0.22,
        gapPx: 0,
        order: "subtitleFirst",
        subtitleBackgroundColor: FOCUS_GOLD_COLORS.ink,
        subtitleColor: "#ffffff",
        subtitleAlign: "l",
      },
    ],
  };
}

/** Focus Gold 型の見出し: ゴシックの題 …… 右端に＊の難易度 (4段階)。 */
export function focusGoldExampleTitle(heading: string, level: number): InlineNode[] {
  return [
    run(heading, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 10.5 }),
    ...difficultyMarks(level, 4, { on: "＊", color: FOCUS_GOLD_COLORS.ink, offColor: FOCUS_GOLD_COLORS.markOff, size: 9 }),
  ];
}

/** 黒い札: 「例 題」はゴシック、番号は欧文セリフで大きく。 */
export function focusGoldExampleLabel(label: string, number: string): InlineNode[] {
  return [
    run(label, { font: BOOK_GOTHIC_FONT_FAMILY, bold: true, size: 9, color: "#ffffff" }),
    run(`　${number}`, { font: BOOK_LATIN_SERIF_FONT_FAMILY, size: 15, color: "#ffffff" }),
  ];
}

export function focusGoldFocusFrame(): BoxFrameSpec {
  return {
    borderWidthPx: 1,
    borderColor: FOCUS_GOLD_COLORS.rule,
    borderStyle: "solid",
    backgroundColor: "#ffffff",
    titleBackgroundColor: FOCUS_GOLD_COLORS.ink,
    titleColor: "#ffffff",
    titleAlign: "left",
    titleFontWeight: "bold",
    titleFontFamily: BOOK_LATIN_SERIF_FONT_FAMILY,
    bodyFontFamily: BOOK_GOTHIC_FONT_FAMILY,
    cornerStyle: "round",
    radiusPx: 5,
    paddingPx: { top: 8, right: 14, bottom: 10, left: 14 },
    decorations: [{ type: "titleTab", heightPx: 22, radiusPx: 6, offsetXPx: 0, paddingPx: { top: 0, right: 12, bottom: 0, left: 10 } }],
  };
}

export function focusGoldFocusTitle(label: string): InlineNode[] {
  return [run(label, { font: BOOK_LATIN_SERIF_FONT_FAMILY, bold: true, size: 11.5, color: "#ffffff" })];
}

// ---------------------------------------------------------------- 共通テスト型

export function kyotsuChoicesFrame(): BoxFrameSpec {
  return {
    titleVisible: false,
    borderWidthPx: 0.8,
    borderColor: "#5a5a5a",
    borderStyle: "solid",
    backgroundColor: "#ffffff",
    bodyFontFamily: BOOK_MINCHO_FONT_FAMILY,
    cornerStyle: "sharp",
    paddingPx: { top: 6, right: 14, bottom: 6, left: 14 },
  };
}

/** 組み込みの箱として並べる順。`BUILTIN_BOX_STYLES` の末尾に足す。 */
export const REFERENCE_BOOK_BOX_STYLES: readonly ReferenceBookBoxStyle[] = [
  ...(Object.keys(CHART_RED_LEVELS) as ChartRedLevel[]).map((level): ReferenceBookBoxStyle => ({
    id: level,
    commandName: level,
    displayName: level,
    frame: chartRedExampleFrame(level),
    defaultTitle: (heading) => chartRedExampleTitle(level, "1", heading, CHART_RED_LEVELS[level].level),
    defaultSubtitle: chartRedExampleLabel,
  })),
  {
    id: "chart-blue-kihon",
    commandName: "chart-blue-kihon",
    displayName: "chart-blue-kihon",
    frame: chartBlueExampleFrame(),
    defaultTitle: (heading) => chartBlueExampleTitle("1", heading, 2),
    defaultSubtitle: chartBlueExampleLabel,
  },
  {
    id: "focus-gold-reidai",
    commandName: "focus-gold-reidai",
    displayName: "focus-gold-reidai",
    frame: focusGoldExampleFrame(),
    defaultTitle: (heading) => focusGoldExampleTitle(heading, 1),
    defaultSubtitle: (label) => focusGoldExampleLabel(label, "1"),
  },
  {
    id: "focus-gold-focus",
    commandName: "focus-gold-focus",
    displayName: "focus-gold-focus",
    frame: focusGoldFocusFrame(),
    defaultTitle: focusGoldFocusTitle,
  },
  {
    id: "kyotsu-choices",
    commandName: "kyotsu-choices",
    displayName: "kyotsu-choices",
    frame: kyotsuChoicesFrame(),
    defaultTitle: () => [],
  },
];
