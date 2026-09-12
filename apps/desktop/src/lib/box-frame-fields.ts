import type { BoxDecorationSpec, BoxFrameSpec } from "@/features/document";

/**
 * 箱の見た目で決められるものの**一覧**。設定ダイアログはこの配列を描くだけにする。
 *
 * 一覧をデータで持つ理由は 2 つ。装飾 (`decorations`) を 1 つ足すたびにダイアログへ手で行を
 * 足す作りだと、足し忘れた装飾は「保存形式にはあるのに誰も変えられない色」になる。もう 1 つは、
 * 装飾の色が**配列の中**に居ることで、書き換えが `{ decorations: [...] }` の作り直しになるため
 * ——その手順をここに 1 つだけ持てば、画面側は patch をそのまま渡すだけで済む。
 *
 * `id` は i18n キー (`settings` namespace の `box.field.<id>`) と e2e の目印を兼ねる。**表示順**も
 * この配列の順で、グループごとにまとめて描く。
 */

export type BoxFrameFieldGroup = "surface" | "border" | "title" | "body" | "decoration";

interface BoxFrameFieldBase {
  id: string;
  group: BoxFrameFieldGroup;
}

export interface BoxFrameColorField extends BoxFrameFieldBase {
  kind: "color";
  value: string;
  patch: (color: string) => Partial<BoxFrameSpec>;
}

export interface BoxFrameLengthField extends BoxFrameFieldBase {
  kind: "length";
  value: number;
  min: number;
  max: number;
  step: number;
  patch: (value: number) => Partial<BoxFrameSpec>;
}

export interface BoxFrameChoiceField extends BoxFrameFieldBase {
  kind: "choice";
  value: string;
  options: readonly string[];
  patch: (value: string) => Partial<BoxFrameSpec>;
}

export type BoxFrameField = BoxFrameColorField | BoxFrameLengthField | BoxFrameChoiceField;

/** 色が決まっていないときにピッカーへ見せる色。CSS 側の既定 (`inherit` = 本文の色) に合わせる。 */
const DEFAULT_INK = "#111111";
const DEFAULT_SURFACE = "#ffffff";

export const BOX_FRAME_BORDER_STYLES = ["solid", "dashed", "dotted", "double", "none"] as const;
export const BOX_FRAME_TITLE_WEIGHTS = ["normal", "bold"] as const;

/**
 * いまの枠仕様で決められる項目。**解決済みの枠** (`resolveBoxFrame`) を渡すこと — スタイル既定を
 * 含んでいないと、そのスタイルが持つ装飾の行がまるごと出てこない。
 */
