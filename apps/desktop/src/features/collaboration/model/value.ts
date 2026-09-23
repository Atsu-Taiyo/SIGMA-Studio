/** JSON-only values cross the collaboration boundary; no UI or provider types. */
export type Value = null | boolean | number | string | Value[] | ObjectValue;
export interface ObjectValue {
  [key: string]: Value;
}

export function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || stableValue(a) === stableValue(b);
}

/** Save timestamps never participate in content equality or proposal preconditions. */
export function contentValue(value: Value): Value {
  if (
    !isObject(value) ||
    typeof value.docId !== "string" ||
    typeof value.version !== "string"
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "updatedAt"),
  );
}

export async function contentHash(value: Value): Promise<string> {
  const bytes = new TextEncoder().encode(stableValue(contentValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assertJsonValue(
  value: unknown,
  maxDepth = 80,
): asserts value is Value {
  let count = 0;
  const visit = (child: unknown, depth: number): void => {
    if (++count > 500_000 || depth > maxDepth)
      throw new Error("DOCUMENT_LIMIT");
    if (
      child === null ||
      typeof child === "boolean" ||
      typeof child === "string"
    )
      return;
    if (typeof child === "number" && Number.isFinite(child)) return;
    if (Array.isArray(child)) {
      child.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (isObject(child) && Object.getPrototypeOf(child) === Object.prototype) {
      for (const [key, item] of Object.entries(child)) {
        if (
          ["__proto__", "prototype", "constructor"].includes(key) ||
          key.startsWith("$sigma:")
        )
          throw new Error("INVALID_FIELD");
        visit(item, depth + 1);
      }
      return;
    }
    throw new Error("INVALID_JSON");
  };
  visit(value, 0);
}
