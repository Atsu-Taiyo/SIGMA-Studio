"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Group,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Camera,
  type Intersection,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useT } from "@/lib/i18n/react";

import {
  getGraph3DAxisColors,
  type Graph3DAxisColors,
  type Graph3DCamera,
  type Graph3DExpressionVector3,
  type Graph3DObject,
  type Graph3DSpec,
  type Graph3DViewSettings,
} from "@/features/document";
import {
  addGraph3DLocalAxisRotation,
  buildGraph3DAnimationTimeline,
  graph3DAnimationMaxFrames,
  graph3DAnimationSupersample,
  graph3DHasPageAnimation,
  graph3DPointerRotationStep,
  buildGraph3DSceneGeometry,
  createGraph3DRenderSpec,
  evaluateGraph3DObjectRotation,
  evaluateGraph3DObjectScale,
  evaluateGraph3DObjectTranslation,
  graph3DEulerToMatrix,
  graph3DObjectTransformedOrigin,
  graph3DRotationExpression,
  graph3DVectorExpression,
  getGraph3DPreviewSourceHash,
  snapGraph3DRotationAngle,
  type Graph3DPoint3,
  type Graph3DSceneGeometry,
  type Graph3DRenderQuality,
  type MathExpressionVariables,
} from "@/features/drawing";
import {
  createGraph3DDisplayAnnotations,
  encodeApng,
  projectGraph3DLabel,
  type ApngAnimationFrame,
  type Graph3DDisplayAnnotation,
} from "@/features/rendering/core";
import { EDITOR_ZOOM_CHANGE_EVENT } from "../editor-zoom-event";

import {
  addThreeGraph3DLights,
  applyThreeGraph3DView,
  createThreeGraph3DCamera,
  updateThreeGraph3DCameraAspect,
  createThreeGraph3DGroup,
  createThreeGraph3DObjectGizmo,
  disposeThreeGraph3DGroup,
  updateThreeGraph3DGroup,
} from "../three";
import { MathPreview } from "./MathPreview";

/**
 * The derived PNG is re-encoded and written into the document, so it is captured only once the
 * scene has settled. Dragging a parameter slider or playing an animation produces a change every
 * few milliseconds, and capturing each one dominated editing cost.
 */
const PREVIEW_CAPTURE_IDLE_MS = 180;

/**
 * Zoom paints the document through a CSS transform, which leaves the canvas' layout size — and
 * therefore its drawing buffer — untouched. A 1:1 buffer is resampled up by the browser as soon as
 * the document is zoomed in, so both the live canvas and the derived PNG are rendered above the
 * display density: the buffer follows the painted scale, and the capture is taken at a fixed
 * supersample so a static shape keeps its detail at whatever zoom (or print DPI) it is shown at.
 */
const MIN_RENDER_PIXEL_RATIO = 2;
const MAX_RENDER_PIXEL_RATIO = 4;
const PREVIEW_CAPTURE_SUPERSAMPLE = 3;
/** The PNG is stored in the document, so the supersample is traded away on very large shapes. */
const MAX_PREVIEW_CAPTURE_PIXELS = 6_000_000;

/** Painted size ÷ layout size: every ancestor transform and CSS zoom folded into one number. */
function readPaintedScale(element: HTMLElement): number {
  const layoutWidth = element.offsetWidth;
  if (!layoutWidth) return 1;
  const scale = element.getBoundingClientRect().width / layoutWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Drawing-buffer pixels per CSS pixel for the live canvas, at the scale it is actually painted. */
export function graph3DDisplayPixelRatio(devicePixelRatio: number, paintedScale: number): number {
  const value = devicePixelRatio * paintedScale;
  if (!Number.isFinite(value)) return MIN_RENDER_PIXEL_RATIO;
  return Math.min(MAX_RENDER_PIXEL_RATIO, Math.max(MIN_RENDER_PIXEL_RATIO, value));
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === "undefined") return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => resolve(typeof reader.result === "string" ? reader.result : null),
      { once: true },
    );
    reader.addEventListener("error", () => resolve(null), { once: true });
    reader.readAsDataURL(blob);
  });
}

/** Capture pixels per document pixel, traded down so a large shape's PNG stays a sane size. */
export function graph3DCaptureSupersample(width: number, height: number): number {
  const byPixelBudget = Math.sqrt(MAX_PREVIEW_CAPTURE_PIXELS / Math.max(1, width * height));
  return Math.max(1, Math.min(PREVIEW_CAPTURE_SUPERSAMPLE, byPixelBudget));
}

interface Graph3DThreeRuntime {
  scene: Scene;
  camera: Camera;
  controls: OrbitControls;
  graphGroup: Group;
  gizmoGroup: Group | null;
  geometry: Graph3DSceneGeometry;
  quality: Graph3DRenderQuality;
  render: () => void;
  scheduleCapture: () => void;
  captureNow: () => void;
  cancelCapture: () => void;
  /** Takes the animated capture that was skipped while the settings panel had it deferred. */
  flushDeferredAnimationCapture: () => void;
}

export interface Graph3DPreviewProps {
  spec: Graph3DSpec;
  className?: string;
  interactive?: boolean;
  parameterOverrides?: MathExpressionVariables;
  /** Transient parameter playback never writes derived PNGs or lowers persisted output quality. */
  animationPlaying?: boolean;
  /**
   * Holds back the animated capture while the material's settings panel is open.
   *
   * Taking it plays the whole loop through the live canvas, so every colour or slider change
   * made in the panel flashed the animation in the body. The shape simply stays marked stale
   * until the panel closes, which is also what keeps this window mounted until then.
   */
  deferAnimationCapture?: boolean;
  onCameraChange?: (camera: Graph3DCamera) => void;
  onObjectRotationChange?: (objectId: string, rotation: Graph3DExpressionVector3) => void;
  onObjectTransformChange?: (
    objectId: string,
    transform: Pick<Graph3DObject, "rotation" | "translation" | "scale">,
  ) => void;
  onInteractionChange?: (interacting: boolean) => void;
  onPreviewReady?: (
    dataUrl: string,
    size: { width: number; height: number },
    sourceHash: string,
    options: { animated: boolean },
  ) => void;
}