export function boxFrameFields(frame: BoxFrameSpec): BoxFrameField[] {
  const fields: BoxFrameField[] = [
    {
      kind: "color",
      id: "backgroundColor",
      group: "surface",
      value: frame.backgroundColor ?? DEFAULT_SURFACE,
      patch: (backgroundColor) => ({ backgroundColor }),
    },
    {
      kind: "color",
      id: "borderColor",
      group: "border",
      value: frame.borderColor ?? DEFAULT_INK,
      patch: (borderColor) => ({ borderColor }),
    },
    {
      kind: "choice",
      id: "borderStyle",
      group: "border",
      value: frame.borderStyle ?? "solid",
      options: BOX_FRAME_BORDER_STYLES,
      patch: (value) => ({ borderStyle: normalizeBorderStyle(value) }),
    },
    {
      kind: "color",
      id: "titleColor",
      group: "title",
      value: frame.titleColor ?? DEFAULT_INK,
      patch: (titleColor) => ({ titleColor }),
    },
    {
      kind: "choice",
      id: "titleFontWeight",
      group: "title",
      value: frame.titleFontWeight ?? "bold",
      options: BOX_FRAME_TITLE_WEIGHTS,
      patch: (value) => ({ titleFontWeight: value === "normal" ? "normal" : "bold" }),
    },
    {
      kind: "color",
      id: "bodyColor",
      group: "body",
      value: frame.bodyColor ?? DEFAULT_INK,
      patch: (bodyColor) => ({ bodyColor }),
    },
  ];

  const band = findDecoration(frame, "titleBand");
  const tab = findDecoration(frame, "titleTab");
  const plate = findDecoration(frame, "titlePlate");

  // タイトルの地色は装飾ごとの色より枠の値が優先される (`boxFrameStyleVars`)。地の付く装飾を
  // 持つスタイルでだけ出し、書き込みは枠の 1 フィールドへ寄せる。
  if (band || tab) {
    fields.push({
      kind: "color",
      id: "titleBackgroundColor",
      group: "title",
      value: frame.titleBackgroundColor
        ?? band?.backgroundColor
        ?? tab?.backgroundColor
        ?? frame.backgroundColor
        ?? DEFAULT_SURFACE,
      patch: (titleBackgroundColor) => ({ titleBackgroundColor }),
    });
  }

  if (band) {
    fields.push(
      {
        kind: "length",
        id: "titleBand.heightPx",
        group: "decoration",
        value: band.heightPx ?? 32,
        min: 16,
        max: 96,
        step: 1,
        patch: (heightPx) => patchDecoration(frame, "titleBand", { heightPx }),
      },
      {
        kind: "length",
        id: "titleBand.ruleWidthPx",
        group: "decoration",
        value: band.ruleWidthPx ?? 0,
        min: 0,
        max: 6,
        step: 0.2,
        patch: (ruleWidthPx) => patchDecoration(frame, "titleBand", { ruleWidthPx }),
      },
      {
        kind: "color",
        id: "titleBand.ruleColor",
        group: "decoration",
        value: band.ruleColor ?? frame.borderColor ?? DEFAULT_INK,
        patch: (ruleColor) => patchDecoration(frame, "titleBand", { ruleColor }),
      },
    );
  }

  if (tab) {
    fields.push(
      {
        kind: "length",
        id: "titleTab.heightPx",
        group: "decoration",
        value: tab.heightPx ?? 26,
        min: 16,
        max: 72,
        step: 1,
        patch: (heightPx) => patchDecoration(frame, "titleTab", { heightPx }),
      },
      {
        kind: "length",
        id: "titleTab.radiusPx",
        group: "decoration",
        value: tab.radiusPx ?? 4,
        min: 0,
        max: 24,
        step: 1,
        patch: (radiusPx) => patchDecoration(frame, "titleTab", { radiusPx }),
      },
      {
        kind: "length",
        id: "titleTab.offsetXPx",
        group: "decoration",
        value: tab.offsetXPx ?? 0,
        min: 0,
        max: 120,
        step: 1,
        patch: (offsetXPx) => patchDecoration(frame, "titleTab", { offsetXPx }),
      },
    );
  }

  if (plate) {
    fields.push(
      {
        kind: "color",
        id: "titlePlate.borderColor",
        group: "decoration",
        value: plate.borderColor ?? frame.borderColor ?? DEFAULT_INK,
        patch: (borderColor) => patchDecoration(frame, "titlePlate", { borderColor }),
      },
      {
        kind: "length",
        id: "titlePlate.radiusPx",
        group: "decoration",
        value: plate.radiusPx ?? 3,
        min: 0,
        max: 24,
        step: 1,
        patch: (radiusPx) => patchDecoration(frame, "titlePlate", { radiusPx }),
      },
    );
  }

  const leftBar = findDecoration(frame, "leftBar");
  if (leftBar) {
    fields.push(
      {
        kind: "length",
        id: "leftBar.widthPx",
        group: "decoration",
        value: leftBar.widthPx,
        min: 1,
        max: 24,
        step: 0.5,
        patch: (widthPx) => patchDecoration(frame, "leftBar", { widthPx }),
      },
      {
        kind: "color",
        id: "leftBar.color",
        group: "decoration",
        value: leftBar.color,
        patch: (color) => patchDecoration(frame, "leftBar", { color }),
      },
    );
  }

  const doubleRule = findDecoration(frame, "doubleRule");
  if (doubleRule) {
    fields.push(
      {
        kind: "length",
        id: "doubleRule.offsetPx",
        group: "decoration",
        value: doubleRule.offsetPx,
        min: 0,
        max: 16,
        step: 0.5,
        patch: (offsetPx) => patchDecoration(frame, "doubleRule", { offsetPx }),
      },
      {
        kind: "length",
        id: "doubleRule.widthPx",
        group: "decoration",
        value: doubleRule.widthPx ?? 1,
        min: 0.2,
        max: 6,
        step: 0.2,
        patch: (widthPx) => patchDecoration(frame, "doubleRule", { widthPx }),
      },
      {
        kind: "color",
        id: "doubleRule.color",
        group: "decoration",
        value: doubleRule.color ?? frame.borderColor ?? DEFAULT_INK,
        patch: (color) => patchDecoration(frame, "doubleRule", { color }),
      },
    );
  }

  const cornerSquares = findDecoration(frame, "cornerSquares");
  if (cornerSquares) {
    fields.push(
      {
        kind: "length",
        id: "cornerSquares.sizePx",
        group: "decoration",
        value: cornerSquares.sizePx,
        min: 2,
        max: 32,
        step: 1,
        patch: (sizePx) => patchDecoration(frame, "cornerSquares", { sizePx }),
      },
      {
        kind: "color",
        id: "cornerSquares.color",
        group: "decoration",
        value: cornerSquares.color,
        patch: (color) => patchDecoration(frame, "cornerSquares", { color }),
      },
    );
  }

  const titleDoubleRule = findDecoration(frame, "titleDoubleRule");
  if (titleDoubleRule) {
    fields.push(
      {
        kind: "length",
        id: "titleDoubleRule.ruleWidthPx",
        group: "decoration",
        value: titleDoubleRule.ruleWidthPx ?? 1,
        min: 0.2,
        max: 6,
        step: 0.2,
        patch: (ruleWidthPx) => patchDecoration(frame, "titleDoubleRule", { ruleWidthPx }),
      },
      {
        kind: "color",
        id: "titleDoubleRule.ruleColor",
        group: "decoration",
        value: titleDoubleRule.ruleColor ?? DEFAULT_INK,
        patch: (ruleColor) => patchDecoration(frame, "titleDoubleRule", { ruleColor }),
      },
      {
        kind: "color",
        id: "titleDoubleRule.guideColor",
        group: "decoration",
        value: titleDoubleRule.guideColor ?? "#b8b8b8",
        patch: (guideColor) => patchDecoration(frame, "titleDoubleRule", { guideColor }),
      },
    );
  }

  const horizontalRules = findDecoration(frame, "horizontalRules");
  if (horizontalRules) {
    fields.push(
      {
        kind: "length",
        id: "horizontalRules.widthPx",
        group: "decoration",
        value: horizontalRules.widthPx ?? 1,
        min: 0.2,
        max: 8,
        step: 0.2,
        patch: (widthPx) => patchDecoration(frame, "horizontalRules", { widthPx }),
      },
      {
        kind: "color",
        id: "horizontalRules.color",
        group: "decoration",
        value: horizontalRules.color ?? frame.borderColor ?? DEFAULT_INK,
        patch: (color) => patchDecoration(frame, "horizontalRules", { color }),
      },
    );
  }

  const shadow = findDecoration(frame, "shadow");
  if (shadow) {
    fields.push(
      {
        kind: "length",
        id: "shadow.offsetYPx",
        group: "decoration",
        value: shadow.offsetYPx,
        min: 0,
        max: 24,
        step: 1,
        patch: (offsetYPx) => patchDecoration(frame, "shadow", { offsetYPx }),
      },
      {
        kind: "length",
        id: "shadow.blurPx",
        group: "decoration",
        value: shadow.blurPx ?? 0,
        min: 0,
        max: 48,
        step: 1,
        patch: (blurPx) => patchDecoration(frame, "shadow", { blurPx }),
      },
      {
        kind: "color",
        id: "shadow.color",
        group: "decoration",
        value: shadow.color,
        patch: (color) => patchDecoration(frame, "shadow", { color }),
      },
    );
  }

  const notebook = findDecoration(frame, "notebookRules");
  if (notebook) {
    fields.push(
      {
        kind: "color",
        id: "notebookRules.bindingColor",
        group: "decoration",
        value: notebook.bindingColor ?? "#b9b3a1",
        patch: (bindingColor) => patchDecoration(frame, "notebookRules", { bindingColor }),
      },
      {
        kind: "color",
        id: "notebookRules.ringColor",
        group: "decoration",
        value: notebook.ringColor ?? "#706b5a",
        patch: (ringColor) => patchDecoration(frame, "notebookRules", { ringColor }),
      },
    );
  }

  return fields;
}

