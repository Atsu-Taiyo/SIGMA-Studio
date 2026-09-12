import type { Editor as TiptapEditor } from "@tiptap/core";

import type {
  OverlayAsset,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
  OverlaySnapshot,
} from "@/features/document";
import type { OverlayTool } from "@/features/drawing";

// Compatibility facade for the editor UI. Persisted model types live in the
// document feature and may be consumed without depending on React or Tiptap.
export type * from "@/features/document";
export type { OverlayInsertCommand, OverlayTool } from "@/features/drawing";

export interface OverlayEditorApi {
  createShape(shape: OverlayShape): void;
  createAssets(assets: OverlayAsset[]): void;
  updateShape(shape: Partial<OverlayShape> & Pick<OverlayShape, "id" | "type">): void;
  deleteShapes(ids: OverlayShapeId[]): void;
  select(id: OverlayShapeId): void;
  selectNone(): void;
  getShape(id: OverlayShapeId): OverlayShape | undefined;
  getSelectedShapeIds(): OverlayShapeId[];
  getOnlySelectedShapeId(): OverlayShapeId | null;
  getEditingShapeId(): OverlayShapeId | null;
  getCurrentPageShapes(): OverlayShape[];
  getShapeAtPoint(point: OverlayPoint, options?: { margin?: number }): OverlayShape | undefined;
  screenToPage(point: OverlayPoint): OverlayPoint;
  getSnapshot(): OverlaySnapshot;
  getSvgString(shapes: OverlayShape[]): Promise<{ svg: string } | null>;
  setCurrentTool(tool: OverlayTool): void;
  getCurrentToolId(): OverlayTool;
  on(event: "event", handler: (info: unknown) => void): void;
  off(event: "event", handler: (info: unknown) => void): void;
  store: {
    listen(handler: () => void, options?: { scope?: "document" | "session"; source?: "user" }): () => void;
  };
  getRichTextEditor(): TiptapEditor | null;
}
