/** Canonical code-language identifiers accepted in saved SigmaDoc blocks. */
export const CODE_LANGUAGE_IDS = [
  "plaintext",
  "python",
  "javascript",
  "typescript",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "r",
  "scheme",
  "sql",
  "bash",
  "json",
  "yaml",
  "xml",
  "css",
  "markdown",
  "latex",
] as const;
const supportedLanguages: ReadonlySet<string> = new Set(CODE_LANGUAGE_IDS);

/** Unknown languages fall back to automatic detection without changing source text. */
export function normalizeCodeLanguage(value: unknown): string | undefined {
  return typeof value === "string" && supportedLanguages.has(value) ? value : undefined;
}
