import type { GraphParameter } from "./model/graph-parameter";

export function isGraphParameter(value: unknown): value is GraphParameter {
  return isRecord(value) &&
    isNonemptyString(value.id) &&
    isNonemptyString(value.name) &&
    isOptionalString(value.label) &&
    isFiniteNumber(value.value) &&
    isFiniteNumber(value.min) &&
    isFiniteNumber(value.max) &&
    (value.animation === undefined || (
      isRecord(value.animation) &&
      isFiniteNumber(value.animation.durationMs) &&
      value.animation.durationMs > 0 &&
      (value.animation.loop === "once" || value.animation.loop === "repeat" || value.animation.loop === "pingPong") &&
      (value.animation.playOnPage === undefined || typeof value.animation.playOnPage === "boolean")
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonemptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isOptionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
