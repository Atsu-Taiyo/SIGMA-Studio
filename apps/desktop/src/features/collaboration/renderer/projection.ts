/** Keep unchanged immutable view values stable when projecting a new CRDT state.
 * PageCanvas uses these references to distinguish text edits from page/overlay
 * changes; recreating every object on a keystroke invalidates the whole layout.
 */
export function shareProjection<T>(previous: T | undefined, next: T): T {
  if (previous === next) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const values = next.map((value, index) => shareProjection(previous[index], value));
    return (previous.length === values.length && values.every((value, index) => value === previous[index])
      ? previous : values) as T;
  }
  if (previous !== null && next !== null && typeof previous === "object" && typeof next === "object"
    && previous !== undefined && !Array.isArray(previous) && !Array.isArray(next)) {
    const before = previous as Record<string, unknown>;
    const after = next as Record<string, unknown>;
    const keys = Object.keys(after);
    let equal = Object.keys(before).length === keys.length;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = shareProjection(before[key], after[key]);
      if (!Object.hasOwn(before, key) || result[key] !== before[key]) equal = false;
    }
    return (equal ? previous : result) as T;
  }
  return next;
}
