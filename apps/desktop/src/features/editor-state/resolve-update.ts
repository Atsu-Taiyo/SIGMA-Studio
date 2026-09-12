import type { EditorStateUpdate } from "./types";

/** `useState` のセッタと同じ規約で「値または更新関数」を解決する。 */
export function resolveEditorStateUpdate<T>(update: EditorStateUpdate<T>, current: T): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}