export function Graph3DPreview({
  spec,
  className,
  interactive = false,
  parameterOverrides,
  animationPlaying = false,
  deferAnimationCapture = false,
  onCameraChange,
  onObjectRotationChange,
  onObjectTransformChange,
  onInteractionChange,
  onPreviewReady,
}: Graph3DPreviewProps) {
  const tShape = useT("shape");
  const viewportRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onCameraChange, onObjectRotationChange, onObjectTransformChange, onInteractionChange, onPreviewReady });
  const specRef = useRef(spec);
  const selectedObjectIdRef = useRef<string | null>(null);
  const runtimeRef = useRef<Graph3DThreeRuntime | null>(null);
  const cameraSpecRef = useRef(spec.camera);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const cameraInteractingRef = useRef(false);
  const animationPlayingRef = useRef(animationPlaying);
  animationPlayingRef.current = animationPlaying;
  const deferAnimationCaptureRef = useRef(deferAnimationCapture);
  deferAnimationCaptureRef.current = deferAnimationCapture;
  // Label positions are written straight to the DOM. They change on every orbit frame, and
  // routing them through React state re-rendered every KaTeX label 60 times a second.
  const labelElementsRef = useRef(new Map<string, HTMLSpanElement>());
  const appliedViewRef = useRef<{ view: Graph3DViewSettings; axisColors: Graph3DAxisColors } | null>(null);
  // Keep one tessellation level for the whole playback. Switching levels in response to frame
  // time changed the mesh topology back and forth, which looked like objects flashing in place.
  const effectiveQuality: Graph3DRenderQuality = animationPlaying ? "balanced" : "full";
  const renderSpec = useMemo(
    () => createGraph3DRenderSpec(spec, effectiveQuality),
    [effectiveQuality, spec],
  );
  const sceneGeometry = useMemo(
    () => buildGraph3DSceneGeometry(renderSpec, parameterOverrides),
    [parameterOverrides, renderSpec],
  );
  const axisColors = useMemo(() => getGraph3DAxisColors(spec.view), [spec.view]);
  const viewRef = useRef(spec.view);
  const axisColorsRef = useRef(axisColors);
  const displayAnnotations = useMemo<Graph3DDisplayAnnotation[]>(
    () => createGraph3DDisplayAnnotations(spec, sceneGeometry.annotations, axisColors),
    [axisColors, sceneGeometry, spec],
  );
  const displayAnnotationsRef = useRef(displayAnnotations);
  const cameraProjection = spec.camera.projection;

  const registerLabelElement = useCallback((id: string, element: HTMLSpanElement | null) => {
    if (element) labelElementsRef.current.set(id, element);
    else labelElementsRef.current.delete(id);
  }, []);

  useEffect(() => {
    callbacksRef.current = { onCameraChange, onObjectRotationChange, onObjectTransformChange, onInteractionChange, onPreviewReady };
  }, [onCameraChange, onObjectRotationChange, onObjectTransformChange, onInteractionChange, onPreviewReady]);

  useEffect(() => {
    specRef.current = spec;
  }, [spec]);

  useEffect(() => {
    cameraSpecRef.current = spec.camera;
  }, [spec.camera]);

  // 宣言順に走るので、下の生成 effect が読むときには最新になっている。
  useEffect(() => {
    viewRef.current = spec.view;
    axisColorsRef.current = axisColors;
  }, [axisColors, spec.view]);

  useEffect(() => {
    displayAnnotationsRef.current = displayAnnotations;
    runtimeRef.current?.render();
    runtimeRef.current?.scheduleCapture();
  }, [displayAnnotations]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: false,
        stencil: true,
        preserveDrawingBuffer: Boolean(callbacksRef.current.onPreviewReady),
        powerPreference: "high-performance",
      });
    } catch (error) {
      queueMicrotask(() => {
        setRuntimeError(error instanceof Error ? error.message : tShape("graph3d.webglFailed"));
      });
      return;
    }

    queueMicrotask(() => setRuntimeError(null));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(MIN_RENDER_PIXEL_RATIO);
    renderer.domElement.className = "graph3d-preview-canvas";
    viewport.append(renderer.domElement);

    const threeScene = new Scene();
    const initialCamera = cameraSpecRef.current;
    const camera = createThreeGraph3DCamera(initialCamera, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(initialCamera.target.x, initialCamera.target.y, initialCamera.target.z);
    controls.enabled = interactive;
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.update();

    addThreeGraph3DLights(threeScene);
    applyThreeGraph3DView(threeScene, viewRef.current, axisColorsRef.current);
    appliedViewRef.current = { view: viewRef.current, axisColors: axisColorsRef.current };
    const graphGroup = createThreeGraph3DGroup(sceneGeometry);
    threeScene.add(graphGroup);

    const projected = new Vector3();
    const positionLabels = () => {
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      for (const annotation of displayAnnotationsRef.current) {
        const element = labelElementsRef.current.get(annotation.id);
        if (!element) continue;
        projected.set(annotation.position.x, annotation.position.y, annotation.position.z);
        projected.project(camera);
        const visible = projected.z >= -1 && projected.z <= 1;
        element.style.visibility = visible ? "visible" : "hidden";
        if (!visible) continue;
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      }
    };
    const render = () => {
      renderer.render(threeScene, camera);
      positionLabels();
    };

    let captureGeneration = 0;
    let disposed = false;
    const captureStill = (generation: number) => {
      const gizmo = runtimeRef.current?.gizmoGroup;
      if (gizmo) gizmo.visible = false;
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      // The capture is deliberately taken above the display density: it is what an unselected
      // shape shows at any zoom and on paper, long after this canvas is gone.
      const supersample = graph3DCaptureSupersample(width, height);
      const displayRatio = renderer.getPixelRatio();
      const supersampled = supersample > displayRatio;
      try {
        if (supersampled) {
          renderer.setPixelRatio(supersample);
          renderer.setSize(width, height, false);
          renderer.render(threeScene, camera);
        }
        // Labels remain a TeX DOM layer in both interactive and static views. Baking a plain-text
        // fallback into the PNG made an unselected shape lose fractions, roots, and superscripts.
        const renderedParameters = runtimeRef.current?.geometry.parameters ?? {};
        const renderedSpec: Graph3DSpec = {
          ...specRef.current,
          parameters: specRef.current.parameters.map((parameter) => ({
            ...parameter,
            value: renderedParameters[parameter.name] ?? parameter.value,
          })),
        };
        const size = { width: renderer.domElement.width, height: renderer.domElement.height };
        const sourceHash = getGraph3DPreviewSourceHash(renderedSpec);
        const deliver = (dataUrl: string) => {
          if (generation !== captureGeneration) return;
          callbacksRef.current.onPreviewReady?.(dataUrl, size, sourceHash, { animated: false });
        };
        // PNG encoding is expensive at the supersampled size. `toBlob` lets the browser encode
        // asynchronously, leaving pointer and animation frames responsive.
        if (typeof renderer.domElement.toBlob === "function" && typeof FileReader !== "undefined") {
          renderer.domElement.toBlob((blob) => {
            if (!blob) return;
            const reader = new FileReader();
            reader.addEventListener("load", () => {
              if (typeof reader.result === "string") deliver(reader.result);
            }, { once: true });
            reader.readAsDataURL(blob);
          }, "image/png");
        } else {
          deliver(renderer.domElement.toDataURL("image/png"));
        }
      } catch {
        // Preview caching is derived and optional; the live scene remains usable.
      } finally {
        if (gizmo) gizmo.visible = true;
        if (supersampled) {
          renderer.setPixelRatio(displayRatio);
          renderer.setSize(width, height, false);
          render();
        }
      }
    };

    /**
     * Writes the material as an animated PNG: one frame per sampled instant of the authored
     * animation, the first of which doubles as the plain picture print and the SVG export read.
     *
     * The scene itself is stepped through the animation to take the frames — the live canvas plays
     * the loop once while it is captured — and is put back on the authored geometry afterwards.
     */
    const captureAnimation = async (generation: number) => {
      const runtime = runtimeRef.current;
      if (!runtime) return false;
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      const timeline = buildGraph3DAnimationTimeline(specRef.current, {
        maxFrames: graph3DAnimationMaxFrames(width, height),
      });
      if (!timeline) return false;
      // The hash is taken before the first await: the pixels below belong to *this* spec, and a
      // later edit must not be able to label them as its own.
      const sourceHash = getGraph3DPreviewSourceHash(specRef.current);
      const captureSpec = createGraph3DRenderSpec(specRef.current, "full");
      const supersample = graph3DAnimationSupersample(width, height, timeline.frames.length);
      const gizmo = runtime.gizmoGroup;
      const displayRatio = renderer.getPixelRatio();
      const authoredGeometry = runtime.geometry;
      let paintedGeometry = authoredGeometry;
      const paint = (geometry: Graph3DSceneGeometry) => {
        if (geometry !== paintedGeometry) {
          updateThreeGraph3DGroup(runtime.graphGroup, paintedGeometry, geometry);
          paintedGeometry = geometry;
        }
        renderer.render(threeScene, camera);
      };
      try {
        if (gizmo) gizmo.visible = false;
        renderer.setPixelRatio(supersample);
        renderer.setSize(width, height, false);
        // The drawing buffer, not the requested size, decides the frame size: `setSize` rounds.
        const pixelWidth = renderer.domElement.width;
        const pixelHeight = renderer.domElement.height;
        const scratch = document.createElement("canvas");
        scratch.width = pixelWidth;
        scratch.height = pixelHeight;
        const context = scratch.getContext("2d", { willReadFrequently: true });
        if (!context) return false;
        const readFrame = (): Uint8Array<ArrayBuffer> => {
          context.drawImage(renderer.domElement, 0, 0, pixelWidth, pixelHeight);
          const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight).data;
          return new Uint8Array(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength);
        };
        const frames: ApngAnimationFrame[] = [];
        for (const frame of timeline.frames) {
          if (disposed || generation !== captureGeneration) return true;
          paint(buildGraph3DSceneGeometry(captureSpec, frame.overrides));
          frames.push({ data: readFrame(), delayMs: frame.delayMs });
          // Hand the main thread back between frames so typing and pointer work stay responsive.
          await new Promise((resolve) => { setTimeout(resolve, 0); });
        }
        if (disposed || generation !== captureGeneration) return true;
        const bytes = await encodeApng({ width: pixelWidth, height: pixelHeight, frames });
        if (disposed || generation !== captureGeneration) return true;
        const dataUrl = await blobToDataUrl(new Blob([bytes], { type: "image/png" }));
        if (!dataUrl || disposed || generation !== captureGeneration) return true;
        callbacksRef.current.onPreviewReady?.(
          dataUrl,
          { width: pixelWidth, height: pixelHeight },
          sourceHash,
          { animated: true },
        );
        return true;
      } catch {
        // No animated picture is a reason to fall back to the still one, never to lose the scene.
        return false;
      } finally {
        if (!disposed) {
          // Back to whatever is authoritative *now*, not to what was authoritative when the
          // capture started: an edit landing mid-capture already ran the geometry effect against
          // `runtime.geometry`, which does not describe the frame currently in the scene. Only a
          // diff taken from the painted frame puts every object back in agreement.
          const target = runtimeRef.current?.geometry ?? authoredGeometry;
          if (paintedGeometry !== target) {
            updateThreeGraph3DGroup(runtime.graphGroup, paintedGeometry, target);
          }
          if (gizmo) gizmo.visible = true;
          renderer.setPixelRatio(displayRatio);
          renderer.setSize(width, height, false);
          render();
        }
      }
    };

    let animationCaptureBusy = false;
    const runAnimationCapture = () => {
      if (animationCaptureBusy) return;
      animationCaptureBusy = true;
      const generation = captureGeneration;
      void captureAnimation(generation)
        .then((handled) => {
          if (!handled && !disposed && generation === captureGeneration) captureStill(generation);
        })
        .finally(() => {
          animationCaptureBusy = false;
          // An edit that landed mid-capture left the frames behind; take them again, once.
          if (!disposed && captureGeneration !== generation) runAnimationCapture();
        });
    };

    // Set while an animated capture was skipped, so closing the panel takes the one it owes.
    let animationCaptureDeferred = false;
    const captureNow = () => {
      if (!callbacksRef.current.onPreviewReady) return;
      if (runtimeRef.current?.quality !== "full") return;
      const generation = ++captureGeneration;
      if (graph3DHasPageAnimation(specRef.current)) {
        if (disposed) return;
        if (deferAnimationCaptureRef.current) {
          // Nothing is written: the shape stays stale, so this window stays mounted and the
          // body shows the scene it already has instead of the loop being re-baked into it.
          animationCaptureDeferred = true;
          return;
        }
        animationCaptureDeferred = false;
        runAnimationCapture();
        return;
      }
      animationCaptureDeferred = false;
      captureStill(generation);
    };
    const flushDeferredAnimationCapture = () => {
      if (!animationCaptureDeferred || disposed) return;
      captureNow();
    };
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCapture = () => {
      if (!callbacksRef.current.onPreviewReady || animationPlayingRef.current) return;
      if (captureTimer !== null) clearTimeout(captureTimer);
      captureTimer = setTimeout(() => {
        captureTimer = null;
        captureNow();
      }, PREVIEW_CAPTURE_IDLE_MS);
    };
    const cancelCapture = () => {
      if (captureTimer === null) return;
      clearTimeout(captureTimer);
      captureTimer = null;
    };

    const runtime: Graph3DThreeRuntime = {
      scene: threeScene,
      camera,
      controls,
      graphGroup,
      gizmoGroup: null,
      geometry: sceneGeometry,
      quality: effectiveQuality,
      render,
      scheduleCapture,
      captureNow,
      cancelCapture,
      flushDeferredAnimationCapture,
    };
    runtimeRef.current = runtime;
    // The buffer follows the painted scale, so orbiting a zoomed-in 3D object stays as sharp as
    // the display allows instead of being resampled up from its layout size.
    const resize = () => {
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      const pixelRatio = graph3DDisplayPixelRatio(
        globalThis.devicePixelRatio || 1,
        readPaintedScale(viewport),
      );
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      updateThreeGraph3DCameraAspect(camera, width / height);
      render();
    };
    const handleInteractionStart = () => {
      cameraInteractingRef.current = true;
      callbacksRef.current.onInteractionChange?.(true);
    };
    const handleInteractionEnd = () => {
      cameraInteractingRef.current = false;
      callbacksRef.current.onInteractionChange?.(false);
      callbacksRef.current.onCameraChange?.(readThreeGraph3DCamera(camera, controls, cameraSpecRef.current));
      render();
      scheduleCapture();
    };
    controls.addEventListener("change", render);
    controls.addEventListener("start", handleInteractionStart);
    controls.addEventListener("end", handleInteractionEnd);

    const pointer = createGraph3DObjectPointerController({
      camera,
      controls,
      viewport,
      runtimeRef,
      specRef,
      selectedObjectIdRef,
      callbacksRef,
      axisColorsRef,
      render,
    });
    if (interactive) {
      renderer.domElement.addEventListener("pointerdown", pointer.onPointerDown);
      renderer.domElement.addEventListener("pointermove", pointer.onPointerMove);
      renderer.domElement.addEventListener("pointerup", pointer.onPointerUp);
      renderer.domElement.addEventListener("pointerleave", pointer.onPointerUp);
    }

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(resize);
    resizeObserver?.observe(viewport);
    globalThis.addEventListener?.("resize", resize);
    globalThis.addEventListener?.(EDITOR_ZOOM_CHANGE_EVENT, resize);
    resize();
    // The first frame is captured straight away: a placed 3D object needs its derived image
    // before anything else can show it. Only subsequent updates are debounced.
    captureNow();

    return () => {
      controls.removeEventListener("change", render);
      controls.removeEventListener("start", handleInteractionStart);
      controls.removeEventListener("end", handleInteractionEnd);
      renderer.domElement.removeEventListener("pointerdown", pointer.onPointerDown);
      renderer.domElement.removeEventListener("pointermove", pointer.onPointerMove);
      renderer.domElement.removeEventListener("pointerup", pointer.onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", pointer.onPointerUp);
      controls.dispose();
      resizeObserver?.disconnect();
      globalThis.removeEventListener?.("resize", resize);
      globalThis.removeEventListener?.(EDITOR_ZOOM_CHANGE_EVENT, resize);
      if (captureTimer !== null) {
        // Flush before the context goes away, or the last edit never reaches the stored preview.
        // An animated capture spans several frames and cannot finish here; the shape stays marked
        // stale instead, which keeps the live view mounted until it has been taken again.
        clearTimeout(captureTimer);
        captureTimer = null;
        if (!graph3DHasPageAnimation(specRef.current)) captureStill(++captureGeneration);
      }
      disposed = true;
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      if (runtime.gizmoGroup) disposeThreeGraph3DGroup(runtime.gizmoGroup);
      disposeThreeGraph3DGroup(runtime.graphGroup);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // `sceneGeometry` seeds the first frame only; later changes are swapped in by the effect
    // below, which must not tear the WebGL context down. Same for every `view` setting: they
    // each own an update effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraProjection, interactive]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (animationPlaying) runtime.cancelCapture();
    else runtime.scheduleCapture();
  }, [animationPlaying]);

  useEffect(() => {
    if (deferAnimationCapture) return;
    runtimeRef.current?.flushDeferredAnimationCapture();
  }, [deferAnimationCapture]);

  // Background, grid and axes are swapped in place. Recreating the renderer for them cost a
  // WebGL context per colour-picker step, and browsers only keep a handful alive.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const applied = appliedViewRef.current;
    if (applied && applied.view === spec.view && applied.axisColors === axisColors) return;
    appliedViewRef.current = { view: spec.view, axisColors };
    applyThreeGraph3DView(runtime.scene, spec.view, axisColors);
    runtime.render();
    runtime.scheduleCapture();
  }, [axisColors, spec.view]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.camera instanceof OrthographicCamera !== (spec.camera.projection === "orthographic")) {
      return;
    }
    // While OrbitControls owns the camera, unrelated spec writes (adding/removing an object or an
    // animation tick being saved) may echo the last persisted camera. Applying that stale value
    // mid-drag makes the viewpoint jump. A semantically unchanged echo is skipped after the drag.
    if (cameraInteractingRef.current || graph3DCamerasApproximatelyEqual(
      readThreeGraph3DCamera(runtime.camera, runtime.controls, spec.camera),
      spec.camera,
    )) return;
    runtime.camera.position.set(spec.camera.position.x, spec.camera.position.y, spec.camera.position.z);
    runtime.camera.up.set(spec.camera.up.x, spec.camera.up.y, spec.camera.up.z);
    runtime.controls.target.set(spec.camera.target.x, spec.camera.target.y, spec.camera.target.z);
    if (runtime.camera instanceof PerspectiveCamera) {
      runtime.camera.fov = spec.camera.fov ?? 45;
      runtime.camera.updateProjectionMatrix();
    } else if (runtime.camera instanceof OrthographicCamera) {
      runtime.camera.zoom = spec.camera.zoom ?? 1;
      runtime.camera.updateProjectionMatrix();
    }
    runtime.controls.update();
    runtime.render();
    runtime.scheduleCapture();
  }, [spec.camera]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.geometry === sceneGeometry) return;

    updateThreeGraph3DGroup(runtime.graphGroup, runtime.geometry, sceneGeometry);
    runtime.geometry = sceneGeometry;
    runtime.quality = effectiveQuality;
    syncGraph3DObjectGizmo(runtime, specRef.current, selectedObjectIdRef.current, axisColorsRef.current);
    runtime.render();
    runtime.scheduleCapture();
  }, [effectiveQuality, sceneGeometry]);

  const diagnostics = [
    ...sceneGeometry.issues.map((issue) => {
      if (!issue.code) return `${issue.id}: ${issue.message}`;
      const params = issue.code === "commonPartObjectHasNoSurfaceOrInterior" && !issue.params?.name
        ? { ...issue.params, name: tShape("graph3dError.commonPartObjectFallbackName") }
        : issue.params;
      return `${issue.id}: ${tShape(`graph3dError.${issue.code}` as never, params)}`;
    }),
    ...(runtimeError ? [runtimeError] : []),
  ];

  return (
    <div
      className={`graph3d-preview ${interactive ? "is-interactive" : "is-static"} ${className ?? ""}`}
      data-testid="graph3d-preview"
      aria-label={interactive ? tShape("graph3d.interactiveAria") : tShape("graph3d.previewAria")}
    >
      <div ref={viewportRef} className="graph3d-preview-viewport" />
      <div className="graph3d-annotation-overlay" data-graph3d-annotation-overlay="true" aria-hidden="true">
        {displayAnnotations.map((annotation) => (
          <span
            className="graph3d-annotation-label"
            data-graph3d-annotation-id={annotation.id}
            key={annotation.id}
            ref={(element) => registerLabelElement(annotation.id, element)}
            style={{ color: annotation.color ?? "#1f2937", visibility: "hidden" }}
          >
            <MathPreview tex={annotation.labelTex} />
          </span>
        ))}
      </div>
      {interactive && (
        <div className="graph3d-preview-help" aria-hidden="true">
          {tShape("graph3d.interactionHelp")}
        </div>
      )}
      {diagnostics.length > 0 && (
        <div className="graph3d-preview-diagnostics" role="status">
          {diagnostics.map((diagnostic) => <div key={diagnostic}>{diagnostic}</div>)}
        </div>
      )}
    </div>
  );
}

