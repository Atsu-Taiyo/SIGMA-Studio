import type { OverlaySnapshot } from "./overlay-model";

export interface DocumentFontReference { family: string; resourceId: string }

export function documentFontReferences(snapshot: OverlaySnapshot | undefined): DocumentFontReference[] {
  const value = snapshot?.extensions?.["sigma.font-references"];
  if (!Array.isArray(value) || value.length > 32) return [];
  return value.filter((item): item is DocumentFontReference => Boolean(item && typeof item === "object"
    && typeof item.family === "string" && /^[\p{L}\p{N} _-]{1,160}$/u.test(item.family)
    && typeof item.resourceId === "string" && /^[a-f0-9]{64}$/u.test(item.resourceId)))
    .map(({ family, resourceId }) => ({ family, resourceId }));
}
