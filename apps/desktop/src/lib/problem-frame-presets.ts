import { normalizeFrameSvg } from "@/features/document/problem-custom-frame";

/**
 * Starting points for a hand-drawn problem frame. Each one is drawn on a 160 x 100 canvas whose
 * corners are the outer 24 x 24 units (the same contract the AI is given, see
 * `AI_FRAME_DRAWING`): ornaments stay inside the corners and the four edges are plain straight
 * lines, so they stretch to any problem size without distortion.
 */
const PRESET_SLICE = 24;

const RAW_PRESETS = [
  {
    id: "double-diamond",
    labelKey: "problem.custom.presets.doubleDiamond",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">
  <rect x="1.5" y="1.5" width="157" height="97" fill="none" stroke="#1f2937" stroke-width="3"/>
  <rect x="8" y="8" width="144" height="84" fill="none" stroke="#6b7280" stroke-width="1"/>
  <g fill="#1f2937">
    <path d="M13 6 20 13 13 20 6 13Z"/>
    <path d="M147 6 154 13 147 20 140 13Z"/>
    <path d="M13 80 20 87 13 94 6 87Z"/>
    <path d="M147 80 154 87 147 94 140 87Z"/>
  </g>
</svg>`,
  },
  {
    id: "soft-round",
    labelKey: "problem.custom.presets.softRound",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">
  <rect x="4" y="4" width="152" height="92" rx="16" fill="none" stroke="#bae6fd" stroke-width="7"/>
  <rect x="4" y="4" width="152" height="92" rx="16" fill="none" stroke="#0284c7" stroke-width="1.6"/>
</svg>`,
  },
  {
    id: "notched",
    labelKey: "problem.custom.presets.notched",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">
  <path d="M16 2H144L158 16V84L144 98H16L2 84V16Z" fill="none" stroke="#92400e" stroke-width="2.6" stroke-linejoin="miter"/>
  <path d="M20 8H140L152 20V80L140 92H20L8 80V20Z" fill="none" stroke="#d97706" stroke-width="1"/>
</svg>`,
  },
  // The notches are quarter circles centred on the drawing's corners. Their ends stop 1.5 units
  // short of the slice line so the stroke stays inside the corner piece instead of being
  // stretched along with the edge. The dotted rule is round dots in the corners, but along the
  // edges the piece is stretched, so there it is drawn as dashes short enough to still read as dots.
  {
    id: "scooped-dotted",
    labelKey: "problem.custom.presets.scoopedDotted",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">
  <path d="M22.5 1.5H137.5A21 21 0 0 0 158.5 22.5V77.5A21 21 0 0 0 137.5 98.5H22.5A21 21 0 0 0 1.5 77.5V22.5A21 21 0 0 0 22.5 1.5Z" fill="none" stroke="#111827" stroke-width="2.4"/>
  <g fill="none" stroke="#111827" stroke-width="1.8">
    <path d="M22.5 8.5H8.5V22.5M137.5 8.5H151.5V22.5M22.5 91.5H8.5V77.5M137.5 91.5H151.5V77.5" stroke-linecap="round" stroke-dasharray="0 7"/>
    <path d="M24 8.5H136M24 91.5H136M8.5 24V76M151.5 24V76" stroke-dasharray="0.35 0.65"/>
  </g>
</svg>`,
  },
] as const;

export const PROBLEM_FRAME_PRESETS = RAW_PRESETS.map((preset) => {
  const normalized = normalizeFrameSvg(preset.svg);
  if (!normalized.ok) {
    throw new Error(`Problem frame preset "${preset.id}" is not a valid frame drawing: ${normalized.reason}`);
  }
  return {
    id: preset.id,
    labelKey: preset.labelKey,
    drawing: { svg: normalized.svg, width: normalized.width, height: normalized.height },
    slice: PRESET_SLICE,
  };
});

export type ProblemFramePresetId = (typeof RAW_PRESETS)[number]["id"];