export function Graph3DStaticLabelOverlay({
  spec,
  width,
  height,
}: {
  spec: Graph3DSpec;
  width: number;
  height: number;
}) {
  const annotations = useMemo(() => {
    const geometry = buildGraph3DSceneGeometry(spec);
    return createGraph3DDisplayAnnotations(spec, geometry.annotations, getGraph3DAxisColors(spec.view));
  }, [spec]);
  const projected = useMemo(() => annotations.flatMap((annotation) => {
    const point = projectGraph3DLabel(annotation.position, spec.camera, width, height);
    return point ? [{ annotation, ...point }] : [];
  }), [annotations, height, spec.camera, width]);

  return (
    <div className="graph3d-annotation-overlay" data-graph3d-static-label-overlay="true" aria-hidden="true">
      {projected.map(({ annotation, x, y }) => (
        <span
          className="graph3d-annotation-label"
          data-graph3d-annotation-id={annotation.id}
          key={annotation.id}
          style={{ color: annotation.color ?? "#1f2937", left: x, top: y }}
        >
          <MathPreview tex={annotation.labelTex} />
        </span>
      ))}
    </div>
  );
}

function readThreeGraph3DCamera(
  camera: Camera,
  controls: OrbitControls,
  previous: Graph3DCamera,
): Graph3DCamera {
  return {
    projection: camera instanceof OrthographicCamera ? "orthographic" : "perspective",
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
    ...(camera instanceof PerspectiveCamera ? { fov: camera.fov } : {}),
    ...(camera instanceof OrthographicCamera ? { zoom: camera.zoom } : {}),
    ...(previous.fov !== undefined && camera instanceof OrthographicCamera ? { fov: previous.fov } : {}),
  };
}

