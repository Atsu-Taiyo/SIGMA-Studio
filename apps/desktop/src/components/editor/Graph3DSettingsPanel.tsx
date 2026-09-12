"use client";

import { Box, ChevronDown, ImageDown, Plus, Trash2 } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { ColorPalette } from "@/components/editor/ColorPalette";
import { GraphSettingsPanelFrame } from "@/components/editor/GraphSettingsPanel";
import { GRAPH_SETTINGS_POPOVER_Z_INDEX } from "./GraphItemActionsMenu";
import { GRAPH_SETTINGS_GRID_PANEL_WIDTH_PX, GRAPH_SETTINGS_PANEL_WIDTH_PX } from "@/components/editor/graph-settings-panel-placement";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { LineEndpointMenuButton } from "@/components/editor/editor-shell/formatting-icons";
import { OverlayLineDashMenuButton } from "@/components/editor/overlay-line-style-menus";
import { dispatchGraph3DSettingsOpen } from "@/components/editor/graph3d-animation-preview";
import { MathExpressionInput } from "@/components/math/MathExpressionInput";
import { Button, IconButton } from "@/components/ui/Button";
import { Inline, Inset, Stack } from "@/components/ui/layout";
import { Select } from "@/components/ui/Select";
import { getGraph3DAxisColors, resolveGraph3DDimensionEndStyle } from "@/features/document";
import type {
  Graph3DAnnotation,
  Graph3DAxisColors,
  Graph3DAxisEndStyle,
  Graph3DAxisLineStyle,
  Graph3DBounds,
  Graph3DExpressionRange,
  Graph3DExpressionVector3,
  Graph3DFillStyle,
  Graph3DObject,
  Graph3DObjectIntersectionRegion,
  Graph3DPreset,
  Graph3DSpec,
} from "@/features/document";
import {
  GRAPH3D_DEFAULT_CAMERA,
  MAX_PRIMITIVE_RING_SAMPLES,
  MAX_SCALAR_FIELD_RESOLUTION,
  MIN_PRIMITIVE_RING_SAMPLES,
  buildGraph3DObjectGeometry,
  buildGraph3DSceneGeometry,
  createGraph3DSpecPreset,
  createGraph3DThumbnailDrawing,
  createGraph3DThumbnailObject,
  getGraph3DIntersectionGeometry,
  evaluateMathExpression,
  graph3DPrimitiveRingSamples,
  graph3DVideoAnimationParameters,
  getGraph3DIntersectionMesh,
  graph3DBoundedSolidResolution,
  Graph3DModelError,
  type Graph3DIntersectionGeometry,
  type Graph3DThumbnailDrawing,
  type MathExpressionVariables,
} from "@/features/drawing";
import { rasterizeElement } from "@/features/rendering/adapters";
import { MathPreview } from "@/features/rendering/adapters/react";
import { createGraph3DIntersectionSvg } from "@/features/rendering/adapters/svg";
import {
  graph3DVideoPixelSize,
  recordGraph3DAnimationVideo,
  type Graph3DVideoLabelImage,
} from "@/features/rendering/adapters/three";
import { createGraph3DDisplayAnnotations } from "@/features/rendering/core";
import { downloadGeneratedFile } from "@/lib/download-file";
import { createId } from "@/lib/id";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { useAppLocale, useT } from "@/lib/i18n/react";

import { GraphVideoExportRow, type GraphVideoExportState } from "./GraphVideoExportRow";
import { GraphParameters } from "./GraphParameters";
import styles from "./GraphSettingsControls.module.css";
import { GraphSettingsSection, GraphCardGrid, GraphAddCard, GraphWidgetCard } from "./GraphSettingsControls";
import {
  buildGraph3DObjectChoiceGroups,
  createGraph3DIntersectionOnlySpec,
  createGraph3DIntersectionRegion,
  createGraph3DObjectFromChoice,
  createGraph3DPlaneDefinition,
  createGraph3DSectionFill,
  graph3DExpressionToTex,
  graph3DVector as vector,
  parseGraph3DExpressionTex,
  type Graph3DExpressionMode,
} from "./graph3d-editor-model";

/**
 * 3D は2Dより要素の種類が多く (立体・共通部分・パラメータ・注釈)、1列に積むと
 * 縦に流れて見通しが効かない。カードをグリッドに並べるぶんだけ広く取る。
 */
export const GRAPH3D_SETTINGS_PANEL_WIDTH_PX = GRAPH_SETTINGS_GRID_PANEL_WIDTH_PX;

const tShape = createCurrentLocaleTranslator("shape");

export const SELECT_OVERLAY_GRAPH3D_EVENT = "sigma-studio:select-overlay-graph3d";
export const OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT = "sigma-studio:open-overlay-graph3d-settings";

