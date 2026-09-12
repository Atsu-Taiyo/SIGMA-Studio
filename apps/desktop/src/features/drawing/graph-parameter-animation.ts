import type { GraphParameter } from "@/features/document";
import type { MathExpressionVariables } from "./math-expression";

export const DEFAULT_DURATION_MS = 4_000;

/**
 * Value of one animated parameter at `timeMs` from the start of playback.
 *
 * The sweep is always the parameter's own `min`..`max`: the range the card states as
 * `min ≦ name ≦ max` is the only place it is written down.
 */
export function graphParameterAnimationValueAt(parameter: GraphParameter, timeMs: number): number {
  const animation = parameter.animation;
  const span = parameter.max - parameter.min;
  const raw = Math.max(0, timeMs) / Math.max(1, animation?.durationMs ?? DEFAULT_DURATION_MS);
  if (animation?.loop === "once") return parameter.min + span * Math.min(1, raw);
  const cycle = Math.floor(raw);
  const fraction = raw - cycle;
  const progress = animation?.loop === "repeat" ? fraction : (cycle % 2 === 1 ? 1 - fraction : fraction);
  return parameter.min + span * progress;
}

/** How long one full pass takes before the picture is back where it started. */
export function graphParameterAnimationCycleMs(parameter: GraphParameter): number {
  const animation = parameter.animation;
  const durationMs = animation?.durationMs ?? DEFAULT_DURATION_MS;
  return animation?.loop === "pingPong" || animation?.loop === undefined ? durationMs * 2 : durationMs;
}

/** Shortest video worth writing to a file, and the longest one a worksheet figure justifies. */
const MIN_VIDEO_MS = 1_000;
const MAX_VIDEO_MS = 30_000;

function graphParameterSpans(parameter: GraphParameter): boolean {
  return Number.isFinite(parameter.min) && Number.isFinite(parameter.max) && parameter.max > parameter.min;
}

/**
 * Parameters an exported video animates.
 *
 * The page set wins when the author picked one, so the video shows what the worksheet shows.
 * With nothing marked there is no page animation to copy, and the author still pressed
 * “書き出す”: every parameter that spans a range then moves, each on the clock written in its
 * own card.
 */
export function graphVideoAnimationParameters(parameters: readonly GraphParameter[]): GraphParameter[] {
  const onPage = parameters.filter((parameter) => parameter.animation?.playOnPage === true).filter(graphParameterSpans);
  return onPage.length > 0 ? onPage : parameters.filter(graphParameterSpans);
}

/** One full pass of the slowest animated parameter. */
export function graphVideoDurationMs(parameters: readonly GraphParameter[]): number {
  if (parameters.length === 0) return 0;
  return clamp(Math.max(...parameters.map(graphParameterAnimationCycleMs)), MIN_VIDEO_MS, MAX_VIDEO_MS);
}

/** Every animated parameter read off its own clock at the same instant. */
export function graphParameterAnimationOverridesAt(
  parameters: readonly GraphParameter[],
  timeMs: number,
): MathExpressionVariables {
  const overrides: Record<string, number> = {};
  for (const parameter of parameters) {
    overrides[parameter.name] = graphParameterAnimationValueAt(parameter, timeMs);
  }
  return overrides;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