function graph3DCamerasApproximatelyEqual(left: Graph3DCamera, right: Graph3DCamera): boolean {
  const close = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) <= 1e-7;
  const vectorClose = (a: Graph3DCamera["position"], b: Graph3DCamera["position"]) => (
    close(a.x, b.x) && close(a.y, b.y) && close(a.z, b.z)
  );
  return left.projection === right.projection
    && vectorClose(left.position, right.position)
    && vectorClose(left.target, right.target)
    && vectorClose(left.up, right.up)
    && close(left.fov, right.fov)
    && close(left.zoom, right.zoom);
}

function syncGraph3DObjectGizmo(
  runtime: Graph3DThreeRuntime,
  spec: Graph3DSpec,
  selectedObjectId: string | null,
  axisColors: Graph3DAxisColors,
): void {
  if (runtime.gizmoGroup) {
    runtime.scene.remove(runtime.gizmoGroup);
    disposeThreeGraph3DGroup(runtime.gizmoGroup);
    runtime.gizmoGroup = null;
  }
  const objectGroup = selectedObjectId
    ? runtime.graphGroup.getObjectByName(`graph3d-object-group:${selectedObjectId}`)
    : null;
  const object = selectedObjectId
    ? spec.objects.find((candidate) => candidate.id === selectedObjectId)
    : undefined;
  const item = selectedObjectId
    ? runtime.geometry.objects.find((candidate) => candidate.objectId === selectedObjectId)
    : undefined;
  if (!object || !objectGroup || !item || object.visible === false) return;
  const parameters = Object.fromEntries(spec.parameters.map((parameter) => [parameter.name, parameter.value]));
  const origin = graph3DObjectTransformedOrigin(object, item.geometry.positions, parameters);
  const rotation = evaluateGraph3DObjectRotation(object, parameters);
  const extent = gizmoExtent(item.geometry.positions, origin);
  const gizmo = createThreeGraph3DObjectGizmo(extent, axisColors);
  gizmo.position.set(origin.x, origin.y, origin.z);
  gizmo.userData.graph3dOrigin = origin;
  applyEulerToObject(gizmo, rotation);
  runtime.scene.add(gizmo);
  runtime.gizmoGroup = gizmo;
}

