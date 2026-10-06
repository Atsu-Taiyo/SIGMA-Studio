import type { SigmaDocument } from "@sigma-studio/editor";

// Copied verbatim from a real Sigma Studio document (not a hand-authored
// fixture) so this example exercises the same content/shapes the desktop
// app actually persists. Do not hand-edit; regenerate by re-copying the
// source .sigmadoc.json if a new sample is needed.
import rawSampleDocument from "./sample-document.json";

/** Returns a fresh deep clone so callers can mutate their copy freely. */
export function createSampleDocument(): SigmaDocument {
  return JSON.parse(JSON.stringify(rawSampleDocument)) as SigmaDocument;
}
