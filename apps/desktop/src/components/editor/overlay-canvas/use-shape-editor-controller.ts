"use client";
import {
  type Graph2DSpec,
  type OverlayTextBlock
} from "@/features/document";
import {
  isOverlayRichTextShape
} from "@/features/drawing";
import {
  type GraphSpecChangeMeta
} from "@/lib/graph2d";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { RefObject } from "react";
import {
  useCallback
} from "react";
import {
  type OverlayChangeHistory
} from "../page-overlay-types";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import type { TableShapeResizePatch } from "./shape-editors";
import {
  GRAPH_SHAPE_TYPE,
  getGraphCropPositionPatch
} from "./shapes/graph";
import {
  TABLE_SHAPE_TYPE
} from "./shapes/table";
import { finishTablePlacementFeedback } from "./table-placement-feedback";
import type {
  OverlayGraphShape,
  OverlayShape,
  OverlayShapeId,
  OverlayShapePatch,
  SigmaTableSpec
} from "./types";

export interface Dependencies {
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  selectShape: (id: OverlayShapeId) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  shapesRef: RefObject<OverlayShape[]>;
  updateShape: (patch: OverlayShapePatch, options?: { commit?: boolean; history?: OverlayChangeHistory; }) => void;
  updateGraphShapeSpec: (shapeId: OverlayShapeId, spec: Graph2DSpec, patch?: Partial<Pick<OverlayGraphShape, "x" | "y">>, options?: { preserveGraphOwnedLabelPositions?: boolean; }) => void;
  insertedTableFocusRef: RefObject<string | null>;
}

export function useOverlayShapeEditorController({ activeTextEditorRef, selectShape, transitionMode, shapesRef, updateShape, updateGraphShapeSpec, insertedTableFocusRef }: Dependencies) {

  const handleTextEditorFocus = useCallback((editor: TiptapEditor, shapeId: OverlayShapeId) => {
    activeTextEditorRef.current = editor;
    selectShape(shapeId);
    transitionMode({ type: "editText", shapeId });
  }, [activeTextEditorRef, selectShape, transitionMode]);

  const handleTextEditorCancel = useCallback((shapeId: OverlayShapeId) => {
    activeTextEditorRef.current?.commands.blur();
    activeTextEditorRef.current = null;
    selectShape(shapeId);
  }, [activeTextEditorRef, selectShape]);

  /**
   * The box height a shape's text turned out to need, reported by whichever surface drew it (the
   * static view on this canvas, or the Tiptap editor while the shape is focused).
   *
   * Height is a derived value now, so a text shape takes the measurement as-is — deleting a line
   * has to make the box shorter, or the selection outline keeps the old size. A callout still only
   * grows: its height is also the bubble the user can drag, and silently shrinking that would undo
   * a deliberate size. Coalesced into one history entry so a re-measure never costs an undo step.
   */
  const handleTextMeasuredHeight = useCallback((shapeId: OverlayShapeId, height: number) => {
    const shape = shapesRef.current.find((item) => item.id === shapeId);
    if (!shape || !isOverlayRichTextShape(shape)) {
      return;
    }

    const nextHeight = shape.type === "callout" ? Math.max(shape.props.h, height) : height;
    if (Math.abs(shape.props.h - nextHeight) < 1) {
      return;
    }

    updateShape({
      id: shapeId,
      type: shape.type,
      props: { h: nextHeight },
    }, { history: "coalesce" });
  }, [shapesRef, updateShape]);

  const handleTextChange = useCallback((shapeId: OverlayShapeId, blocks: OverlayTextBlock[]) => {
    const shape = shapesRef.current.find((item) => item.id === shapeId);
    // onTextChange fires from both text and callout OverlayTextShapeEditor instances
    // (shape-renderer.tsx), so this must accept callout too or its edits are silently dropped.
    if (!shape || !isOverlayRichTextShape(shape) || areOverlayTextBlocksEqual(shape.props.blocks, blocks)) {
      return;
    }

    // ここは打鍵ごとに同期で確定させる (`commit: true`)。
    //
    // デバウンス保存 (`queueOverlaySave`) へ移すと打鍵が 1 エントリにまとまってしまい、
    // 「図形テキストの undo は 1 文字ずつ」「その都度、保存済みの教材も同じ内容になる」という
    // 契約が壊れる (overlay-canvas.spec.ts「undoes text shape edits one step at a time with ctrl z」)。
    // 速くするなら履歴の粒度と書き込みの頻度を分離する必要があり、それは host 側
    // (`commitDocumentChange`) まで含めた設計変更になるので、ここでの付け替えでは扱わない。
    updateShape({
      id: shapeId,
      type: shape.type,
      props: { blocks },
    }, { commit: true });
  }, [shapesRef, updateShape]);

  const handleGraphSpecChange = useCallback((shapeId: OverlayShapeId, spec: Graph2DSpec, meta?: GraphSpecChangeMeta) => {
    const cropPatch = meta?.source === "crop" && meta.resizeToCrop ? meta.cropBox : undefined;
    const graphShape = cropPatch
      ? shapesRef.current.find((item): item is OverlayGraphShape => item.id === shapeId && item.type === GRAPH_SHAPE_TYPE)
      : null;
    const positionPatch = graphShape && cropPatch
      ? getGraphCropPositionPatch(graphShape, cropPatch)
      : {};
    updateGraphShapeSpec(
      shapeId,
      spec,
      positionPatch,
      { preserveGraphOwnedLabelPositions: meta?.source === "crop" },
    );
  }, [shapesRef, updateGraphShapeSpec]);

  const handleTableFirstCellReady = useCallback((editor: TiptapEditor, shapeId: OverlayShapeId) => {
    if (insertedTableFocusRef.current !== shapeId) return;
    insertedTableFocusRef.current = null;
    finishTablePlacementFeedback();
    editor.commands.focus("start", { scrollIntoView: false });
  }, [insertedTableFocusRef]);

  const handleTableEditorFocus = useCallback((editor: TiptapEditor, shapeId: OverlayShapeId) => {
    activeTextEditorRef.current = editor;
    selectShape(shapeId);
    transitionMode({ type: "editTable", shapeId });
  }, [activeTextEditorRef, selectShape, transitionMode]);

  const handleTableChange = useCallback((shapeId: OverlayShapeId, table: SigmaTableSpec) => {
    updateShape({
      id: shapeId,
      type: TABLE_SHAPE_TYPE,
      props: { table },
    });
  }, [updateShape]);

  const handleTableResize = useCallback((shapeId: OverlayShapeId, patch: TableShapeResizePatch) => {
    updateShape({
      id: shapeId,
      type: TABLE_SHAPE_TYPE,
      ...(patch.x === undefined ? {} : { x: patch.x }),
      ...(patch.y === undefined ? {} : { y: patch.y }),
      props: {
        w: patch.w,
        h: patch.h,
        table: patch.table,
      },
    });
  }, [updateShape]);

  const handleGraphCropEnd = useCallback(() => {
    transitionMode({ type: "select" });
  }, [transitionMode]);
  return {
    handleTableChange,
    handleTableEditorFocus,
    handleTableFirstCellReady,
    handleTableResize,
    handleTextMeasuredHeight,
    handleTextChange,
    handleTextEditorCancel,
    handleTextEditorFocus,
    handleGraphSpecChange,
    handleGraphCropEnd,
  };
}

export function areOverlayTextBlocksEqual(
  left: readonly OverlayTextBlock[],
  right: readonly OverlayTextBlock[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}