function gizmoExtent(positions: readonly Graph3DPoint3[], origin: Graph3DPoint3): number {
  let farthest = 0.8;
  for (const point of positions) {
    farthest = Math.max(
      farthest,
      Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z),
    );
  }
  return Math.min(3.2, Math.max(0.8, farthest * 0.55));
}

function applyPreviewObjectRotation(
  runtime: Graph3DThreeRuntime,
  objectId: string,
  origin: Graph3DPoint3,
  axis: Graph3DPoint3,
  angle: number,
): void {
  const group = runtime.graphGroup.getObjectByName(`graph3d-object-group:${objectId}`);
  if (!group) return;
  const quaternion = new Quaternion().setFromAxisAngle(
    new Vector3(axis.x, axis.y, axis.z).normalize(),
    angle,
  );
  const pivot = new Vector3(origin.x, origin.y, origin.z);
  group.quaternion.copy(quaternion);
  group.position.copy(pivot).sub(pivot.clone().applyQuaternion(quaternion));
}

function applyPreviewObjectTranslation(
  runtime: Graph3DThreeRuntime,
  objectId: string,
  translation: Graph3DPoint3,
): void {
  const group = runtime.graphGroup.getObjectByName(`graph3d-object-group:${objectId}`);
  if (!group) return;
  group.position.set(translation.x, translation.y, translation.z);
  if (runtime.gizmoGroup) {
    const origin = runtime.gizmoGroup.userData.graph3dOrigin as Graph3DPoint3 | undefined;
    if (origin) runtime.gizmoGroup.position.set(
      origin.x + translation.x,
      origin.y + translation.y,
      origin.z + translation.z,
    );
  }
}

