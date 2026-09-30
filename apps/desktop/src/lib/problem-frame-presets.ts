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
