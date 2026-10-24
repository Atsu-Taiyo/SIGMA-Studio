import { isSafeCssFontFamily } from "./css-safety";
import type { ProblemAreaLayout, ProblemFrame, ProblemNumbering } from "./model/blocks";

type LayoutStyle = Record<string, string>;
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** CSS variables are shared by the page editor, nested areas and static previews. */
export function getProblemNumberLayoutStyle(numbering: ProblemNumbering | undefined): LayoutStyle {
  const style: LayoutStyle = {};
  if (!numbering) return style;
  if (isSafeCssFontFamily(numbering.fontFamily)) style["--problem-number-font-family"] = numbering.fontFamily;
  if (finite(numbering.fontWeight, 100, 900) && Number.isInteger(numbering.fontWeight)) style["--problem-number-font-weight"] = String(numbering.fontWeight);
  for (const [key, name, min, max] of [
    ["widthPx", "width", 0.01, 256], ["heightPx", "height", 0.01, 256],
    ["gapPx", "gap", 0, 256], ["borderWidthPx", "border-width", 0, 24],
    ["borderRadiusPx", "border-radius", 0, 128], ["offsetXPx", "offset-x", -256, 256],
    ["offsetYPx", "offset-y", -256, 256],
    ["outlineWidthPx", "outline-width", 0, 24], ["outlineOffsetPx", "outline-offset", 0, 128],
    ["textOffsetXPx", "text-offset-x", -128, 128], ["textOffsetYPx", "text-offset-y", -128, 128],
  ] as const) if (finite(numbering[key], min, max)) style[`--problem-number-${name}`] = `${numbering[key]}px`;
  if (style["--problem-number-width"]) style["--problem-number-padding-x"] = "0px";
  if (["solid", "double", "none"].includes(numbering.borderStyle ?? "")) style["--problem-number-border-style"] = numbering.borderStyle!;
  return style;
}

export function getProblemAreaLayoutStyle(layout: ProblemAreaLayout | undefined, baseLeft: string | number = 0): LayoutStyle {
  const style: LayoutStyle = {};
  if (!layout) return style;
  if (layout.paddingPx) for (const side of ["top", "right", "bottom", "left"] as const) {
    if (finite(layout.paddingPx[side], 0, 256)) style[`padding${side[0].toUpperCase()}${side.slice(1)}`] = `${layout.paddingPx[side]}px`;
  }
  for (const key of ["marginTopPx", "marginBottomPx"] as const) {
    if (finite(layout[key], 0, 400)) style[key === "marginTopPx" ? "marginTop" : "marginBottom"] = `${layout[key]}px`;
  }
  if (finite(layout.widthMm, 0.01, 1000)) {
    style.width = `min(${layout.widthMm}mm, 100%)`;
  }
  if (finite(layout.offsetXPx, -256, 256)) {
    const base = typeof baseLeft === "number" ? `${baseLeft}px` : baseLeft;
    style.left = `calc(${base} + ${layout.offsetXPx}px)`;
  }
  return style;
}

export function getProblemFrameLayoutStyle(frame: ProblemFrame | undefined): LayoutStyle {
  const style: LayoutStyle = {};
  if (finite(frame?.borderWidthPx, 0, 24)) {
    style["--problem-frame-border-width"] = `${frame.borderWidthPx}px`;
    style["--custom-frame-border"] = `${frame.borderWidthPx}px`;
  }
  if (finite(frame?.borderRadiusPx, 0, 128)) style["--problem-frame-border-radius"] = `${frame.borderRadiusPx}px`;
  return style;
}

export function formatProblemNumberLabel(value: number, numbering?: ProblemNumbering): string {
  const text = String(value);
  return numbering?.format === "fullwidth" ? text.replace(/\d/g, digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)) : text;
}