/** A picture derived from part of a 3D material, ready to be dropped onto the page. */
export interface Graph3DDerivedImage {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

export interface SelectedOverlayGraph3D {
  shapeId: string;
  spec: Graph3DSpec;
  /** Size on the page, in document pixels. The exported video keeps this aspect ratio. */
  size: { width: number; height: number };
  onSpecChange: (nextSpec: Graph3DSpec, options?: { save?: boolean }) => void;
  onAnimationPreview: (overrides: MathExpressionVariables, playing: boolean) => void;
  /** Puts a picture of one part of this material into the document, beside the material. */
  onInsertImage: (image: Graph3DDerivedImage) => void;
  /** Puts another 3D material into the document, beside this one. */
  onInsertSpec: (spec: Graph3DSpec) => void;
  onClose: () => void;
}

/**
 * 選択中の3D教材をこのコンポーネントが自前で購読する。
 *
 * EditorShell の state に置くと、spec が1目盛り変わるたびにリボンを含む
 * シェル全体が再レンダーされる (計測ではパラメータドラッグの 64% がリボンだった)。
 * パネルだけが再レンダーされれば足りるので、購読ごとここへ閉じ込める。
 */
export function Graph3DSettingsPanelHost({
  shapeId,
  onClose,
  onUndo,
  onRedo,
}: {
  shapeId: string | null;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const [selected, setSelected] = useState<SelectedOverlayGraph3D | null>(null);

  useEffect(() => {
    const handleSelect = (event: Event) => {
      setSelected(event instanceof CustomEvent
        ? event.detail as SelectedOverlayGraph3D | null
        : null);
    };
    window.addEventListener(SELECT_OVERLAY_GRAPH3D_EVENT, handleSelect);
    return () => window.removeEventListener(SELECT_OVERLAY_GRAPH3D_EVENT, handleSelect);
  }, []);

  useEffect(() => {
    // 本文・空白・別図形へ選択が移ったら畳む。開いていないときは何もしない。
    if (!shapeId) return;
    if (!selected || selected.shapeId !== shapeId) onClose();
  }, [onClose, selected, shapeId]);

  if (!shapeId || !selected || selected.shapeId !== shapeId) {
    return null;
  }
  return (
    <Graph3DSettingsPanel
      selectedOverlayGraph3D={selected}
      onClose={onClose}
      onUndo={onUndo}
      onRedo={onRedo}
    />
  );
}

export function Graph3DSettingsPanel({
  selectedOverlayGraph3D,
  onClose,
  onUndo,
  onRedo,
}: {
  selectedOverlayGraph3D: SelectedOverlayGraph3D;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  // モジュール版の翻訳子をシャドーする。パネル全面がロケールストアを購読し、
  // 言語切り替え時に開いたままのパネルも同じ描画パスで追従する。
  const tShape = useT("shape");
  const { spec, size, onSpecChange, onAnimationPreview, onInsertImage, onInsertSpec } = selectedOverlayGraph3D;
  const specRef = useRef(spec);
  const onSpecChangeRef = useRef(onSpecChange);
  const onInsertImageRef = useRef(onInsertImage);
  const onInsertSpecRef = useRef(onInsertSpec);
  const [videoExport, setVideoExport] = useState<GraphVideoExportState>({ status: "idle" });
  // Mounted only for the instant a video export needs to measure its labels; see `exportVideo`.
  const [videoLabelDrafts, setVideoLabelDrafts] = useState<Graph3DVideoLabelDraft[] | null>(null);
  const videoLabelRefs = useRef(new Map<string, HTMLSpanElement>());
  const sizeRef = useRef(size);

  useEffect(() => {
    specRef.current = spec;
  }, [spec]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  /**
   * 開いている間、本文側のライブ窓にアニメーションの焼き直しを止めさせる。
   *
   * 色を1つ変えるたびにページ用のアニメーションPNGを撮り直していて、その撮影は
   * ライブ窓でループを1周まわすので、編集のたびに本文の立体がチカチカしていた。
   * 動いて見えなくていい場面なので、パネルを閉じたときにまとめて撮り直す。
   */
  useEffect(() => {
    dispatchGraph3DSettingsOpen(selectedOverlayGraph3D.shapeId);
    return () => dispatchGraph3DSettingsOpen(null);
  }, [selectedOverlayGraph3D.shapeId]);

  useEffect(() => {
    onSpecChangeRef.current = onSpecChange;
  }, [onSpecChange]);

  // 図形が保存されるたびに新しい関数が届く。そのままカードへ渡すと、パラメータを1目盛り
  // 動かすだけで共通部分のカードが全部作り直される (プレビューの再計算ごと)。
  useEffect(() => {
    onInsertImageRef.current = onInsertImage;
  }, [onInsertImage]);

  useEffect(() => {
    onInsertSpecRef.current = onInsertSpec;
  }, [onInsertSpec]);

  const updateSpec = useCallback((
    updater: (current: Graph3DSpec) => Graph3DSpec,
    options?: { save?: boolean },
  ) => {
    const next = updater(specRef.current);
    if (next === specRef.current) return;
    specRef.current = next;
    onSpecChangeRef.current(next, options);
  }, []);

  /**
   * ⌘Z はこのパネル専用の履歴を持たない。視点の回転・倍率・本文の編集と同じ一本の履歴を戻す。
   *
   * 拾い直しているのは、パネルの中はスライダーや入力欄が並んでいて、そこへ focus がある間は
   * 共通のショートカット表が «入力欄の中» と見て素通りさせるため (isCommandShortcutBlockedByTarget)。
   * 数式欄だけは MathLive の入力履歴に任せる — まだ spec に確定していない打鍵を戻す先はそちらしかない。
   */
  const handleUndoShortcut = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    if (event.target instanceof Element && event.target.closest("math-field")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) onRedo();
    else onUndo();
  };

  const axisColors: Graph3DAxisColors = getGraph3DAxisColors(spec.view);
  const parameterValues = useMemo<MathExpressionVariables>(() => Object.fromEntries(
    spec.parameters.map((parameter) => [parameter.name, parameter.value]),
  ), [spec.parameters]);
  const intersectionRegions = useMemo(
    () => spec.regions.filter((region): region is Graph3DObjectIntersectionRegion => (
      region.kind === "objectIntersection"
    )),
    [spec.regions],
  );

  // 以下のハンドラは identity を固定する。カード側を memo で止めても、毎レンダーで
  // 新しい関数を渡すと止まらない (パラメータを1目盛り動かすたびに全カードが作り直される)。
  const updateObject = useCallback((objectId: string, updater: (object: Graph3DObject) => Graph3DObject) => {
    updateSpec((current) => ({
      ...current,
      objects: current.objects.map((object) => object.id === objectId ? updater(object) : object),
    }));
  }, [updateSpec]);
  const addObject = useCallback((choice: string) => {
    const object = createGraph3DObjectFromChoice(choice, tShape);
    if (!object) return;
    updateSpec((current) => ({ ...current, objects: [...current.objects, object] }));
  }, [updateSpec, tShape]);
  const deleteObject = useCallback((objectId: string) => {
    updateSpec((current) => ({
      ...current,
      objects: current.objects.filter((candidate) => candidate.id !== objectId),
      regions: current.regions.filter((region) => region.kind !== "objectIntersection" || (
        region.objectIds.filter((id) => id !== objectId).length >= 2
      )).map((region) => region.kind === "objectIntersection"
        ? { ...region, objectIds: region.objectIds.filter((id) => id !== objectId) }
        : region),
    }));
  }, [updateSpec]);
  const updateRegion = useCallback((
    regionId: string,
    updater: (region: Graph3DObjectIntersectionRegion) => Graph3DObjectIntersectionRegion,
  ) => {
    updateSpec((current) => ({
      ...current,
      regions: current.regions.map((region) => region.id === regionId && region.kind === "objectIntersection"
        ? updater(region)
        : region),
    }));
  }, [updateSpec]);
  const deleteRegion = useCallback((regionId: string) => {
    updateSpec((current) => ({
      ...current,
      regions: current.regions.filter((region) => region.id !== regionId),
    }));
  }, [updateSpec]);
  const updateAnnotation = useCallback((annotation: Graph3DAnnotation) => {
    updateSpec((current) => ({
      ...current,
      annotations: current.annotations.map((candidate) => candidate.id === annotation.id ? annotation : candidate),
    }));
  }, [updateSpec]);
  const deleteAnnotation = useCallback((annotationId: string) => {
    updateSpec((current) => ({
      ...current,
      annotations: current.annotations.filter((candidate) => candidate.id !== annotationId),
    }));
  }, [updateSpec]);

  /**
   * 平面になった共通部分を、その形のまま本文へ置く。
   *
   * 3D窓の中の面は、読み手が回して初めて正面から見える。平面図として1枚置けるなら、
   * それは平面図として置いたほうが問題文に使える。
   */
  const insertRegionImage = useCallback((regionId: string) => {
    const region = specRef.current.regions.find((candidate) => candidate.id === regionId);
    const image = createGraph3DIntersectionSvg(specRef.current, regionId, { width: 320 });
    if (!image) return;
    onInsertImageRef.current({
      dataUrl: image.dataUrl,
      width: image.width,
      height: image.height,
      name: `${(region && "label" in region && region.label) || tShape("graph3d.intersectionFallback")}.svg`,
    });
  }, [tShape]);

  /** 共通部分だけを表示した3D教材を、もう1つ本文へ置く。中の式は生きたまま。 */
  const insertRegionSpec = useCallback((regionId: string) => {
    const extracted = createGraph3DIntersectionOnlySpec(specRef.current, regionId);
    if (extracted) onInsertSpecRef.current(extracted);
  }, []);

  /**
   * TeXラベルを、ブラウザが組んだそのままの形で1枚ずつ画像にする。
   *
   * 動画のフレームには DOM を重ねられない。数式ラベルを素のテキストに落とすと分数・根号・
   * 指数がつぶれるので、実際に組版させたものを測って焼き込む。`flushSync` なのは、置いた
   * ラベルをこの呼び出しの続きで測る必要があるため (レイアウトはコミット後にしか出ない)。
   */
  const rasterizeVideoLabels = useCallback(async (
    currentSpec: Graph3DSpec,
    scale: number,
  ): Promise<Map<string, Graph3DVideoLabelImage>> => {
    const images = new Map<string, Graph3DVideoLabelImage>();
    const geometry = buildGraph3DSceneGeometry(currentSpec);
    const drafts: Graph3DVideoLabelDraft[] = createGraph3DDisplayAnnotations(
      currentSpec,
      geometry.annotations,
      getGraph3DAxisColors(currentSpec.view),
    ).map((annotation) => ({
      id: annotation.id,
      tex: annotation.labelTex,
      color: annotation.color,
    }));
    if (drafts.length === 0) return images;
    await document.fonts?.ready;
    flushSync(() => setVideoLabelDrafts(drafts));
    try {
      for (const draft of drafts) {
        const element = videoLabelRefs.current.get(draft.id);
        const raster = element ? rasterizeElement(element, scale) : null;
        if (raster) images.set(draft.id, raster);
      }
    } finally {
      flushSync(() => setVideoLabelDrafts(null));
    }
    return images;
  }, []);

  /**
   * アニメーションを動画ファイルにして、ダウンロードフォルダへ置く。
   *
   * 「ページ上でも動かす」を付けたパラメータがあればその組み合わせ、無ければ範囲を持つ
   * パラメータ全部が動く (`graph3DVideoAnimationParameters`)。長さはいちばん遅い
   * パラメータの1往復ぶん。
   */
  const exportVideo = useCallback(async () => {
    const currentSpec = specRef.current;
    if (graph3DVideoAnimationParameters(currentSpec).length === 0) {
      setVideoExport({ status: "error", message: tShape("graph3d.noAnimatableParameters") });
      return;
    }
    setVideoExport({ status: "preparing" });
    try {
      const { width, height } = sizeRef.current;
      const labels = await rasterizeVideoLabels(currentSpec, graph3DVideoPixelSize(width, height).scale);
      setVideoExport({ status: "recording", progress: 0 });
      const recording = await recordGraph3DAnimationVideo({
        spec: currentSpec,
        width,
        height,
        labels,
        onProgress: (progress) => setVideoExport({ status: "recording", progress }),
      });
      setVideoExport({ status: "saving" });
      const saved = await downloadGeneratedFile(recording.blob, tShape("graph3d.animationExportName", { extension: recording.extension }));
      setVideoExport({ status: "done", filePath: saved.filePath });
    } catch (error) {
      setVideoExport({
        status: "error",
        message: error instanceof Error ? error.message : tShape("graph3dUi.videoExportFailed"),
      });
    }
  }, [rasterizeVideoLabels, tShape]);

  return (
    <GraphSettingsPanelFrame
      shapeId={selectedOverlayGraph3D.shapeId}
      title={tShape("graph3dUi.settingsTitle")}
      ariaLabel={tShape("graph3dUi.settingsTitle")}
      width={GRAPH3D_SETTINGS_PANEL_WIDTH_PX}
      minWidth={GRAPH_SETTINGS_PANEL_WIDTH_PX}
      onClose={onClose}
    >
      <Inset className={styles.inspector} space="md" onKeyDownCapture={handleUndoShortcut}>
        <Stack gap="md">
          <div className={styles.field}>
            <span>{tShape("graph3dUi.templates")}</span>
            <Select
              aria-label={tShape("graph3dUi.templates")}
              value=""
              options={[
                { value: "", label: tShape("graph3dUi.templateKeepCurrent") },
                { value: "revolution", label: tShape("graph3dUi.templateRevolution") },
                { value: "tricylinder", label: tShape("graph3dUi.templateTricylinder") },
                { value: "sphereTetrahedron", label: tShape("graph3dUi.templateSphereTetrahedron") },
                { value: "surface", label: tShape("graph3dUi.templateSurface") },
                { value: "blank", label: tShape("graph3dUi.templateBlank") },
              ]}
              onChange={(preset) => {
                if (!preset) return;
                const next = createGraph3DSpecPreset(preset as Graph3DPreset, buildGraph3DPresetNames(tShape));
                specRef.current = next;
                onSpecChange(next);
              }}
            />
          </div>

          <GraphSettingsSection title={tShape("graph3dUi.parametersSection")} count={spec.parameters.length}>
            {spec.parameters.length === 0 && <EmptyHint>{tShape("graph3dUi.parametersEmptyHint")}</EmptyHint>}
            <GraphParameters key={selectedOverlayGraph3D.shapeId} parameters={spec.parameters}
              onChange={(updater) => updateSpec((current) => ({ ...current, parameters: updater(current.parameters) }))}
              onPreview={onAnimationPreview} />
            <GraphVideoExportRow
              parameters={graph3DVideoAnimationParameters(spec)}
              state={videoExport}
              onExport={() => void exportVideo()}
            />
          </GraphSettingsSection>

          <GraphSettingsSection title={tShape("graph3dUi.objectsSection")} count={spec.objects.length}>
            <GraphCardGrid>
            {spec.objects.map((object) => (
              <ObjectEditor
                key={object.id}
                object={object}
                variables={parameterValues}
                onChange={updateObject}
                onDelete={deleteObject}
              />
            ))}
            <AddObjectCard onAdd={addObject} />
            </GraphCardGrid>
          </GraphSettingsSection>

          <GraphSettingsSection title={tShape("graph3d.intersectionFallback")} count={intersectionRegions.length}>
            {intersectionRegions.length === 0 && (
              <EmptyHint>
                {tShape("graph3dUi.intersectionExplainer")}
              </EmptyHint>
            )}
            <GraphCardGrid>
            {intersectionRegions.map((region) => (
              <IntersectionEditor
                key={region.id}
                region={region}
                objects={spec.objects}
                variables={parameterValues}
                onChange={updateRegion}
                onDelete={deleteRegion}
                onInsertImage={insertRegionImage}
                onInsertSpec={insertRegionSpec}
              />
            ))}
            <GraphAddCard
              label={tShape("graph3dUi.addIntersection")}
              disabled={spec.objects.length < 2}
              onClick={() => updateSpec((current) => ({
                ...current,
                regions: [
                  ...current.regions,
                  createGraph3DIntersectionRegion(current.objects.slice(0, 2).map((object) => object.id), tShape),
                ],
              }))}
            />
            </GraphCardGrid>
            {spec.objects.length < 2 && <EmptyHint>{tShape("graph3dUi.intersectionNeedsTwoShapesHint")}</EmptyHint>}
          </GraphSettingsSection>

          <GraphSettingsSection title={tShape("graph3dUi.annotationsSection")} count={spec.annotations.length}>
            {spec.annotations.length === 0 && <EmptyHint>{tShape("graph3dUi.annotationsEmptyHint")}</EmptyHint>}
            <GraphCardGrid>
            {spec.annotations.map((annotation) => (
              <AnnotationEditor
                key={annotation.id}
                annotation={annotation}
                onChange={updateAnnotation}
                onDelete={deleteAnnotation}
              />
            ))}
            <GraphAddCard
              label={tShape("graph3dUi.addMathLabel")}
              onClick={() => updateSpec((current) => ({
                ...current,
                annotations: [...current.annotations, createDefaultAnnotation("label")],
              }))}
            />
            <GraphAddCard
              label={tShape("graph3dUi.addDimensionLine")}
              onClick={() => updateSpec((current) => ({
                ...current,
                annotations: [...current.annotations, createDefaultAnnotation("dimension")],
              }))}
            />
            </GraphCardGrid>
          </GraphSettingsSection>

          <GraphSettingsSection title={tShape("graph3dUi.displaySection")}>
            <Inline gap="md" wrap>
              <CheckboxField
                label={tShape("graph3dUi.axes")}
                checked={spec.view.showAxes}
                onChange={(showAxes) => updateSpec((current) => ({ ...current, view: { ...current.view, showAxes } }))}
              />
              <CheckboxField
                label={tShape("graph3dUi.grid")}
                checked={spec.view.showGrid}
                onChange={(showGrid) => updateSpec((current) => ({ ...current, view: { ...current.view, showGrid } }))}
              />
              <CheckboxField
                label={tShape("graph3dUi.axisLabels")}
                checked={spec.view.showAxisLabels !== false}
                disabled={!spec.view.showAxes}
                onChange={(showAxisLabels) => updateSpec((current) => ({ ...current, view: { ...current.view, showAxisLabels } }))}
              />
            </Inline>
            <fieldset className={styles.fieldset} disabled={!spec.view.showAxes}>
              <legend>{tShape("graph3dUi.axis")}</legend>
              <Inline className={styles.axisAppearance} gap="sm" wrap>
                <LineStyleButtons
                  lineStyle={spec.view.axisLineStyle ?? "solid"}
                  endStyle={spec.view.axisEndStyle ?? "arrow"}
                  disabled={!spec.view.showAxes}
                  onLineStyleChange={(axisLineStyle) => updateSpec((current) => ({
                    ...current,
                    view: { ...current.view, axisLineStyle },
                  }))}
                  onEndStyleChange={(axisEndStyle) => updateSpec((current) => ({
                    ...current,
                    view: { ...current.view, axisEndStyle },
                  }))}
                />
                <div className={styles.axisColorGrid}>
                  {(["x", "y", "z"] as const).map((axis) => (
                    <ColorField
                      key={axis}
                      label={axis}
                      value={axisColors[axis]}
                      disabled={!spec.view.showAxes}
                      onChange={(color) => updateSpec((current) => ({
                        ...current,
                        view: {
                          ...current.view,
                          axisColors: { ...getGraph3DAxisColors(current.view), [axis]: color },
                        },
                      }))}
                    />
                  ))}
                </div>
              </Inline>
            </fieldset>
            <div className={styles.viewGroups}>
              <div className={styles.field}>
                <span>{tShape("graph3dUi.projection")}</span>
                <Select
                  aria-label={tShape("graph3dUi.projectionMethod")}
                  value={spec.camera.projection}
                  options={[
                    { value: "perspective", label: tShape("graph3dUi.projectionPerspective") },
                    { value: "orthographic", label: tShape("graph3dUi.projectionOrthographic") },
                  ]}
                  onChange={(projection) => updateSpec((current) => ({
                    ...current,
                    camera: { ...current.camera, projection: projection as "perspective" | "orthographic" },
                  }))}
                />
              </div>
              <ColorField label={tShape("graph3dUi.background")} value={spec.view.backgroundColor} onChange={(backgroundColor) => updateSpec((current) => ({
                ...current,
                view: { ...current.view, backgroundColor },
              }))} />
            </div>
            <Button
              size="sm"
              onClick={() => updateSpec((current) => ({
                ...current,
                camera: GRAPH3D_DEFAULT_CAMERA,
              }))}
            >
              {tShape("graph3dUi.resetView")}
            </Button>
          </GraphSettingsSection>
        </Stack>
      </Inset>
      {videoLabelDrafts && (
        // 画面の外へ置くだけで隠す。`visibility: hidden` にすると採寸できない。
        <div className={styles.videoLabelStage} aria-hidden="true">
          {videoLabelDrafts.map((draft) => (
            <span
              className="graph3d-annotation-label"
              key={draft.id}
              ref={(element) => {
                if (element) videoLabelRefs.current.set(draft.id, element);
                else videoLabelRefs.current.delete(draft.id);
              }}
              style={{ color: draft.color ?? "#1f2937" }}
            >
              <MathPreview tex={draft.tex} />
            </span>
          ))}
        </div>
      )}
    </GraphSettingsPanelFrame>
  );
}

interface Graph3DVideoLabelDraft {
  id: string;
  tex: string;
  color?: string;
}

function LineStyleButtons({
  lineStyle,
  endStyle,
  disabled = false,
  onLineStyleChange,
  onEndStyleChange,
}: {
  lineStyle: Graph3DAxisLineStyle;
  endStyle: Graph3DAxisEndStyle;
  disabled?: boolean;
  onLineStyleChange: (value: Graph3DAxisLineStyle) => void;
  onEndStyleChange: (value: Graph3DAxisEndStyle) => void;
}) {
  const lineStyleButtonRef = useRef<HTMLButtonElement | null>(null);
  const [openMenu, setOpenMenu] = useState<"line" | "end" | null>(null);
  return (
    <Inline className={styles.axisStyleControls} gap="xs">
      <OverlayLineDashMenuButton<Graph3DAxisLineStyle>
        buttonRef={lineStyleButtonRef}
        currentValue={lineStyle}
        open={openMenu === "line"}
        disabled={disabled}
        onToggle={() => setOpenMenu((current) => current === "line" ? null : "line")}
        onSelect={(value) => {
          onLineStyleChange(value);
          setOpenMenu(null);
        }}
        popoverZIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      />
      <LineEndpointMenuButton
        endpoint="end"
        currentValue={endStyle}
        open={openMenu === "end"}
        disabled={disabled}
        onToggle={() => setOpenMenu((current) => current === "end" ? null : "end")}
        onSelect={(value) => {
          onEndStyleChange(value);
          setOpenMenu(null);
        }}
        popoverZIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      />
    </Inline>
  );
}

/**
 * The add tile for 3D objects, which opens the catalogue rather than adding one kind.
 *
 * The kinds are shown as cards drawn from the object each one creates: "媒介変数曲面" and
 * "F(x,y,z)=0 の曲面" name two ways of writing a surface, and a list of names alone left the
 * difference to be discovered by adding one and looking.
 */
function AddObjectCard({ onAdd }: { onAdd: (choice: string) => void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.addCard}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={17} aria-hidden="true" />
        <span>{tShape("graph3dUi.addObject")}</span>
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        className={styles.choicePopover}
        ariaLabel={tShape("graph3dUi.addObjectKind")}
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      >
        <Stack gap="sm">
          {buildGraph3DObjectChoiceGroups(tShape).map((group) => (
            <section key={group.title}>
              <h4 className={styles.choiceGroupTitle}>{group.title}</h4>
              <div className={styles.choiceGrid}>
                {group.choices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className={styles.choiceCard}
                    onClick={() => {
                      setOpen(false);
                      onAdd(choice.value);
                    }}
                  >
                    <ChoiceThumbnail choice={choice.value} />
                    <span>{choice.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </Stack>
      </ToolbarPopover>
    </>
  );
}

const CHOICE_THUMBNAIL_WIDTH = 96;
const CHOICE_THUMBNAIL_HEIGHT = 58;

/** Every catalogue card is the same drawing for the life of the app, so it is meshed once. */
const choiceDrawings = new Map<string, Graph3DThumbnailDrawing | null>();

function choiceThumbnailDrawing(choice: string): Graph3DThumbnailDrawing | null {
  const cached = choiceDrawings.get(choice);
  if (cached !== undefined) return cached;
  let drawing: Graph3DThumbnailDrawing | null = null;
  try {
    const object = createGraph3DObjectFromChoice(choice, tShape);
    if (object) {
      drawing = createGraph3DThumbnailDrawing(
        buildGraph3DObjectGeometry(createGraph3DThumbnailObject(object), {}),
        CHOICE_THUMBNAIL_WIDTH,
        CHOICE_THUMBNAIL_HEIGHT,
        5,
      );
    }
  } catch {
    drawing = null;
  }
  choiceDrawings.set(choice, drawing);
  return drawing;
}

function ChoiceThumbnail({ choice }: { choice: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    paintObjectThumbnail(
      canvasRef.current,
      choiceThumbnailDrawing(choice),
      "#64748b",
      CHOICE_THUMBNAIL_WIDTH,
      CHOICE_THUMBNAIL_HEIGHT,
    );
  }, [choice]);
  // The card's own name is right beside the picture, so the canvas stays out of the accessible
  // name: without this the button reads "球の概形 球".
  return (
    <span className={styles.choiceThumbnailFrame} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.choiceThumbnail} />
    </span>
  );
}

/** Compact summary plus the same hover/focus action surface used by 2D graph items. */
/**
 * memo が効くのは、変わっていない要素の再描画を止めるため。カード1枚あたり数式入力を
 * 複数持つので、スライダー1目盛りで全カードを作り直すと目に見えて重くなる。
 */
const ObjectEditor = memo(function ObjectEditor({
  object,
  variables,
  onChange,
  onDelete,
}: {
  object: Graph3DObject;
  variables: MathExpressionVariables;
  onChange: (objectId: string, updater: (object: Graph3DObject) => Graph3DObject) => void;
  onDelete: (objectId: string) => void;
}) {
  const update = (updater: (object: Graph3DObject) => Graph3DObject) => onChange(object.id, updater);
  const patch = <Kind extends Graph3DObject["kind"]>(
    kind: Kind,
    updater: (object: Extract<Graph3DObject, { kind: Kind }>) => Graph3DObject,
  ) => update((current) => current.kind === kind
    ? updater(current as Extract<Graph3DObject, { kind: Kind }>)
    : current);
  const primaryFormulaControls = (() => {
    switch (object.kind) {
      case "implicitSurface":
        // 等式の欄。`F(x,y,z) = 0` と書かれた欄に `x^2+y^2+z^2=1` が入っていて、しかもその値を
        // 確定し直すと「=」を外せと言われる状態だった (欄の mode が expression だった)。
        return <ExpressionField mode="equation" label={tShape("graph3dUi.surfaceEquation")} value={object.expression} onChange={(expression) => patch("implicitSurface", (current) => ({ ...current, expression }))} />;
      case "parametricSurface":
        return <div className={styles.compactFormulaGrid}>
          <ExpressionField label="x(u,v)" value={object.x} onChange={(x) => patch("parametricSurface", (current) => ({ ...current, x }))} />
          <ExpressionField label="y(u,v)" value={object.y} onChange={(y) => patch("parametricSurface", (current) => ({ ...current, y }))} />
          <ExpressionField label="z(u,v)" value={object.z} onChange={(z) => patch("parametricSurface", (current) => ({ ...current, z }))} />
        </div>;
      case "parametricCurve":
        return <div className={styles.compactFormulaGrid}>
          <ExpressionField label={`x(${object.parameter})`} value={object.x} onChange={(x) => patch("parametricCurve", (current) => ({ ...current, x }))} />
          <ExpressionField label={`y(${object.parameter})`} value={object.y} onChange={(y) => patch("parametricCurve", (current) => ({ ...current, y }))} />
          <ExpressionField label={`z(${object.parameter})`} value={object.z} onChange={(z) => patch("parametricCurve", (current) => ({ ...current, z }))} />
        </div>;
      case "solidOfRevolution":
        return <ExpressionField label={tShape("graph3dUi.crossSectionEquation")} value={object.radius} onChange={(radius) => patch("solidOfRevolution", (current) => ({ ...current, radius }))} />;
      case "plane":
        return object.plane.kind === "equation"
          ? <ExpressionField mode="equation" label={tShape("graph3dUi.planeEquation")} value={object.plane.expression} onChange={(expression) => patch("plane", (current) => ({ ...current, plane: { kind: "equation", expression } }))} />
          : null;
      default:
        return null;
    }
  })();

  return (
    <GraphWidgetCard
      label={tShape("graph3dFormat.details", { name: object.name ?? objectKindLabel(object.kind) })}
      openDetailsOnCardHover
      visibility={{
        visible: object.visible !== false,
        onChange: (visible) => update((current) => ({ ...current, visible })),
      }}
      title={(
        <input
          className={styles.titleInput}
          aria-label={tShape("graph3dUi.objectName")}
          value={object.name ?? objectKindLabel(object.kind)}
          onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
        />
      )}
      summary={(
        <ObjectThumbnail
          object={object}
          variables={variables}
          caption={objectPrimaryFormulaTex(object)}
        />
      )}
      controls={primaryFormulaControls}
    >
      <ObjectStyleRow object={object} onChange={update} />
      {object.kind === "implicitSurface" && (
        <>
          <BoundsFields label={tShape("graph3dUi.calculationRange")} bounds={object.bounds} onChange={(bounds) => patch("implicitSurface", (current) => ({ ...current, bounds }))} />
          <NumberField label={tShape("graph3dUi.plotCount")} value={object.resolution ?? 20} min={4} max={MAX_SCALAR_FIELD_RESOLUTION} step={1} onChange={(resolution) => patch("implicitSurface", (current) => ({ ...current, resolution: Math.round(resolution) }))} />
        </>
      )}
      {object.kind === "parametricSurface" && (
        <>
          <RangeFields label={tShape("graph3dUi.uRange")} variableTex="u" range={object.u} onChange={(u) => patch("parametricSurface", (current) => ({ ...current, u }))} />
          <RangeFields label={tShape("graph3dUi.vRange")} variableTex="v" range={object.v} onChange={(v) => patch("parametricSurface", (current) => ({ ...current, v }))} />
          <NumberField label={tShape("graph3dUi.plotCount")} value={Math.max(object.u.samples ?? 36, object.v.samples ?? 36)} min={2} max={256} step={1} onChange={(samples) => patch("parametricSurface", (current) => ({
            ...current,
            u: { ...current.u, samples: Math.round(samples) },
            v: { ...current.v, samples: Math.round(samples) },
          }))} />
        </>
      )}
      {object.kind === "parametricCurve" && (
        <>
          <label className={styles.field}><span>{tShape("graph3dUi.parameterLabel")}</span><input value={object.parameter} onChange={(event) => patch("parametricCurve", (current) => ({ ...current, parameter: event.target.value }))} /></label>
          <RangeFields label={tShape("graph3dFormat.range", { name: object.parameter })} variableTex={object.parameter} range={object.range} onChange={(range) => patch("parametricCurve", (current) => ({ ...current, range }))} />
          <NumberField label={tShape("graph3dUi.plotCount")} value={object.range.samples ?? 36} min={2} max={256} step={1} onChange={(samples) => patch("parametricCurve", (current) => ({ ...current, range: { ...current.range, samples: Math.round(samples) } }))} />
        </>
      )}
      {object.kind === "solidOfRevolution" && (
        <>
          <p className={styles.axisHint}>{tShape("graph3dUi.revolutionRadiusHint", { parameter: revolutionAxisParameter(object.axis) })}</p>
          <div className={styles.field}>
            <span>{tShape("graph3dUi.revolutionAxis")}</span>
            <Select
              aria-label={tShape("graph3dUi.revolutionAxis")}
              value={typeof object.axis === "string" ? object.axis : "planeIntersection"}
              options={[
                { value: "x", label: tShape("graph3dUi.axisX") },
                { value: "y", label: tShape("graph3dUi.axisY") },
                { value: "z", label: tShape("graph3dUi.axisZ") },
                { value: "planeIntersection", label: tShape("graph3dUi.axisTwoPlanes") },
              ]}
              onChange={(axis) => patch("solidOfRevolution", (current) => {
                const nextAxis = axis === "planeIntersection"
                  ? { kind: "planeIntersection" as const, equations: ["x = y", "z = 0"] as [string, string], parameter: "t" }
                  : axis as "x" | "y" | "z";
                return {
                  ...current,
                  axis: nextAxis,
                  radius: replaceGraph3DParameter(
                    current.radius,
                    revolutionAxisParameter(current.axis),
                    revolutionAxisParameter(nextAxis),
                  ),
                };
              })}
            />
          </div>
          {typeof object.axis !== "string" && (
            <>
              <ExpressionField mode="equation" label={tShape("graph3dUi.axisFirstPlane")} value={object.axis.equations[0]} onChange={(expression) => patch("solidOfRevolution", (current) => typeof current.axis === "string" ? current : ({ ...current, axis: { ...current.axis, equations: [expression, current.axis.equations[1]] } }))} />
              <ExpressionField mode="equation" label={tShape("graph3dUi.axisSecondPlane")} value={object.axis.equations[1]} onChange={(expression) => patch("solidOfRevolution", (current) => typeof current.axis === "string" ? current : ({ ...current, axis: { ...current.axis, equations: [current.axis.equations[0], expression] } }))} />
              <label className={styles.field}><span>{tShape("graph3dUi.axisParameter")}</span><input value={object.axis.parameter ?? "t"} onChange={(event) => patch("solidOfRevolution", (current) => {
                if (typeof current.axis === "string") return current;
                const parameter = event.target.value.trim() || "t";
                return {
                  ...current,
                  axis: { ...current.axis, parameter },
                  radius: replaceGraph3DParameter(current.radius, revolutionAxisParameter(current.axis), parameter),
                };
              })} /></label>
              <p className={styles.axisHint}>{tShape("graph3dUi.axisTwoPlanesExample")}</p>
            </>
          )}
          <RangeFields label={tShape("graph3dFormat.range", { name: revolutionAxisParameter(object.axis) })} variableTex={revolutionAxisParameter(object.axis)} range={object.axisRange} onChange={(axisRange) => patch("solidOfRevolution", (current) => ({ ...current, axisRange }))} />
          <div className={styles.compactGrid}>
            <NumberField label={tShape("graph3dUi.axialPlotCount")} value={object.axisRange.samples ?? 36} min={2} max={256} step={1} onChange={(samples) => patch("solidOfRevolution", (current) => ({ ...current, axisRange: { ...current.axisRange, samples: Math.round(samples) } }))} />
            <NumberField label={tShape("graph3dUi.angularPlotCount")} value={object.angleRange?.samples ?? 48} min={3} max={256} step={1} onChange={(samples) => patch("solidOfRevolution", (current) => ({ ...current, angleRange: { ...(current.angleRange ?? { min: "0", max: "2*pi" }), samples: Math.round(samples) } }))} />
          </div>
        </>
      )}
      {object.kind === "primitive" && (
        <>
          <div className={styles.field}>
            <span>{tShape("graph3dUi.primitiveKind")}</span>
            <Select
              aria-label={tShape("graph3dUi.primitiveKind")}
              value={object.primitive}
              options={[
                { value: "box", label: tShape("graph3dUi.primitiveBox") },
                { value: "sphere", label: tShape("graph3dUi.primitiveSphere") },
                { value: "cylinder", label: tShape("graph3dUi.primitiveCylinder") },
                { value: "cone", label: tShape("graph3dUi.primitiveCone") },
              ]}
              onChange={(primitive) => patch("primitive", (current) => ({ ...current, primitive: primitive as typeof current.primitive }))}
            />
          </div>
          <VectorGrid
            rows={[
              { label: tShape("graph3dUi.center"), vector: object.center, onChange: (center) => patch("primitive", (current) => ({ ...current, center })) },
              { label: tShape("graph3dUi.size"), vector: object.size, onChange: (size) => patch("primitive", (current) => ({ ...current, size })) },
            ]}
          />
          {object.primitive !== "box" && (
            <>
              <NumberField
                label={tShape("graph3dUi.plotCount")}
                value={graph3DPrimitiveRingSamples(
                  primitiveRadius(object, variables),
                  object.resolution,
                )}
                min={MIN_PRIMITIVE_RING_SAMPLES}
                max={MAX_PRIMITIVE_RING_SAMPLES}
                step={1}
                onChange={(resolution) => patch("primitive", (current) => ({
                  ...current,
                  resolution: Math.round(resolution),
                }))}
              />
              <p className={styles.axisHint}>
                {object.resolution === undefined
                  ? tShape("graph3dUi.sizeAutoHint")
                  : tShape("graph3dUi.sizeAutoRestoreHint")}
              </p>
              {object.resolution !== undefined && (
                <Button
                  size="sm"
                  onClick={() => patch("primitive", (current) => {
                    // Removed, not set to `undefined`: an absent count is what "follows the
                    // radius" means, and a key holding `undefined` is not the same document.
                    const next = { ...current };
                    delete next.resolution;
                    return next;
                  })}
                >
                  {tShape("graph3dUi.matchRadius")}
                </Button>
              )}
            </>
          )}
        </>
      )}
      {object.kind === "boundedSolid" && (
        <>
          <InequalityFields
            label={tShape("graph3dUi.boundingInequalities")}
            inequalities={object.inequalities}
            onChange={(inequalities) => patch("boundedSolid", (current) => ({ ...current, inequalities }))}
          />
          <BoundsFields label={tShape("graph3dUi.searchBounds")} bounds={object.bounds} onChange={(bounds) => patch("boundedSolid", (current) => ({ ...current, bounds }))} />
          <NumberField
            label={tShape("graph3dUi.plotCount")}
            value={graph3DBoundedSolidResolution(object)}
            min={8}
            max={MAX_SCALAR_FIELD_RESOLUTION}
            step={1}
            onChange={(resolution) => patch("boundedSolid", (current) => ({ ...current, resolution: Math.round(resolution) }))}
          />
          <p className={styles.axisHint}>
            {tShape("graph3dUi.plotCountExplainer")}
          </p>
        </>
      )}
      {object.kind === "polyhedron" && (
        <>
          <VectorGrid
            rows={object.vertices.map((vertex, index) => ({
              label: tShape("graph3dFormat.vertex", { index }),
              vector: vertex,
              onChange: (nextVertex: Graph3DExpressionVector3) => patch("polyhedron", (current) => ({
                ...current,
                vertices: current.vertices.map((candidate, candidateIndex) => candidateIndex === index ? nextVertex : candidate),
              })),
            }))}
          />
          <label className={styles.field}>
            <span>{tShape("graph3dUi.facesInput")}</span>
            <textarea
              rows={4}
              value={object.faces.map((face) => face.join(",")).join("\n")}
              onChange={(event) => patch("polyhedron", (current) => ({
                ...current,
                faces: parsePolyhedronFaces(event.target.value, current.faces),
              }))}
            />
          </label>
        </>
      )}
      {object.kind === "point" && (
        <>
          <VectorGrid rows={[{ label: tShape("graph3dUi.coordinates"), vector: object.position, onChange: (position) => patch("point", (current) => ({ ...current, position })) }]} />
          <NumberField label={tShape("graph3dUi.pointSize")} value={object.radius ?? 0.08} min={0.01} max={1} step={0.01} onChange={(radius) => patch("point", (current) => ({ ...current, radius }))} />
        </>
      )}
      {object.kind === "segment" && (
        <VectorGrid
          rows={[
            { label: tShape("graph3dUi.startPoint"), vector: object.from, onChange: (from) => patch("segment", (current) => ({ ...current, from })) },
            { label: tShape("graph3dUi.endPoint"), vector: object.to, onChange: (to) => patch("segment", (current) => ({ ...current, to })) },
          ]}
        />
      )}
      {object.kind === "plane" && (
        <>
          <div className={styles.field}>
            <span>{tShape("graph3dUi.definitionMethod")}</span>
            <Select
              aria-label={tShape("graph3dUi.planeDefinitionMethod")}
              value={object.plane.kind}
              options={[
                { value: "equation", label: tShape("graph3dUi.equation") },
                { value: "threePoints", label: tShape("graph3dUi.threePoints") },
                { value: "pointNormal", label: tShape("graph3dUi.pointAndNormal") },
              ]}
              onChange={(kind) => patch("plane", (current) => ({ ...current, plane: createGraph3DPlaneDefinition(kind) }))}
            />
          </div>
          {object.plane.kind === "threePoints" && (
            <VectorGrid
              rows={object.plane.points.map((point, index) => ({
                label: tShape("graph3dFormat.point", { index: index + 1 }),
                vector: point,
                onChange: (nextPoint: Graph3DExpressionVector3) => patch("plane", (current) => {
                  if (current.plane.kind !== "threePoints") return current;
                  const points = [...current.plane.points];
                  points[index] = nextPoint;
                  return { ...current, plane: { kind: "threePoints", points: points as typeof current.plane.points } };
                }),
              }))}
            />
          )}
          {object.plane.kind === "pointNormal" && (
            <VectorGrid
              rows={[
                { label: tShape("graph3dUi.pointOnPlane"), vector: object.plane.point, onChange: (point) => patch("plane", (current) => current.plane.kind === "pointNormal" ? { ...current, plane: { ...current.plane, point } } : current) },
                { label: tShape("graph3dUi.normal"), vector: object.plane.normal, onChange: (normal) => patch("plane", (current) => current.plane.kind === "pointNormal" ? { ...current, plane: { ...current.plane, normal } } : current) },
              ]}
            />
          )}
        </>
      )}
      {object.kind !== "point" && object.kind !== "segment" && (
        <fieldset className={styles.fieldset}>
          <legend>{tShape("graph3dUi.placementSection")}</legend>
          <VectorGrid
            rows={[
              { label: tShape("graph3dUi.translation"), vector: object.translation ?? vector("0", "0", "0"), onChange: (translation) => update((current) => ({ ...current, translation })) },
              { label: tShape("graph3dUi.scale"), vector: object.scale ?? vector("1", "1", "1"), onChange: (scale) => update((current) => ({ ...current, scale })) },
              { label: tShape("graph3dUi.rotation"), vector: object.rotation ?? vector("0", "0", "0"), onChange: (rotation) => update((current) => ({ ...current, rotation })) },
            ]}
          />
          <p className={styles.axisHint}>{tShape("graph3dUi.rotationRadiansHint")}</p>
        </fieldset>
      )}
      <Button tone="danger" size="sm" onClick={() => onDelete(object.id)}>
        <Trash2 size={14} /> {tShape("graph3dUi.deleteObject")}
      </Button>
    </GraphWidgetCard>
  );
});

/**
 * A small, geometry-backed overview for each authored object.
 *
 * It shades the same evaluated mesh the renderer uses instead of showing a generic icon, so two
 * differently authored solids stay distinguishable side by side. Painting happens on a canvas:
 * a shaded solid is hundreds of polygons, and putting those in the DOM made every parameter tick
 * rebuild hundreds of SVG nodes per card.
 */
const ObjectThumbnail = memo(function ObjectThumbnail({
  object,
  variables,
  caption,
}: {
  object: Graph3DObject;
  variables: MathExpressionVariables;
  caption: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useMemo(() => {
    try {
      const geometry = buildGraph3DObjectGeometry(createGraph3DThumbnailObject(object), variables);
      return createGraph3DThumbnailDrawing(geometry, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    } catch {
      return null;
    }
  }, [object, variables]);
  const color = object.style?.color ?? "#64748b";

  useEffect(() => {
    paintObjectThumbnail(canvasRef.current, drawing, color);
  }, [color, drawing]);

  const empty = !drawing || (
    drawing.faces.length === 0 && drawing.polylines.length === 0 && drawing.points.length === 0
  );
  return (
    <div className={styles.objectOverview}>
      <div className={styles.objectThumbnailFrame}>
        <canvas
          ref={canvasRef}
          className={styles.objectThumbnail}
          role="img"
          aria-label={tShape("graph3dFormat.outline", { name: object.name || objectKindLabel(object.kind) })}
        />
        {empty && <span className={styles.objectThumbnailFallback}>3D</span>}
      </div>
      <div className={styles.objectOverviewText}>
        <span className={styles.widgetSummary}>{objectKindLabel(object.kind)}</span>
        {caption && <MathPreview className={styles.objectFormula} tex={caption} />}
      </div>
    </div>
  );
});

const THUMBNAIL_WIDTH = 132;
const THUMBNAIL_HEIGHT = 86;

function paintObjectThumbnail(
  canvas: HTMLCanvasElement | null,
  drawing: Graph3DThumbnailDrawing | null,
  color: string,
  width = THUMBNAIL_WIDTH,
  height = THUMBNAIL_HEIGHT,
): void {
  if (!canvas) return;
  const ratio = Math.min(3, Math.max(1, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  // jsdom and headless capture paths have no 2D context; the card still shows its text summary.
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!drawing) return;

  context.lineJoin = "round";
  context.lineCap = "round";
  context.strokeStyle = "rgba(100, 116, 139, 0.28)";
  context.lineWidth = 0.6;
  for (const [from, to] of drawing.floor) {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }

  for (const face of drawing.faces) {
    const shaded = shadeThumbnailColor(color, face.shade);
    context.fillStyle = shaded;
    // Stroking each face with its own colour closes the hairline seams antialiasing leaves.
    context.strokeStyle = shaded;
    context.lineWidth = 0.5;
    context.beginPath();
    face.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.fill();
    context.stroke();
  }

  context.strokeStyle = color;
  context.lineWidth = 1.4;
  for (const polyline of drawing.polylines) {
    context.beginPath();
    polyline.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  }

  context.fillStyle = color;
  for (const point of drawing.points) {
    context.beginPath();
    context.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
    context.fill();
  }
}

/**
 * Lightens or darkens the object colour by how much a face faces the light.
 *
 * Keeping the hue and scaling brightness separates neighbouring faces clearly; mixing toward
 * white and black instead washed a flat-sided solid into one grey shape.
 */
function shadeThumbnailColor(color: string, shade: number): string {
  const match = /^#([0-9a-f]{6})$/iu.exec(color.trim());
  const channels = match
    ? [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16))
    : [100, 116, 139];
  const factor = 0.45 + 0.95 * Math.max(0, Math.min(1, shade));
  const lit = channels.map((channel) => Math.round(Math.min(255, channel * factor)));
  return `rgb(${lit[0]}, ${lit[1]}, ${lit[2]})`;
}

function objectPrimaryFormulaTex(object: Graph3DObject): string | null {
  switch (object.kind) {
    case "implicitSurface":
      return graph3DExpressionToTex(object.expression, "equation");
    case "parametricCurve":
      return `(${graph3DExpressionToTex(object.x, "expression")},${graph3DExpressionToTex(object.y, "expression")},${graph3DExpressionToTex(object.z, "expression")})`;
    case "parametricSurface":
      return `(${graph3DExpressionToTex(object.x, "expression")},${graph3DExpressionToTex(object.y, "expression")},${graph3DExpressionToTex(object.z, "expression")})`;
    case "solidOfRevolution":
      return `r=${graph3DExpressionToTex(object.radius, "expression")}`;
    case "point":
      return `(${graph3DExpressionToTex(object.position.x, "expression")},${graph3DExpressionToTex(object.position.y, "expression")},${graph3DExpressionToTex(object.position.z, "expression")})`;
    case "segment":
      return `${objectPrimaryPointTex(object.from)}\\mathbin{-}${objectPrimaryPointTex(object.to)}`;
    case "plane":
      return object.plane.kind === "equation" ? graph3DExpressionToTex(object.plane.expression, "equation") : null;
    case "boundedSolid":
      return object.inequalities[0] ? graph3DExpressionToTex(object.inequalities[0], "inequality") : null;
    default:
      return null;
  }
}

function objectPrimaryPointTex(point: Graph3DExpressionVector3): string {
  return `(${graph3DExpressionToTex(point.x, "expression")},${graph3DExpressionToTex(point.y, "expression")},${graph3DExpressionToTex(point.z, "expression")})`;
}

/**
 * 「図形Aと図形Bの共通部分をこの色で塗る」を1枚のカードにしたもの。
 *
 * 切断面と違って何も切り落とさない。立体どうしなら共有する体積を、平面を混ぜたなら共有する面を、
 * 平面どうしなら交線や交点を、中身のない曲面なら輪郭を出す。どれになったかはプレビューに出る。
 */
const IntersectionEditor = memo(function IntersectionEditor({
  region,
  objects,
  variables,
  onChange,
  onDelete,
  onInsertImage,
  onInsertSpec,
}: {
  region: Graph3DObjectIntersectionRegion;
  objects: Graph3DObject[];
  variables: MathExpressionVariables;
  onChange: (
    regionId: string,
    updater: (region: Graph3DObjectIntersectionRegion) => Graph3DObjectIntersectionRegion,
  ) => void;
  onDelete: (regionId: string) => void;
  onInsertImage: (regionId: string) => void;
  onInsertSpec: (regionId: string) => void;
}) {
  const update = (updater: (region: Graph3DObjectIntersectionRegion) => Graph3DObjectIntersectionRegion) => (
    onChange(region.id, updater)
  );
  // 「塗らない」状態は表示チェックで表すので、色や透明度の編集は常に塗りのある形で扱う。
  const fill = resolveIntersectionFill(region);
  const patchFill = (patch: { color?: string; opacity?: number }) => update((current) => ({
    ...current,
    fill: { ...resolveIntersectionFill(current), ...patch },
  }));
  const members = useMemo(
    () => region.objectIds
      .map((objectId) => objects.find((object) => object.id === objectId))
      .filter((object): object is Graph3DObject => object !== undefined),
    [objects, region.objectIds],
  );
  const label = region.label || tShape("graph3d.intersectionFallback");
  // 形の判定はカード1枚につき一度だけ。プレビューと2つの挿入ボタンが同じ答えを見る。
  const result = useGraph3DIntersectionResult(members, variables, region.resolution);
  // 平面図として本文に置けるのは、共通部分が平面になったときだけ。
  const canInsertImage = result.kind === "section";

  const toggleMember = (objectId: string, selected: boolean) => update((current) => ({
    ...current,
    objectIds: selected
      ? [...current.objectIds.filter((id) => id !== objectId), objectId]
      : current.objectIds.filter((id) => id !== objectId),
  }));

  return (
    <GraphWidgetCard
      label={tShape("graph3dFormat.details", { name: label })}
      openDetailsOnCardHover
      visibility={{
        visible: region.visible !== false,
        onChange: (visible) => update((current) => ({ ...current, visible })),
      }}
      title={(
        <input
          className={styles.titleInput}
          aria-label={tShape("graph3dUi.intersectionName")}
          value={label}
          onChange={(event) => update((current) => ({ ...current, label: event.target.value }))}
        />
      )}
      summary={<IntersectionPreview result={result} color={fill.color} />}
    >
      <fieldset className={styles.fieldset}>
        <legend>{tShape("graph3dUi.appearance")}</legend>
        <div className={styles.styleRow}>
          <ColorField label={tShape("graph3dUi.fillColor")} value={fill.color} onChange={(color) => patchFill({ color })} />
          <NumberField
            label={tShape("graph3dUi.opacity")}
            value={fill.opacity ?? 0.55}
            min={0}
            max={1}
            step={0.05}
            onChange={(opacity) => patchFill({ opacity })}
          />
          <CheckboxField
            label={tShape("graph3dUi.outline")}
            checked={region.showEdges !== false}
            onChange={(showEdges) => update((current) => ({ ...current, showEdges }))}
          />
          <ColorField
            label={tShape("graph3dUi.outlineColor")}
            value={region.edgeColor ?? fill.color}
            disabled={region.showEdges === false}
            onChange={(edgeColor) => update((current) => ({ ...current, edgeColor }))}
          />
        </div>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend>{tShape("graph3dUi.intersectionShapes")}</legend>
        <Stack className={styles.memberList} gap="xs">
          {objects.length === 0 && <EmptyHint>{tShape("graph3dUi.intersectionShapesEmpty")}</EmptyHint>}
          {objects.map((object) => (
            <CheckboxField
              key={object.id}
              label={object.name || objectKindLabel(object.kind)}
              checked={region.objectIds.includes(object.id)}
              onChange={(selected) => toggleMember(object.id, selected)}
            />
          ))}
        </Stack>
      </fieldset>
      <div className={styles.quickControlGrid}>
        <div className={styles.field}>
          <span>{tShape("graph3dUi.fillStyle")}</span>
          <Select
            aria-label={tShape("graph3dUi.intersectionFillStyle")}
            value={fill.mode}
            options={[
              { value: "solid", label: tShape("graph3dUi.fillSolid") },
              { value: "pattern", label: tShape("graph3dUi.fillHatching") },
            ]}
            onChange={(mode) => update((current) => {
              const previous = resolveIntersectionFill(current);
              const next = createGraph3DSectionFill(mode as "solid" | "pattern", previous.color);
              // 塗り方を変えても、選んだ濃さは持ち越す。
              return { ...current, fill: next.mode === "none" ? next : { ...next, opacity: previous.opacity } };
            })}
          />
        </div>
        <NumberField
          label={tShape("graph3dUi.plotCount")}
          value={region.resolution ?? 26}
          min={8}
          max={MAX_SCALAR_FIELD_RESOLUTION}
          step={1}
          onChange={(resolution) => update((current) => ({ ...current, resolution: Math.round(resolution) }))}
        />
      </div>
      <fieldset className={styles.fieldset}>
        <legend>{tShape("graph3dUi.insertIntoDocument")}</legend>
        <Inline gap="xs" wrap>
          <Button
            size="sm"
            disabled={!canInsertImage}
            onClick={() => onInsertImage(region.id)}
          >
            <ImageDown size={14} /> {tShape("graph3dUi.insertPlaneAsImage")}
          </Button>
          <Button
            size="sm"
            disabled={result.kind === "empty" || result.kind === "error"}
            onClick={() => onInsertSpec(region.id)}
          >
            <Box size={14} /> {tShape("graph3dUi.insertIntersectionAs3d")}
          </Button>
        </Inline>
        {!canInsertImage && (
          <EmptyHint>{tShape("graph3dUi.insertImageOnlyPlanar")}</EmptyHint>
        )}
      </fieldset>
      <p className={styles.axisHint}>
        {tShape("graph3dUi.intersectionResultExplainer")}
      </p>
      <Button tone="danger" size="sm" onClick={() => onDelete(region.id)}>
        <Trash2 size={14} /> {tShape("graph3dUi.deleteIntersection")}
      </Button>
    </GraphWidgetCard>
  );
});

function resolveIntersectionFill(
  region: Graph3DObjectIntersectionRegion,
): Extract<Graph3DFillStyle, { mode: "solid" | "pattern" }> {
  return region.fill.mode === "none"
    ? { mode: "solid", color: "#d97706", opacity: 0.55 }
    : region.fill;
}

type Graph3DIntersectionResult =
  | { kind: Graph3DIntersectionGeometry["kind"]; status: string; drawing: Graph3DThumbnailDrawing | null }
  | { kind: "error"; status: string; drawing: null };

function intersectionStatus(kind: Graph3DIntersectionGeometry["kind"]): string {
  return tShape(({
    empty: "graph3dUi.sharedNone",
    solid: "graph3dUi.sharedVolume",
    section: "graph3dUi.sharedPlane",
    surface: "graph3dUi.sharedSurfaceArea",
    curve: "graph3dUi.sharedLine",
    points: "graph3dUi.sharedPoint",
  } as const)[kind]);
}

/** 何を共有しているのかを一度だけ判定する。プレビューと挿入ボタンで答えがずれないように。 */
function useGraph3DIntersectionResult(
  members: Graph3DObject[],
  variables: MathExpressionVariables,
  resolution: number | undefined,
): Graph3DIntersectionResult {
  // ステータスは翻訳済み文字列で持つので、表示言語もこの答えの入力に含める。
  const locale = useAppLocale();
  return useMemo(() => {
    if (members.length < 2) {
      return { kind: "error" as const, status: tShape("graph3dUi.selectTwoShapes"), drawing: null };
    }
    try {
      const geometry = getGraph3DIntersectionGeometry(members, variables, {
        ...(resolution === undefined ? {} : { resolution }),
      });
      return {
        kind: geometry.kind,
        status: intersectionStatus(geometry.kind),
        drawing: createGraph3DThumbnailDrawing(
          getGraph3DIntersectionMesh(geometry),
          THUMBNAIL_WIDTH,
          THUMBNAIL_HEIGHT,
        ),
      };
    } catch (error) {
      return {
        kind: "error" as const,
        status: graph3DModelErrorMessage(error) ?? tShape("graph3dUi.intersectionFailed"),
        drawing: null,
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 文言はモジュール翻訳子で引くため、表示言語が答えの入力になる
  }, [members, resolution, variables, locale]);
}

function graph3DModelErrorMessage(error: unknown): string | null {
  if (error instanceof Graph3DModelError) {
    const params = error.code === "commonPartObjectHasNoSurfaceOrInterior" && !error.params?.name
      ? { ...error.params, name: tShape("graph3dError.commonPartObjectFallbackName") }
      : error.params;
    return tShape(`graph3dError.${error.code}` as never, params);
  }
  return error instanceof Error ? error.message : null;
}

/** Shows what the members actually share, so an empty overlap is obvious before printing. */
const IntersectionPreview = memo(function IntersectionPreview({
  result,
  color,
}: {
  result: Graph3DIntersectionResult;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    paintObjectThumbnail(canvasRef.current, result.drawing, color);
  }, [color, result.drawing]);

  return (
    <div className={styles.objectOverview}>
      <div className={styles.objectThumbnailFrame}>
        <canvas
          ref={canvasRef}
          className={styles.objectThumbnail}
          role="img"
          aria-label={tShape("graph3dUi.intersectionPreview")}
        />
        {!result.drawing && <span className={styles.objectThumbnailFallback}>—</span>}
      </div>
      <div className={styles.objectOverviewText}>
        <span className={styles.widgetSummary}>{result.status}</span>
      </div>
    </div>
  );
});

/**
 * ラベルを持たない数式入力。読めない TeX は本文へ確定させず、下書きのまま理由を出す。
 * 範囲や不等式のように「1行の中に数式が複数並ぶ」場所から使う。
 */
function ExpressionValueInput({
  mode = "expression",
  ariaLabel,
  className,
  placeholderTex,
  testId,
  value,
  onChange,
}: {
  mode?: Graph3DExpressionMode;
  ariaLabel: string;
  className?: string;
  placeholderTex?: string;
  testId?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const tShape = useT("shape");
  const errorId = useId();
  const [draftTex, setDraftTex] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const previousValueRef = useRef(value);

  useEffect(() => {
    if (previousValueRef.current === value) return;
    previousValueRef.current = value;
    setDraftTex(null);
    setErrorReason(null);
  }, [value]);

  const commit = (tex: string) => {
    const result = parseGraph3DExpressionTex(tex, mode, tShape);
    if ("error" in result) {
      setDraftTex(tex);
      setErrorReason(result.error);
      return;
    }
    setDraftTex(null);
    setErrorReason(null);
    onChange(result.expression);
  };

  return (
    <>
      <MathExpressionInput
        tex={draftTex ?? graph3DExpressionToTex(value, mode)}
        ariaLabel={ariaLabel}
        className={className}
        placeholderTex={placeholderTex ?? DEFAULT_PLACEHOLDER_TEX[mode]}
        invalid={draftTex !== null}
        ariaDescribedBy={errorReason ? errorId : undefined}
        data-testid={testId}
        onCommit={commit}
      />
      {errorReason && <span id={errorId} className={styles.expressionError}>{errorReason}</span>}
    </>
  );
}

const DEFAULT_PLACEHOLDER_TEX: Record<Graph3DExpressionMode, string> = {
  expression: "x^2+y^2",
  equation: "x+y=1",
  inequality: "x+y+z \\leqq 3",
};

function ExpressionField({
  mode = "expression",
  label,
  value,
  onChange,
}: {
  mode?: Graph3DExpressionMode;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <ExpressionValueInput
        mode={mode}
        ariaLabel={label}
        testId={`graph3d-expression-${toTestId(label)}`}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

function toTestId(label: string): string {
  return label.replace(/[^a-zA-Z0-9\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

/**
 * 範囲は「2つの数値」ではなく1つの不等式として見せる。教材に出てくる形
 * (`-2 \leqq x \leqq 2`) とそのまま対応し、どちらが下限か迷わない。
 */
function RangeFields(props: {
  label: string;
  variableTex: string;
  range: Graph3DExpressionRange;
  onChange: (range: Graph3DExpressionRange) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>{props.label}</legend>
      <RangeRow {...props} />
    </fieldset>
  );
}

/** The inequality on its own, for the places that already carry a heading of their own. */
function RangeRow({
  label,
  variableTex,
  range,
  onChange,
}: {
  label: string;
  variableTex: string;
  range: Graph3DExpressionRange;
  onChange: (range: Graph3DExpressionRange) => void;
}) {
  return (
    <div className={styles.relationRow}>
      <ExpressionValueInput
        ariaLabel={tShape("graph3dFormat.minimum", { label })}
        className={styles.compactExpression}
        placeholderTex="-2"
        value={range.min}
        onChange={(min) => onChange({ ...range, min })}
      />
      <MathPreview className={styles.relationSymbol} tex={`\\leqq ${variableTex} \\leqq`} />
      <ExpressionValueInput
        ariaLabel={tShape("graph3dFormat.maximum", { label })}
        className={styles.compactExpression}
        placeholderTex="2"
        value={range.max}
        onChange={(max) => onChange({ ...range, max })}
      />
    </div>
  );
}

/**
 * 不等式で立体を囲む入力。1本の不等式は1つの数式欄に丸ごと書く
 * (`x+y+z \leqq 3`)。左辺・不等号・右辺に割ると枠が3つ並んで場所を取るうえ、
 * 教材に出てくる形と見た目が変わる。読み取れない書きかけは下書きのまま理由を出す。
 */
function InequalityFields({
  label,
  inequalities,
  onChange,
}: {
  label: string;
  inequalities: string[];
  onChange: (inequalities: string[]) => void;
}) {
  const replaceAt = (index: number, next: string) => onChange(
    inequalities.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate),
  );
  return (
    <fieldset className={styles.fieldset}>
      <legend>{label}</legend>
      <Stack gap="xs">
        <div className={styles.inequalitySystem}>
          <span
            aria-hidden="true"
            className={styles.inequalityBrace}
            data-testid="graph3d-inequality-brace"
            style={{ fontSize: `${Math.max(44, inequalities.length * 34)}px` }}
          >{"{"}</span>
          <Stack gap="xs">
            {inequalities.map((inequality, index) => (
              <InequalityRow
                key={index}
                index={index}
                value={inequality}
                onChange={(next) => {
                  const parts = next.split(/[,;、]/u).map((part) => part.trim()).filter(Boolean);
                  if (parts.length > 1) {
                    onChange([
                      ...inequalities.slice(0, index),
                      ...parts,
                      ...inequalities.slice(index + 1),
                    ]);
                    return;
                  }
                  replaceAt(index, next);
                }}
                onDelete={inequalities.length > 1
                  ? () => onChange(inequalities.filter((_, candidateIndex) => candidateIndex !== index))
                  : undefined}
              />
            ))}
          </Stack>
        </div>
        <Button size="sm" onClick={() => onChange([...inequalities, "x >= 0"])}>
          <Plus size={14} /> {tShape("graph3dUi.addInequality")}
        </Button>
      </Stack>
    </fieldset>
  );
}

function InequalityRow({
  index,
  value,
  onChange,
  onDelete,
}: {
  index: number;
  value: string;
  onChange: (value: string) => void;
  onDelete?: () => void;
}) {
  const rowLabel = tShape("graph3dFormat.inequality", { index: index + 1 });
  return (
    <div className={styles.relationRow}>
      <ExpressionValueInput
        mode="inequality"
        ariaLabel={rowLabel}
        className={styles.compactExpression}
        testId={`graph3d-inequality-${index + 1}`}
        value={value}
        onChange={onChange}
      />
      {onDelete && (
        <IconButton label={tShape("graph3dFormat.deleteNamed", { name: rowLabel })} size="sm" tone="ghost" onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      )}
    </div>
  );
}

interface Graph3DVectorRow {
  label: string;
  vector: Graph3DExpressionVector3;
  onChange: (vector: Graph3DExpressionVector3) => void;
}

/**
 * Several vectors as one table: the names down the side, x/y/z across the top.
 *
 * One boxed vector per line was three lines of chrome for three numbers, and a solid's details
 * carry up to four of them (position, size, and the move/scale/turn triple). Sharing one header
 * row is what keeps a details popover from running past the bottom of the screen.
 */
function VectorGrid({ rows }: { rows: Graph3DVectorRow[] }) {
  return (
    <div className={styles.vectorGrid}>
      <span aria-hidden="true" />
      {(["x", "y", "z"] as const).map((axis) => (
        <MathPreview key={axis} className={styles.vectorAxisHeading} tex={axis} />
      ))}
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span className={styles.vectorRowLabel}>{row.label}</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <ExpressionValueInput
              key={axis}
              ariaLabel={tShape("graph3dFormat.coordinate", { label: row.label, axis })}
              className={styles.compactExpression}
              placeholderTex="0"
              testId={`graph3d-vector-${toTestId(row.label)}-${axis}`}
              value={row.vector[axis]}
              onChange={(value) => row.onChange({ ...row.vector, [axis]: value })}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Colour, transparency and the wireframe pair on one line.
 *
 * They are the same decision — what this solid looks like — and stacked they were four rows with
 * the wireframe colour appearing and disappearing as the box was ticked, which moved everything
 * below it.
 */
function ObjectStyleRow({
  object,
  onChange,
}: {
  object: Graph3DObject;
  onChange: (updater: (object: Graph3DObject) => Graph3DObject) => void;
}) {
  const wireframe = object.style?.wireframe === true;
  return (
    <fieldset className={styles.fieldset}>
      <legend>{tShape("graph3dUi.appearance")}</legend>
      <div className={styles.styleRow}>
        <ColorField
          label={tShape("graph3dUi.color")}
          value={object.style?.color ?? "#64748b"}
          onChange={(color) => onChange((current) => ({ ...current, style: { ...current.style, color } }))}
        />
        <NumberField
          label={tShape("graph3dUi.opacity")}
          value={object.style?.opacity ?? 0.72}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) => onChange((current) => ({ ...current, style: { ...current.style, opacity } }))}
        />
        <CheckboxField
          label={tShape("graph3dUi.wireframe")}
          checked={wireframe}
          onChange={(next) => onChange((current) => ({ ...current, style: { ...current.style, wireframe: next } }))}
        />
        <ColorField
          label={tShape("graph3dUi.wireframeColor")}
          value={object.style?.wireframeColor ?? "#1f2933"}
          disabled={!wireframe}
          onChange={(wireframeColor) => onChange((current) => ({ ...current, style: { ...current.style, wireframeColor } }))}
        />
      </div>
    </fieldset>
  );
}

function BoundsFields({
  label,
  bounds,
  onChange,
}: {
  label: string;
  bounds: Graph3DBounds;
  onChange: (bounds: Graph3DBounds) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>{label}</legend>
      <Stack gap="xs">
        {(["x", "y", "z"] as const).map((axis) => (
          <RangeRow
            key={axis}
            label={tShape("graph3dFormat.range", { name: axis })}
            variableTex={axis}
            range={bounds[axis]}
            onChange={(range) => onChange({ ...bounds, [axis]: range })}
          />
        ))}
      </Stack>
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = "any",
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | "any";
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  /** Kept in place rather than hidden: a control that comes and goes moves everything under it. */
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const safeValue = /^#[0-9a-f]{6}$/iu.test(value) ? value : "#64748b";
  return (
    <div className={styles.colorField}>
      <span>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        className={styles.colorButton}
        aria-label={tShape("graph3dFormat.choose", { label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.colorSwatch} style={{ backgroundColor: safeValue }} aria-hidden="true" />
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <ToolbarPopover
        open={open && !disabled}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        className="color-popover"
        ariaLabel={label}
        zIndex={GRAPH_SETTINGS_POPOVER_Z_INDEX}
      >
        <ColorPalette
          value={value}
          onChange={(color) => {
            if (color) onChange(color);
            setOpen(false);
          }}
        />
      </ToolbarPopover>
    </div>
  );
}

/**
 * 入力欄そのものが数式として見えるので、同じ式をプレビューとしてもう一度出さない
 * (「TeX表示」と「表示する数式」で同じラベルが2回並んで見えていた)。
 */
const AnnotationEditor = memo(function AnnotationEditor({
  annotation,
  onChange,
  onDelete,
}: {
  annotation: Graph3DAnnotation;
  onChange: (annotation: Graph3DAnnotation) => void;
  onDelete: (annotationId: string) => void;
}) {
  return (
    <GraphWidgetCard
      label={tShape("graph3dFormat.details", { name: annotation.kind === "dimension" ? tShape("graph3dUi.dimensionLine") : tShape("graph3dUi.mathLabel") })}
      title={<strong>{annotation.kind === "dimension" ? tShape("graph3dUi.dimensionLine") : tShape("graph3dUi.mathLabel")}</strong>}
      summary={(
        <MathExpressionInput
          tex={annotation.labelTex}
          ariaLabel={tShape("graph3dUi.labelFormula")}
          placeholderTex="\ell"
          onCommit={(labelTex) => onChange({ ...annotation, labelTex })}
        />
      )}
      controls={annotation.kind === "dimension" ? (
        <Inline className={styles.dimensionStyle} gap="sm" wrap align="end">
          <LineStyleButtons
            lineStyle={annotation.lineStyle ?? "solid"}
            endStyle={resolveGraph3DDimensionEndStyle(annotation.endStyle)}
            onLineStyleChange={(lineStyle) => onChange({ ...annotation, lineStyle })}
            onEndStyleChange={(endStyle) => onChange({ ...annotation, endStyle })}
          />
          <NumberField
            label={tShape("graph3dUi.lineWidth")}
            value={annotation.lineWidth ?? 1.5}
            min={0.5}
            max={12}
            step={0.5}
            onChange={(lineWidth) => onChange({ ...annotation, lineWidth })}
          />
        </Inline>
      ) : undefined}
    >
      <ColorField label={tShape("graph3dUi.textAndLineColor")} value={annotation.color ?? "#1f2937"} onChange={(color) => onChange({ ...annotation, color })} />
      {annotation.kind === "label" ? (
        <VectorGrid rows={[{ label: tShape("graph3dUi.showCoordinates"), vector: annotation.position, onChange: (position) => onChange({ ...annotation, position }) }]} />
      ) : (
        <VectorGrid
          rows={[
            { label: tShape("graph3dUi.startPoint"), vector: annotation.from, onChange: (from) => onChange({ ...annotation, from }) },
            { label: tShape("graph3dUi.endPoint"), vector: annotation.to, onChange: (to) => onChange({ ...annotation, to }) },
          ]}
        />
      )}
      <Button tone="danger" size="sm" onClick={() => onDelete(annotation.id)}>
        <Trash2 size={14} /> {tShape("graph3dUi.deleteAnnotation")}
      </Button>
    </GraphWidgetCard>
  );
});

function CheckboxField({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.checkbox}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

function createDefaultAnnotation(kind: Graph3DAnnotation["kind"]): Graph3DAnnotation {
  if (kind === "dimension") {
    return {
      id: createId("graph3d_annotation"),
      kind,
      from: vector("0", "0", "0"),
      to: vector("0", "0", "1"),
      labelTex: "1",
      color: "#1f2937",
    };
  }
  return {
    id: createId("graph3d_annotation"),
    kind,
    position: vector("0", "0", "0"),
    labelTex: "A",
    color: "#1f2937",
  };
}

function objectKindLabel(kind: Graph3DObject["kind"]): string {
  return ({ implicitSurface: tShape("graph3dUi.kindImplicitSurface"), parametricCurve: tShape("graph3dUi.kindSpaceCurve"), parametricSurface: tShape("graph3dUi.kindParametricSurface"), primitive: tShape("graph3dUi.kindPrimitive"), solidOfRevolution: tShape("graph3dUi.kindRevolution"), polyhedron: tShape("graph3dUi.kindPolyhedron"), boundedSolid: tShape("graph3dUi.kindBoundedSolid"), point: tShape("graph3dUi.kindPoint"), segment: tShape("graph3dUi.kindSegment"), plane: tShape("graph3dUi.kindPlane") })[kind];
}

/** The half-extent the segment count follows — the same one the mesh builder measures. */
function primitiveRadius(
  object: Extract<Graph3DObject, { kind: "primitive" }>,
  variables: MathExpressionVariables,
): number {
  const half = (expression: string) => {
    try {
      return Math.abs(evaluateMathExpression(expression, variables)) / 2;
    } catch {
      return 0;
    }
  };
  const x = half(object.size.x);
  const y = half(object.size.y);
  const z = half(object.size.z);
  return object.primitive === "sphere" ? Math.max(x, y, z) : Math.max(x, y);
}

function revolutionAxisParameter(
  axis: Extract<Graph3DObject, { kind: "solidOfRevolution" }>["axis"],
): string {
  return typeof axis === "string" ? axis : axis.parameter?.trim() || "t";
}

function replaceGraph3DParameter(expression: string, from: string, to: string): string {
  if (from === to) return expression;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return expression.replace(new RegExp(`\\b${escaped}\\b`, "gu"), to);
}

function parsePolyhedronFaces(value: string, fallback: number[][]): number[][] {
  const faces = value.split("\n").filter((line) => line.trim()).map((line) => (
    line.split(",").map((part) => Number(part.trim()))
  ));
  return faces.length > 0 && faces.every((face) => (
    face.length >= 3 && face.every((index) => Number.isInteger(index) && index >= 0)
  ))
    ? faces
    : fallback;
}
