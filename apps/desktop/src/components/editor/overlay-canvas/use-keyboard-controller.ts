"use client";
import {
  getCurveDrawingPreviewPoints,
  mergeShapesById,
  moveShapes
} from "@/features/drawing";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction
} from "react";
import {
  useEffect
} from "react";
import {
  type OverlaySolidEdgeSelection
} from "../page-overlay-types";
import { getOverlayArrangeShortcutAction, overlayArrangeActionAllowsRepeat } from "./arrange-shortcuts";
import { isOverlaySelectionBlockedByEditPolicy } from "./edit-policy";
import {
  getGroupShape,
  getShapeIdsForCurrentScope,
  getUnlockedTransformShapes,
  normalizeOverlayGroups
} from "./grouping";
import { getImageCropModeShapeId } from "./interaction-geometry";
import {
  isInteractionMode,
  type InsertTool,
  type OverlayInteractionAction,
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  reanchorShapesByPosition
} from "./reanchor-model";
import { type OverlayArrangeAction } from "./reorder-shapes";
import { NON_MODAL_KEYBOARD_SURFACE_SELECTOR, isComposingKeyboardEvent, isTextInputTarget } from "./selection-command-model";
import {
  AnchorMeasurements
} from "./selection-handles";
import {
  arrowKeyDelta,
  isArrowKey,
  isConstraintModifierKey,
  isSnapDisableKey
} from "./shapes/create-shape";
import type {
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export interface Dependencies {
  textCompositionRef: RefObject<boolean>;
  modeRef: RefObject<OverlayInteractionMode>;
  cancelTablePlacement: () => void;
  snapDisabledRef: RefObject<boolean>;
  clearSnapGuides: () => void;
  updateModifierDrivenInteraction: (interaction: OverlayInteractionMode, modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">) => boolean;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  transitionMode: (action: OverlayInteractionAction) => void;
  queueDirtyImageCropSave: () => void;
  finishCurveDrawing: (tool: InsertTool, points: OverlayPoint[], closed?: boolean) => boolean;
  restoreTransientInteraction: (interaction: OverlayInteractionMode) => void;
  solidEdgeRef: RefObject<OverlaySolidEdgeSelection | null>;
  setSolidEdge: (next: OverlaySolidEdgeSelection | null) => void;
  focusedGroupIdRef: RefObject<string | null>;
  setFocusedGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  shapesRef: RefObject<OverlayShape[]>;
  ungroupSelectedShapes: () => void;
  groupSelectedShapes: () => void;
  selectedIdsRef: RefObject<string[]>;
  duplicateSelectedShapes: (offset?: OverlayPoint) => OverlayShape[];
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  notifyEditPolicyBlocked: () => void;
  arrangeSelectedShapes: (action: OverlayArrangeAction) => void;
  refreshAnchorMeasurements: () => AnchorMeasurements;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  deleteSelectedShapes: () => void;
  mode: OverlayInteractionMode;
}

export function useOverlayKeyboardController({
  textCompositionRef,
  modeRef,
  cancelTablePlacement,
  snapDisabledRef,
  clearSnapGuides,
  updateModifierDrivenInteraction,
  activeTextEditorRef,
  transitionMode,
  queueDirtyImageCropSave,
  finishCurveDrawing,
  restoreTransientInteraction,
  solidEdgeRef,
  setSolidEdge,
  focusedGroupIdRef,
  setFocusedGroupId,
  setSelectedShapeIds,
  shapesRef,
  ungroupSelectedShapes,
  groupSelectedShapes,
  selectedIdsRef,
  duplicateSelectedShapes,
  editPolicyLockedShapeIdsRef,
  notifyEditPolicyBlocked,
  arrangeSelectedShapes,
  refreshAnchorMeasurements,
  setShapes,
  deleteSelectedShapes,
  mode,
}: Dependencies) {

  useEffect(() => {
    const handleOverlayKeyboard = (event: KeyboardEvent) => {
      if (document.querySelector("[data-modal-backdrop]")) {
        return;
      }

      // 非モーダルの浮遊サーフェス (グラフ設定パネル) には backdrop が無いので、
      // フォーカスがその中にある間のキー操作をここで止める。止めないと、パネルを
      // 見ているユーザーの Delete で図形が消え、矢印キーで図形が動く。
      // 判定はイベントの発生元で行う — サーフェスの存在だけで一律に止めると、
      // パネルを開いたまま別の図形をキーボードで編集できなくなる。
      // 発生元で分けることで Escape も決定的になる (パネル内なら閉じる、
      // キャンバス上ならトリミング等の解除)。エディタのショートカット (Undo/ズーム) は
      // EditorShell 側の別ハンドラが担当し、そちらもパネルを除外している。
      const keyboardTarget = event.target instanceof Element ? event.target : document.activeElement;
      if (keyboardTarget?.closest(NON_MODAL_KEYBOARD_SURFACE_SELECTOR)) {
        return;
      }

      if (textCompositionRef.current || isComposingKeyboardEvent(event)) {
        return;
      }

      const currentMode = modeRef.current;
      if (event.key === "Escape" && currentMode.tool.kind === "insert" && currentMode.tool.command === "table" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        cancelTablePlacement();
        return;
      }

      if (isSnapDisableKey(event.key)) {
        snapDisabledRef.current = true;
        if (isInteractionMode(currentMode)) {
          event.preventDefault();
          clearSnapGuides();
          updateModifierDrivenInteraction(currentMode, event);
          return;
        }
      }

      if (activeTextEditorRef.current?.isFocused) {
        return;
      }

      if (
        (event.key === "Enter" || event.key === "Escape") &&
        getImageCropModeShapeId(currentMode) !== null &&
        !isTextInputTarget(event.target)
      ) {
        event.preventDefault();
        transitionMode({ type: "select" });
        queueDirtyImageCropSave();
        return;
      }

      if (currentMode.id === "overlay.curveDrawing" && !isTextInputTarget(event.target)) {
        if (event.key === "Escape") {
          event.preventDefault();
          transitionMode({ type: "setTool", tool: { kind: "select" } });
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          const previewPoints = getCurveDrawingPreviewPoints(currentMode.points, currentMode.current);
          if (previewPoints) {
            finishCurveDrawing(currentMode.tool, previewPoints);
          }
          return;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          transitionMode({ type: "removeLastCurvePoint" });
          return;
        }
      }

      if (event.key === "Escape" && currentMode.id !== "overlay.select") {
        event.preventDefault();
        const activeTextEditor = activeTextEditorRef.current;
        if (activeTextEditor && !activeTextEditor.isDestroyed) {
          activeTextEditor.commands.blur();
        }
        restoreTransientInteraction(currentMode);
        transitionMode({ type: "select" });
        return;
      }

      if (event.key === "Escape" && solidEdgeRef.current && currentMode.id === "overlay.select") {
        event.preventDefault();
        setSolidEdge(null);
        return;
      }

      if (event.key === "Escape" && focusedGroupIdRef.current && currentMode.id === "overlay.select") {
        event.preventDefault();
        setFocusedGroupId(null);
        setSelectedShapeIds([]);
        return;
      }

      if (isConstraintModifierKey(event.key) && updateModifierDrivenInteraction(currentMode, event)) {
        event.preventDefault();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isTextInputTarget(event.target)) {
        const ids = getShapeIdsForCurrentScope(shapesRef.current, focusedGroupIdRef.current);
        if (ids.length === 0) {
          return;
        }

        event.preventDefault();
        activeTextEditorRef.current?.commands.blur();
        setSelectedShapeIds(ids);
        transitionMode({ type: "select" });
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "g" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        ungroupSelectedShapes();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        groupSelectedShapes();
        return;
      }

      if (event.key === "Enter" && currentMode.id === "overlay.select" && !isTextInputTarget(event.target)) {
        const selectedGroup = selectedIdsRef.current.length === 1
          ? getGroupShape(shapesRef.current, selectedIdsRef.current[0])
          : null;
        if (selectedGroup) {
          event.preventDefault();
          setFocusedGroupId(selectedGroup.id);
          setSelectedShapeIds(getShapeIdsForCurrentScope(shapesRef.current, selectedGroup.id));
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && !isTextInputTarget(event.target)) {
        if (selectedIdsRef.current.length === 0) {
          return;
        }

        event.preventDefault();
        duplicateSelectedShapes();
        return;
      }

      const arrangeAction = getOverlayArrangeShortcutAction(event);
      const editingOverlayTextOrTable = currentMode.id === "overlay.textEditing"
        || currentMode.id === "overlay.tableEditing";
      if (arrangeAction && !isTextInputTarget(event.target) && !editingOverlayTextOrTable) {
        const selectedIds = selectedIdsRef.current;
        if (selectedIds.length === 0) {
          return;
        }
        if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIds, editPolicyLockedShapeIdsRef.current)) {
          notifyEditPolicyBlocked();
          return;
        }
        const hasUnlockedSelection = getUnlockedTransformShapes(
          shapesRef.current,
          selectedIds,
          editPolicyLockedShapeIdsRef.current,
        ).length > 0;
        if (!hasUnlockedSelection || (event.repeat && !overlayArrangeActionAllowsRepeat(arrangeAction))) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        arrangeSelectedShapes(arrangeAction);
        return;
      }

      if (!event.metaKey && !event.ctrlKey && isArrowKey(event.key) && !isTextInputTarget(event.target)) {
        const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
        if (selectedShapes.length === 0) {
          if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
            notifyEditPolicyBlocked();
          }
          return;
        }

        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        const delta = arrowKeyDelta(event.key, distance);
        const movedIdSet = new Set(selectedShapes.map((shape) => shape.id));
        const { ordered } = refreshAnchorMeasurements();
        const movedShapes = moveShapes(selectedShapes, delta.x, delta.y);
        setShapes((current) => {
          const next = normalizeOverlayGroups(reanchorShapesByPosition(mergeShapesById(current, movedShapes), movedIdSet, ordered));
          shapesRef.current = next;
          return next;
        });
        return;
      }

      if (event.key !== "Backspace" && event.key !== "Delete") {
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      const ids = selectedIdsRef.current;
      if (ids.length === 0) {
        return;
      }

      event.preventDefault();
      deleteSelectedShapes();
    };

    window.addEventListener("keydown", handleOverlayKeyboard);
    return () => window.removeEventListener("keydown", handleOverlayKeyboard);
  }, [arrangeSelectedShapes, cancelTablePlacement, deleteSelectedShapes, duplicateSelectedShapes, finishCurveDrawing, groupSelectedShapes, clearSnapGuides, notifyEditPolicyBlocked, queueDirtyImageCropSave, refreshAnchorMeasurements, restoreTransientInteraction, setSelectedShapeIds, setSolidEdge, transitionMode, ungroupSelectedShapes, updateModifierDrivenInteraction, textCompositionRef, modeRef, activeTextEditorRef, solidEdgeRef, focusedGroupIdRef, selectedIdsRef, snapDisabledRef, setFocusedGroupId, shapesRef, editPolicyLockedShapeIdsRef, setShapes]);

  useEffect(() => {
    const cropShapeId = getImageCropModeShapeId(mode);
    if (!cropShapeId) {
      return;
    }

    const handleOutsideImagePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const targetShape = target?.closest("[data-overlay-shape-id]");
      if (
        target?.closest(".overlay-crop-handle") ||
        targetShape?.getAttribute("data-overlay-shape-id") === cropShapeId
      ) {
        return;
      }
      transitionMode({ type: "select" });
      queueDirtyImageCropSave();
    };

    window.addEventListener("pointerdown", handleOutsideImagePointerDown, true);
    return () => window.removeEventListener("pointerdown", handleOutsideImagePointerDown, true);
  }, [mode, queueDirtyImageCropSave, transitionMode]);

  useEffect(() => {
    const handleOverlayKeyUp = (event: KeyboardEvent) => {
      if (isSnapDisableKey(event.key)) {
        snapDisabledRef.current = false;
        if (
          !textCompositionRef.current &&
          !isComposingKeyboardEvent(event) &&
          !activeTextEditorRef.current?.isFocused &&
          updateModifierDrivenInteraction(modeRef.current, event)
        ) {
          event.preventDefault();
        }
        return;
      }

      if (
        !isConstraintModifierKey(event.key) ||
        textCompositionRef.current ||
        isComposingKeyboardEvent(event) ||
        activeTextEditorRef.current?.isFocused
      ) {
        return;
      }

      if (updateModifierDrivenInteraction(modeRef.current, event)) {
        event.preventDefault();
      }
    };

    window.addEventListener("keyup", handleOverlayKeyUp);
    return () => window.removeEventListener("keyup", handleOverlayKeyUp);
  }, [activeTextEditorRef, modeRef, snapDisabledRef, textCompositionRef, updateModifierDrivenInteraction]);
}
