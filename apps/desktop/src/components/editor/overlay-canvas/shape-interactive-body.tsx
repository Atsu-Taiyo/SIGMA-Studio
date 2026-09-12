import { useEffect, useMemo, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";

import type {
  Graph3DCamera,
  Graph3DExpressionVector3,
  Graph3DObject,
  OverlayGraph3DShape,
  OverlayTextBlock,
  SigmaTableSpec,
} from "@/features/document";
import { Graph3DPreview } from "@/features/rendering/adapters/react";
import {
  GRAPH3D_ANIMATION_PREVIEW_EVENT,
  GRAPH3D_SETTINGS_OPEN_EVENT,
  type Graph3DAnimationPreviewDetail,
  type Graph3DSettingsOpenDetail,
} from "../graph3d-animation-preview";

import {
  OverlayTableShapeEditor,
  OverlayTextShapeEditor,
  type TableShapeResizePatch,
} from "./shape-editors";
import type { OverlayShapeEditorRenderers } from "./shape-renderer";
import type { OverlayShapeId } from "./types";

interface OverlayShapeEditorHandlers {
  onGraph3DCameraChange: (shapeId: OverlayShapeId, camera: Graph3DCamera) => void;
  onGraph3DObjectRotationChange: (
    shapeId: OverlayShapeId,
    objectId: string,
    rotation: Graph3DExpressionVector3,
  ) => void;
  onGraph3DObjectTransformChange: (
    shapeId: OverlayShapeId,
    objectId: string,
    transform: Pick<Graph3DObject, "rotation" | "translation" | "scale">,
  ) => void;
  onGraph3DPreviewReady: (
    shapeId: OverlayShapeId,
    dataUrl: string,
    size: { width: number; height: number },
    sourceHash: string,
    options: { animated: boolean },
  ) => void;
  onCreateChartFromTable: (shapeId: OverlayShapeId) => void;
  onTableChange: (shapeId: OverlayShapeId, table: SigmaTableSpec) => void;
  onTableEditorFocus: (editor: TiptapEditor, shapeId: OverlayShapeId) => void;
  onTableResize: (shapeId: OverlayShapeId, patch: TableShapeResizePatch) => void;
  onTextMeasuredHeight: (shapeId: OverlayShapeId, height: number) => void;
  onTextChange: (shapeId: OverlayShapeId, blocks: OverlayTextBlock[]) => void;
  onTextEditorCancel: (shapeId: OverlayShapeId) => void;
  onTextEditorFocus: (editor: TiptapEditor, shapeId: OverlayShapeId) => void;
}

function Graph3DInteractivePreview({
  shape,
  interactive,
  onCameraChange,
  onObjectRotationChange,
  onObjectTransformChange,
  onPreviewReady,
}: {
  shape: OverlayGraph3DShape;
  interactive: boolean;
  onCameraChange: OverlayShapeEditorHandlers["onGraph3DCameraChange"];
  onObjectRotationChange: OverlayShapeEditorHandlers["onGraph3DObjectRotationChange"];
  onObjectTransformChange: OverlayShapeEditorHandlers["onGraph3DObjectTransformChange"];
  onPreviewReady: OverlayShapeEditorHandlers["onGraph3DPreviewReady"];
}) {
  const [animationPreview, setAnimationPreview] = useState<Graph3DAnimationPreviewDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const handlePreview = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Graph3DAnimationPreviewDetail;
      if (detail.shapeId === shape.id) setAnimationPreview(detail);
    };
    window.addEventListener(GRAPH3D_ANIMATION_PREVIEW_EVENT, handlePreview);
    return () => window.removeEventListener(GRAPH3D_ANIMATION_PREVIEW_EVENT, handlePreview);
  }, [shape.id]);

  useEffect(() => {
    const handleSettingsOpen = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Graph3DSettingsOpenDetail;
      setSettingsOpen(detail.shapeId === shape.id);
    };
    window.addEventListener(GRAPH3D_SETTINGS_OPEN_EVENT, handleSettingsOpen);
    return () => window.removeEventListener(GRAPH3D_SETTINGS_OPEN_EVENT, handleSettingsOpen);
  }, [shape.id]);

  const animationCaughtUp = animationPreview?.playing === false
    && Object.entries(animationPreview.overrides).every(([name, value]) => (
      shape.props.spec.parameters.some((parameter) => parameter.name === name && parameter.value === value)
    ));
  const activeAnimationPreview = animationCaughtUp ? null : animationPreview;

  return (
    <Graph3DPreview
      spec={shape.props.spec}
      interactive={interactive}
      parameterOverrides={activeAnimationPreview?.overrides}
      animationPlaying={activeAnimationPreview?.playing === true}
      deferAnimationCapture={settingsOpen}
      onCameraChange={(camera) => onCameraChange(shape.id, camera)}
      onObjectRotationChange={(objectId, rotation) => onObjectRotationChange(shape.id, objectId, rotation)}
      onObjectTransformChange={(objectId, transform) => onObjectTransformChange(shape.id, objectId, transform)}
      onPreviewReady={(dataUrl, size, sourceHash, options) => onPreviewReady(shape.id, dataUrl, size, sourceHash, options)}
    />
  );
}