function applyPreviewObjectScale(
  runtime: Graph3DThreeRuntime,
  objectId: string,
  origin: Graph3DPoint3,
  worldAxis: Graph3DPoint3,
  factor: number,
): void {
  const group = runtime.graphGroup.getObjectByName(`graph3d-object-group:${objectId}`);
  if (!group) return;
  const axis = new Vector3(worldAxis.x, worldAxis.y, worldAxis.z).normalize();
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), axis);
  const basis = new Matrix4().makeRotationFromQuaternion(quaternion);
  const inverseBasis = basis.clone().invert();
  const pivot = new Vector3(origin.x, origin.y, origin.z);
  group.matrixAutoUpdate = false;
  group.matrix.identity()
    .premultiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .premultiply(inverseBasis)
    .premultiply(new Matrix4().makeScale(factor, 1, 1))
    .premultiply(basis)
    .premultiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
  group.matrixWorldNeedsUpdate = true;
}

function resetPreviewObjectTransform(runtime: Graph3DThreeRuntime, objectId: string): void {
  const group = runtime.graphGroup.getObjectByName(`graph3d-object-group:${objectId}`);
  if (!group) return;
  group.matrixAutoUpdate = true;
  group.matrix.identity();
  group.quaternion.identity();
  group.position.set(0, 0, 0);
  group.scale.set(1, 1, 1);
}

function applyEulerToObject(object: Object3D, euler: Graph3DPoint3): void {
  const matrix = graph3DEulerToMatrix(euler);
  object.quaternion.setFromRotationMatrix(new Matrix4().set(
    matrix[0][0], matrix[0][1], matrix[0][2], 0,
    matrix[1][0], matrix[1][1], matrix[1][2], 0,
    matrix[2][0], matrix[2][1], matrix[2][2], 0,
    0, 0, 0, 1,
  ));
}

