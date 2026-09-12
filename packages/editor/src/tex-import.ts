import {
  importTexDocument as convertDocument,
  importTexProblem as convertProblem,
} from "@sigma-studio/editor-internal/tex-import";
import type { SigmaDocument } from "@sigma-studio/viewer";

/** TeX fields from an entrance-exam problem form. Macros are shared across its areas. */
export interface TexProblemInput {
  title: string;
  prompt: string;
  solution?: string;
  hints?: string;
  preamble?: string;
  tags?: string[];
}

/** Convert a full .tex document or body fragment to validated SigmaDoc. */
export function importTexDocument(input: string, filename?: string): SigmaDocument {
  return convertDocument(input, filename);
}

/** Convert a problem's separate prompt and explanation fields to one SigmaDoc problem. */
export function importTexProblem(input: TexProblemInput): SigmaDocument {
  return convertProblem(input);
}
