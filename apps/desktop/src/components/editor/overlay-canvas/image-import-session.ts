import { normalizeOverlayGroups, type OverlayAsset, type OverlayPoint, type OverlayShape } from "@/features/document";
import { placeOverlayImageEntries, type ImageInsertionSize, type OverlayImageEntry } from "@/features/drawing";

interface OverlayImageImportRequest {
  id: number;
  files: File[];
  point?: OverlayPoint;
}

interface OverlayImageImportPorts {
  areaSize: ImageInsertionSize;
  gap: number;
  decodeFile(file: File, areaSize: ImageInsertionSize): Promise<OverlayImageEntry>;
  getPlacement(): { canvasWidth: number; canvasHeight: number; parentId?: string };
  insert(shapes: OverlayShape[], assets: Record<string, OverlayAsset>): void;
  onHandled(requestId: number): void;
}

/**
 * Owns request deduplication for one mounted canvas. As in the canvas editor’s external-content
 * handling pattern (inspiration only), decoding and insertion have separate owners.
 * The host supplies live placement at completion and commits through its existing history path.
 */
export function createOverlayImageImportSession() {
  let handledRequestId: number | null = null;

  return {
    async handle(request: OverlayImageImportRequest, ports: OverlayImageImportPorts): Promise<void> {
      if (handledRequestId === request.id) {
        return;
      }
      handledRequestId = request.id;

      if (request.files.length === 0) {
        ports.onHandled(request.id);
        return;
      }

      try {
        const entries = await Promise.all(request.files.map((file) => ports.decodeFile(file, {
          w: ports.areaSize.w,
          h: ports.areaSize.h,
        })));
        if (entries.length === 0) {
          return;
        }
        const nextShapes = normalizeOverlayGroups(placeOverlayImageEntries(entries, {
          areaWidth: ports.areaSize.w,
          gap: ports.gap,
          point: request.point,
          ...ports.getPlacement(),
        }));
        const nextAssets = Object.fromEntries(entries.map(({ asset }) => [asset.id, asset]));
        ports.insert(nextShapes, nextAssets);
      } catch {
        return;
      } finally {
        // An image request also keeps an empty canvas mounted. Releasing it before
        // decode/insert completes unmounts that editor and loses the first image.
        ports.onHandled(request.id);
      }
    },
  };
}
