import { z } from "zod";
import type { SigmaCommentAnchor } from "@/features/document";

const id = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const point = z.object({ blockId: id, offset: z.number().int().min(0).max(10_000_000) });
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const locationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("block"), blockId: id }),
  z.object({ type: z.literal("inlineMath"), blockId: id, mathInlineId: id }),
  z.object({ type: z.literal("textRange"), start: point, end: point }),
  z.object({ type: z.literal("overlayShape"), shapeIds: z.array(id).min(1).max(32) }),
  z.object({ type: z.literal("overlayMath"), shapeId: id, mathInlineId: id.optional() }),
  z.object({ type: z.literal("canvasRegion"), bounds: z.object({ x: coordinate, y: coordinate, w: z.number().positive().max(10_000_000), h: z.number().positive().max(10_000_000) }) }),
]);

/** Store stable model positions only. Selected prose and large math expressions stay off the URL. */
export function encodeDocumentLocation(anchor: SigmaCommentAnchor): string | null {
  const result = locationSchema.safeParse(anchor);
  if (!result.success) return null;
  const encoded = JSON.stringify(result.data);
  return encoded.length <= 1800 ? encoded : null;
}

export function decodeDocumentLocation(value: string | null): SigmaCommentAnchor | null {
  if (!value || value.length > 1800) return null;
  try {
    const result = locationSchema.safeParse(JSON.parse(value));
    if (!result.success) return null;
    return result.data.type === "textRange" ? { ...result.data, quote: "" } : result.data;
  } catch { return null; }
}