function createGraph3DObjectPointerController({
  camera,
  controls,
  viewport,
  runtimeRef,
  specRef,
  selectedObjectIdRef,
  callbacksRef,
  axisColorsRef,
  render,
}: {
  camera: Camera;
  controls: OrbitControls;
  viewport: HTMLDivElement;
  runtimeRef: { current: Graph3DThreeRuntime | null };
  specRef: { current: Graph3DSpec };
  selectedObjectIdRef: { current: string | null };
  callbacksRef: { current: Pick<Graph3DPreviewProps, "onCameraChange" | "onObjectRotationChange" | "onObjectTransformChange" | "onInteractionChange" | "onPreviewReady"> };
  axisColorsRef: { current: Graph3DAxisColors };
  render: () => void;
}) {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const planeHit = new Vector3();
  let drag: {
    operation: "rotate";
    objectId: string;
    axis: "x" | "y" | "z";
    origin: Graph3DPoint3;
    startEuler: Graph3DPoint3;
    worldAxis: Graph3DPoint3;
    /** Where the arc was grabbed, as an offset from the origin inside the rotation plane. */
    grabRadius: Vector3;
    lastPointer: { x: number; y: number };
    accumulatedAngle: number;
    nextEuler: Graph3DPoint3;
  } | {
    operation: "translate" | "scale";
    objectId: string;
    axis: "x" | "y" | "z";
    origin: Graph3DPoint3;
    worldAxis: Graph3DPoint3;
    startAmount: number;
    startTranslation: Graph3DPoint3;
    startScale: Graph3DPoint3;
    nextTranslation: Graph3DPoint3;
    nextScale: Graph3DPoint3;
  } | null = null;

  const ndcFromEvent = (event: PointerEvent) => {
    const box = viewport.getBoundingClientRect();
    pointer.set(
      ((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1,
      -((event.clientY - box.top) / Math.max(1, box.height)) * 2 + 1,
    );
    return pointer;
  };

  const intersectPlane = (origin: Graph3DPoint3, axis: Graph3DPoint3): Graph3DPoint3 | null => {
    raycaster.setFromCamera(pointer, camera);
    const view = new Vector3();
    camera.getWorldDirection(view);
    const axisVector = new Vector3(axis.x, axis.y, axis.z).normalize();
    const planeNormal = new Vector3().crossVectors(axisVector, view).cross(axisVector);
    if (planeNormal.lengthSq() < 1e-8) planeNormal.copy(view);
    planeNormal.normalize();
    const denom = raycaster.ray.direction.dot(planeNormal);
    if (Math.abs(denom) < 1e-8) return null;
    const amount = new Vector3(origin.x, origin.y, origin.z).sub(raycaster.ray.origin).dot(planeNormal) / denom;
    planeHit.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, amount);
    return { x: planeHit.x, y: planeHit.y, z: planeHit.z };
  };

  /**
   * Screen travel, in CSS pixels, of the grabbed arc point per radian of turn about `axis`.
   *
   * Measured from the projection of two nearby points on the same circle, so it already carries
   * both the direction the handle moves under the cursor and how much of the turn the current
   * viewpoint actually shows.
   */
  const screenPerRadian = (
    origin: Graph3DPoint3,
    grabRadius: Vector3,
    axis: Graph3DPoint3,
    angle: number,
  ) => {
    const box = viewport.getBoundingClientRect();
    const unit = new Vector3(axis.x, axis.y, axis.z).normalize();
    const pivot = new Vector3(origin.x, origin.y, origin.z);
    const here = grabRadius.clone().applyAxisAngle(unit, angle).add(pivot).project(camera);
    const ahead = grabRadius.clone()
      .applyAxisAngle(unit, angle + ROTATION_PROBE_RADIANS)
      .add(pivot)
      .project(camera);
    return {
      x: ((ahead.x - here.x) * box.width) / 2 / ROTATION_PROBE_RADIANS,
      y: (-(ahead.y - here.y) * box.height) / 2 / ROTATION_PROBE_RADIANS,
    };
  };

  const rotationStep = (
    pointerStep: { x: number; y: number },
    drag: { origin: Graph3DPoint3; grabRadius: Vector3; accumulatedAngle: number },
    axis: Graph3DPoint3,
  ) => graph3DPointerRotationStep(
    pointerStep,
    screenPerRadian(drag.origin, drag.grabRadius, axis, drag.accumulatedAngle),
    screenPerRadian(drag.origin, drag.grabRadius, axis, drag.accumulatedAngle + Math.PI / 2),
  );

  const selectObject = (objectId: string | null) => {
    selectedObjectIdRef.current = objectId;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    syncGraph3DObjectGizmo(runtime, specRef.current, objectId, axisColorsRef.current);
    render();
  };

  const onPointerDown = (event: PointerEvent) => {
    const runtime = runtimeRef.current;
    if (!runtime || event.button !== 0) return;
    ndcFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    const axisHit = pickGraph3DGizmoHandle(runtime.gizmoGroup
      ? raycaster.intersectObjects(runtime.gizmoGroup.children, true)
      : []);
    if (axisHit && selectedObjectIdRef.current) {
      const object = specRef.current.objects.find((candidate) => candidate.id === selectedObjectIdRef.current);
      const item = runtime.geometry.objects.find((candidate) => candidate.objectId === selectedObjectIdRef.current);
      if (!object || !item) return;
      const parameters = Object.fromEntries(
        specRef.current.parameters.map((parameter) => [parameter.name, parameter.value]),
      );
      const origin = graph3DObjectTransformedOrigin(object, item.geometry.positions, parameters);
      const axis = axisHit.object.userData.graph3dAxis as "x" | "y" | "z";
      const operation = axisHit.object.userData.graph3dOperation as "rotate" | "translate" | "scale";
      const startEuler = evaluateGraph3DObjectRotation(object, parameters);
      const worldAxis = rotateByEuler(
        { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 },
        startEuler,
      );
      if (operation === "rotate") {
        const grabRadius = radiusVectorAt(axisHit.point, origin, worldAxis);
        if (!grabRadius) return;
        drag = {
          operation,
          objectId: object.id,
          axis,
          origin,
          startEuler,
          worldAxis,
          grabRadius,
          lastPointer: { x: event.clientX, y: event.clientY },
          accumulatedAngle: 0,
          nextEuler: startEuler,
        };
      } else {
        const hit = intersectPlane(origin, worldAxis);
        if (!hit) return;
        const startTranslation = evaluateGraph3DObjectTranslation(object, parameters);
        const startScale = evaluateGraph3DObjectScale(object, parameters);
        drag = {
          operation,
          objectId: object.id,
          axis,
          origin,
          worldAxis,
          startAmount: dotGraph3D(subtractGraph3D(hit, origin), worldAxis),
          startTranslation,
          startScale,
          nextTranslation: startTranslation,
          nextScale: startScale,
        };
      }
      controls.enabled = false;
      callbacksRef.current.onInteractionChange?.(true);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const objectHits = raycaster.intersectObjects(runtime.graphGroup.children, true);
    const objectId = objectHits
      .map((hit) => readGraph3DObjectId(hit.object))
      .find((id): id is string => id !== null);
    selectObject(objectId ?? null);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    if (drag.operation !== "rotate") {
      ndcFromEvent(event);
      const hit = intersectPlane(drag.origin, drag.worldAxis);
      if (!hit) return;
      const amount = dotGraph3D(subtractGraph3D(hit, drag.origin), drag.worldAxis);
      const runtime = runtimeRef.current;
      if (drag.operation === "translate") {
        const delta = amount - drag.startAmount;
        drag.nextTranslation = addGraph3D(drag.startTranslation, multiplyGraph3D(drag.worldAxis, delta));
        if (runtime) applyPreviewObjectTranslation(runtime, drag.objectId, multiplyGraph3D(drag.worldAxis, delta));
      } else {
        const denominator = Math.abs(drag.startAmount) < 1e-6 ? 1 : drag.startAmount;
        const factor = Math.max(0.05, amount / denominator);
        drag.nextScale = { ...drag.startScale, [drag.axis]: drag.startScale[drag.axis] * factor };
        if (runtime) applyPreviewObjectScale(runtime, drag.objectId, drag.origin, drag.worldAxis, factor);
      }
      render();
      return;
    }
    const step = {
      x: event.clientX - drag.lastPointer.x,
      y: event.clientY - drag.lastPointer.y,
    };
    drag.lastPointer = { x: event.clientX, y: event.clientY };
    const angle = drag.accumulatedAngle + rotationStep(step, drag, drag.worldAxis);
    drag.accumulatedAngle = angle;
    const displayedAngle = snapGraph3DRotationAngle(angle, event.shiftKey);
    const nextEuler = addGraph3DLocalAxisRotation(drag.startEuler, drag.axis, displayedAngle);
    drag.nextEuler = nextEuler;
    const runtime = runtimeRef.current;
    if (runtime) {
      applyPreviewObjectRotation(runtime, drag.objectId, drag.origin, drag.worldAxis, displayedAngle);
      if (runtime.gizmoGroup) applyEulerToObject(runtime.gizmoGroup, nextEuler);
    }
    render();
  };

  const onPointerUp = () => {
    if (!drag) return;
    const completed = drag;
    drag = null;
    controls.enabled = true;
    callbacksRef.current.onInteractionChange?.(false);
    if (completed.operation !== "rotate") {
      const vector = completed.operation === "translate" ? completed.nextTranslation : completed.nextScale;
      const start = completed.operation === "translate" ? completed.startTranslation : completed.startScale;
      const changed = graph3DPointsDiffer(vector, start);
      if (changed) {
        callbacksRef.current.onObjectTransformChange?.(completed.objectId, completed.operation === "translate"
          ? { translation: graph3DVectorExpression(vector) }
          : { scale: graph3DVectorExpression(vector) });
      } else {
        const runtime = runtimeRef.current;
        if (runtime) resetPreviewObjectTransform(runtime, completed.objectId);
      }
      return;
    }
    const { objectId, nextEuler, startEuler } = completed;
    const changed = graph3DPointsDiffer(nextEuler, startEuler);
    if (changed) {
      callbacksRef.current.onObjectRotationChange?.(objectId, graph3DRotationExpression(nextEuler));
    } else {
      const runtime = runtimeRef.current;
      if (runtime) resetPreviewObjectTransform(runtime, objectId);
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}

/** Angle probed to read how a turn projects to the screen; small enough to stay a tangent. */
const ROTATION_PROBE_RADIANS = 0.05;

/**
 * Handle priority, not depth order.
 *
 * The translate shaft spans the whole axis so the solid can be grabbed anywhere along it, which
 * puts it in front of the scale knob and across the ends of the rotation arcs. Nearest-hit alone
 * would then hand every one of those picks to the shaft, so each handle keeps what it draws and
 * the shaft takes the rest of the axis.
 */
const GIZMO_HANDLE_PRIORITY: Record<string, number> = { scale: 0, rotate: 1, translate: 2 };

function pickGraph3DGizmoHandle(hits: readonly Intersection[]): Intersection | null {
  let picked: Intersection | null = null;
  let pickedPriority = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    if (typeof hit.object.userData.graph3dAxis !== "string") continue;
    const operation = hit.object.userData.graph3dOperation;
    if (typeof operation !== "string") continue;
    // `hits` arrives sorted by distance, so `<` keeps the nearest of equally ranked handles.
    const priority = GIZMO_HANDLE_PRIORITY[operation] ?? Number.POSITIVE_INFINITY;
    if (priority < pickedPriority) {
      picked = hit;
      pickedPriority = priority;
    }
  }
  return picked;
}

/** Where the arc was grabbed, projected into the plane the turn happens in. */
function radiusVectorAt(point: Vector3, origin: Graph3DPoint3, axis: Graph3DPoint3): Vector3 | null {
  const unit = new Vector3(axis.x, axis.y, axis.z).normalize();
  const radius = point.clone().sub(new Vector3(origin.x, origin.y, origin.z));
  radius.addScaledVector(unit, -radius.dot(unit));
  return radius.lengthSq() < 1e-8 ? null : radius;
}

function rotateByEuler(point: Graph3DPoint3, euler: Graph3DPoint3): Graph3DPoint3 {
  const matrix = graph3DEulerToMatrix(euler);
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2] * point.z,
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2] * point.z,
    z: matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2] * point.z,
  };
}

function addGraph3D(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtractGraph3D(a: Graph3DPoint3, b: Graph3DPoint3): Graph3DPoint3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function multiplyGraph3D(vector: Graph3DPoint3, factor: number): Graph3DPoint3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function dotGraph3D(a: Graph3DPoint3, b: Graph3DPoint3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function graph3DPointsDiffer(a: Graph3DPoint3, b: Graph3DPoint3): boolean {
  return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6 || Math.abs(a.z - b.z) > 1e-6;
}

function readGraph3DObjectId(object: Object3D): string | null {
  let current: Object3D | null = object;
  while (current) {
    const match = /^graph3d-object(?:-group)?:(.+)$/u.exec(current.name);
    if (match) return match[1];
    current = current.parent;
  }
  return null;
}
