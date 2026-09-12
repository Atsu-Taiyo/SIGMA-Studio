export function normalizeTextAlign(
  value: unknown,
): "left" | "center" | "right" | "justify" | undefined {
  return value === "left"
    || value === "center"
    || value === "right"
    || value === "justify"
    ? value
    : undefined;
}

export function normalizeLayoutSectionColumnCount(value: unknown): number {
  const columnCount = typeof value === "number"
    ? value
    : Number.parseInt(String(value), 10);
  return Number.isInteger(columnCount)
    ? Math.min(4, Math.max(1, columnCount))
    : 2;
}

export function idPrefixForTextNode(
  sigmaDocType: string,
  nodeType: string,
): string {
  if (sigmaDocType === "section") {
    return "section";
  }
  if (sigmaDocType === "listItem") {
    return "li";
  }
  if (nodeType === "quote") {
    return "quote";
  }
  if (nodeType === "codeBlock") {
    // tiptap-document-adapter と同じ接頭辞。
    return "code";
  }
  if (nodeType === "divider") {
    return "divider";
  }
  return nodeType === "heading" ? "heading" : "p";
}

export function normalizeNonnegativeNumber(
  value: unknown,
): number | undefined {
  const number = typeof value === "number"
    ? value
    : Number.parseFloat(String(value));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
