import { createId } from "@/lib/id";

import type { OverlayAssetId, OverlayGroupId, OverlayShapeId, OverlayTextBlock } from "./types";

export function createOverlayShapeId(): OverlayShapeId {
  return createId("overlay_shape");
}

export function createOverlayAssetId(): OverlayAssetId {
  return createId("overlay_asset");
}

export function createOverlayGroupId(): OverlayGroupId {
  return createId("overlay_group");
}

/**
 * One paragraph holding `text`. Shape blocks carry the same `id` body blocks do — the Tiptap round
 * trip keys block identity on it, so a block created without one loses its identity on first edit.
 */
export function createOverlayTextBlocks(text: string): OverlayTextBlock[] {
  return [
    {
      type: "paragraph",
      id: createId("p"),
      children: text ? [{ type: "text", text }] : [],
    },
  ];
}