/**
 * 装飾 1 つを書き換える。**配列ごと**返すのが肝で、枠の合成 (`mergeBoxFrame`) は `decorations` を
 * 丸ごと差し替える約束のため、一部だけ返すと他の装飾が消える。
 */
function patchDecoration<T extends BoxDecorationSpec["type"]>(
  frame: BoxFrameSpec,
  type: T,
  patch: Partial<Extract<BoxDecorationSpec, { type: T }>>,
): Partial<BoxFrameSpec> {
  return {
    decorations: (frame.decorations ?? []).map((decoration) => (
      decoration.type === type ? { ...decoration, ...patch } : decoration
    )),
  };
}

function findDecoration<T extends BoxDecorationSpec["type"]>(
  frame: BoxFrameSpec,
  type: T,
): Extract<BoxDecorationSpec, { type: T }> | undefined {
  return frame.decorations?.find(
    (decoration): decoration is Extract<BoxDecorationSpec, { type: T }> => decoration.type === type,
  );
}

function normalizeBorderStyle(value: string): NonNullable<BoxFrameSpec["borderStyle"]> {
  return (BOX_FRAME_BORDER_STYLES as readonly string[]).includes(value)
    ? value as NonNullable<BoxFrameSpec["borderStyle"]>
    : "solid";
}
