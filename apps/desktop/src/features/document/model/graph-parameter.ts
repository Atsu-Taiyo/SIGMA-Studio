export interface GraphParameter {
  id: string;
  /** Identifier referenced from expressions, for example `s` in `z = s`. */
  name: string;
  label?: string;
  value: number;
  min: number;
  max: number;
  animation?: GraphParameterAnimation;
}

/**
 * Playback runs the parameter across its own `min`..`max`, so the range is stated once — as the
 * inequality the card shows — and never as a second pair of start/end numbers that could disagree.
 */
export interface GraphParameterAnimation {
  /** One pass from `min` to `max`. A ping-pong's return leg takes the same time again. */
  durationMs: number;
  loop: "once" | "repeat" | "pingPong";
  /**
   * Keep this parameter moving on the page, not only while the settings panel previews it.
   * 3D materials also keep this motion in their derived animated PNG preview.
   */
  playOnPage?: boolean;
}
