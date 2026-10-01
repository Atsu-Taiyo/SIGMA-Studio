"use client";

import { type SigmaDocument } from "@/features/document";
import { comparableDocumentValue } from "@/lib/document-equivalence";

export function documentHistoryKey(document: SigmaDocument): string {
  return JSON.stringify(canonicalizeDocumentValue(comparableDocumentValue(document)));
}

function canonicalizeDocumentValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeDocumentValue);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalizeDocumentValue(record[key])]),
  );
}