/**
 * The interactive half of the shape renderer: the only place that pulls the Tiptap-backed shape
 * editors into a rendering path.
 *
 * `shape-renderer.tsx` asks for these through `OverlayShapeEditorRenderers` and falls back to the
 * static views when they are absent, which is what keeps every read-only surface — including the
 * print surface that `packages/viewer` bundles — free of the editing runtime
 * (`packages/viewer/src/package-boundary.test.ts`).
 */
export function useOverlayShapeEditorRenderers(
  handlers: OverlayShapeEditorHandlers,
): OverlayShapeEditorRenderers {
  const {
    onGraph3DCameraChange,
    onGraph3DObjectRotationChange,
    onGraph3DObjectTransformChange,
    onGraph3DPreviewReady,
    onCreateChartFromTable,
    onTableChange,
    onTableEditorFocus,
    onTableResize,
    onTextMeasuredHeight,
    onTextChange,
    onTextEditorCancel,
    onTextEditorFocus,
  } = handlers;

  // Memoized on the handler identities: a fresh object here would re-render every shape — and with
  // it every formula — on each keystroke.
  return useMemo(() => ({
    renderGraph3DEditor: ({ interactive, shape }) => (
      <div
        className="overlay-graph3d-live-window"
        data-testid="overlay-graph3d-live-window"
        onPointerDown={interactive ? (event) => event.stopPropagation() : undefined}
        onDoubleClick={interactive ? (event) => event.stopPropagation() : undefined}
        onWheel={interactive ? (event) => event.stopPropagation() : undefined}
      >
        <Graph3DInteractivePreview
          shape={shape}
          interactive={interactive}
          onCameraChange={onGraph3DCameraChange}
          onObjectRotationChange={onGraph3DObjectRotationChange}
          onObjectTransformChange={onGraph3DObjectTransformChange}
          onPreviewReady={onGraph3DPreviewReady}
        />
      </div>
    ),
    renderTableEditor: ({ editing, shape }) => (
      <OverlayTableShapeEditor
        shape={shape}
        editing={editing}
        onFocus={onTableEditorFocus}
        onChange={onTableChange}
        onResize={onTableResize}
        onCreateChart={onCreateChartFromTable}
      />
    ),
    renderTextEditor: ({ editing, externalRevision, shape }) => (
      <OverlayTextShapeEditor
        shape={shape}
        externalRevision={externalRevision}
        editing={editing}
        onFocus={onTextEditorFocus}
        onCancel={onTextEditorCancel}
        onMeasuredHeight={onTextMeasuredHeight}
        onChange={onTextChange}
      />
    ),
  }), [
    onCreateChartFromTable,
    onGraph3DCameraChange,
    onGraph3DObjectRotationChange,
    onGraph3DObjectTransformChange,
    onGraph3DPreviewReady,
    onTableChange,
    onTableEditorFocus,
    onTableResize,
    onTextMeasuredHeight,
    onTextChange,
    onTextEditorCancel,
    onTextEditorFocus,
  ]);
}
