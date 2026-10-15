import type { SigmaDocument } from "@/features/document";

/** Public wire protocol only. Conversion implementation is hosted privately. */
export const CONVERSION_IMPORT_ACCEPT = ".prt";
export const DOCUMENT_CONVERSION_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_CONVERSION_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export function isConversionFilename(name: string): boolean { return /\.prt$/i.test(name.trim()); }

export interface DocumentConversionIssue {
  code: "font-substitution" | "missing-glyph" | "unsupported-math" | "unsupported-graphic" | "unsupported-style";
  detail: string;
}
export interface DocumentConversionResult { document: SigmaDocument; issues: DocumentConversionIssue[] }
export type DocumentConversionError = "invalid-input" | "busy" | "timeout" | "import-failed"
  | "unavailable" | "unauthorized" | "not-allowed";
export type DocumentConversionResponse = { ok: true; result: DocumentConversionResult }
  | { ok: false; error: DocumentConversionError };
/** `displayName` is the product name the conversion service wants shown for its file type; it is optional so the client carries no brand of its own. */
export type DocumentConversionCapability = { available: true; displayName?: string }
  | { available: false; reason: "unavailable" | "unauthorized" | "not-allowed" };
