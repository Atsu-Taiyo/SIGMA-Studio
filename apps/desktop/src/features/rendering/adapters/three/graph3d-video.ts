import { Scene, Vector3, WebGLRenderer, SRGBColorSpace } from "three";

import { getGraph3DAxisColors, type Graph3DSpec } from "@/features/document";
import {
  buildGraph3DSceneGeometry,
  createGraph3DSampledSpec,
  graph3DAnimationOverridesAt,
  graph3DVideoAnimationParameters,
  graph3DVideoDurationMs,
  type Graph3DSceneGeometry,
} from "@/features/drawing";
import { createGraph3DDisplayAnnotations } from "@/features/rendering/core";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

export { canvasVideoPixelSize as graph3DVideoPixelSize, type CanvasVideoPixelSize as Graph3DVideoPixelSize } from "../canvas-video";
import { canvasVideoPixelSize as graph3DVideoPixelSize, recordCanvasVideo, type CanvasVideoRecording } from "../canvas-video";

import {
  addThreeGraph3DLights,
  applyThreeGraph3DView,
  createThreeGraph3DCamera,
  createThreeGraph3DGroup,
  disposeThreeGraph3DGroup,
  updateThreeGraph3DCameraAspect,
  updateThreeGraph3DGroup,
} from "./graph3d-three";

const tShape = createCurrentLocaleTranslator("shape");

/**
 * A 3D material's animation, written to a video file.
 *
 * The scene is rebuilt off-screen rather than recorded off the live window: the export must not
 * depend on the shape being scrolled into view, and it is free to render well above the size the
 * shape occupies on the page.
 */

const TARGET_FPS = 30;
/**
 * How long one frame may take and still be worth recording.
 *
 * Not `1000 / TARGET_FPS`. The recorder's clock is wall-clock, so a slow frame costs frame *rate*,
 * never length or speed — and a figure whose section sweeps across a solid still reads at twelve
 * frames a second. Sampling density does not recover: a facet written into the file is in it for
 * good. So the budget is loose enough to buy detail with frame rate, which is the trade a figure
 * wants and a camera pan does not.
 */
const RECORDED_FPS_FLOOR = 12;
const FRAME_BUDGET_MS = 1_000 / RECORDED_FPS_FLOOR;
/**
 * Multipliers on the author's own plot counts, tried in order from theirs upward.
 *
 * The video is never recorded coarser than the figure is authored — when even that is too slow it
 * is the *frame* that shrinks — and it is recorded as much finer as this machine can actually
 * sustain. The steps are small because sampling cost is cubic in a marched solid's resolution:
 * 1.5 already costs three times as much, and one overshoot is what the search pays to stop.
 */
export const GRAPH3D_RECORDING_DENSITY_LADDER = [1, 1.25, 1.5, 2, 3] as const;

/**
 * The finest plot density this machine can still record, found by trying.
 *
 * Cost is cubic in a marched solid's resolution and quadratic in a surface's samples, so it cannot
 * be predicted from the spec; and the answer belongs to the machine, not the figure. Climbing from
 * the author's own density means the single measurement that overshoots is bounded by the last one
 * that fit. The floor is 1: a video is never written coarser than the figure is authored.
 */
export function pickGraph3DRecordingDensity(
  measureFrameMs: (factor: number) => number,
  budgetMs = FRAME_BUDGET_MS,
): number {
  let affordable: number = GRAPH3D_RECORDING_DENSITY_LADDER[0];
  for (const factor of GRAPH3D_RECORDING_DENSITY_LADDER) {
    if (measureFrameMs(factor) > budgetMs) break;
    affordable = factor;
  }
  return affordable;
}
/**
 * Floor for the trade the calibration makes when even the coarsest tessellation is too slow.
 * Below this the video stops being usable as a figure, and a choppier one is the better trade.
 */
const MIN_LONG_EDGE_PX = 480;

export interface Graph3DVideoLabelImage {
  canvas: HTMLCanvasElement;
  /** On-screen size in CSS pixels; the bitmap itself is `scale` times larger. */
  width: number;
  height: number;
}

export interface RecordGraph3DAnimationVideoOptions {
  spec: Graph3DSpec;
  /** Size of the shape on the page, in document pixels. */
  width: number;
  height: number;
  /** Rasterized TeX labels, keyed by annotation id. A missing label is simply not drawn. */
  labels?: ReadonlyMap<string, Graph3DVideoLabelImage>;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface Graph3DVideoRecording extends CanvasVideoRecording {
  pixelWidth: number;
  pixelHeight: number;
  durationMs: number;
}

export async function recordGraph3DAnimationVideo(
  options: RecordGraph3DAnimationVideoOptions,
): Promise<Graph3DVideoRecording> {
  const { spec, labels, onProgress, signal } = options;
  const parameters = graph3DVideoAnimationParameters(spec);
  if (parameters.length === 0) throw new Error(tShape("graph3d.noAnimatableParameters"));
  const durationMs = graph3DVideoDurationMs(parameters);
  const target = graph3DVideoPixelSize(options.width, options.height);
  let pixelWidth = target.pixelWidth;
  let pixelHeight = target.pixelHeight;
  let scale = target.scale;

  let renderSpec = spec;
  const axisColors = getGraph3DAxisColors(spec.view);

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = pixelWidth;
  frameCanvas.height = pixelHeight;
  const context = frameCanvas.getContext("2d");
  if (!context) throw new Error(tShape("graph3d.videoFrameFailed"));

  const renderer = new WebGLRenderer({ antialias: true, alpha: false, stencil: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(pixelWidth, pixelHeight, false);

  const scene = new Scene();
  addThreeGraph3DLights(scene);
  applyThreeGraph3DView(scene, spec.view, axisColors);
  const camera = createThreeGraph3DCamera(spec.camera, pixelWidth / pixelHeight);

  let geometry = buildGraph3DSceneGeometry(renderSpec, graph3DAnimationOverridesAt(parameters, 0));
  const group = createThreeGraph3DGroup(geometry);
  scene.add(group);

  const projected = new Vector3();
  // Labels are pixels here, not elements: the same projection the live overlay uses to place its
  // TeX spans decides where each rasterized label lands in the frame.
  const drawLabels = (frameGeometry: Graph3DSceneGeometry) => {
    if (!labels || labels.size === 0) return;
    for (const annotation of createGraph3DDisplayAnnotations(spec, frameGeometry.annotations, axisColors)) {
      const label = labels.get(annotation.id);
      if (!label) continue;
      projected.set(annotation.position.x, annotation.position.y, annotation.position.z);
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = (projected.x * 0.5 + 0.5) * pixelWidth;
      const y = (-projected.y * 0.5 + 0.5) * pixelHeight;
      const labelWidth = label.width * scale;
      const labelHeight = label.height * scale;
      context.drawImage(label.canvas, x - labelWidth / 2, y - labelHeight / 2, labelWidth, labelHeight);
    }
  };

  // What the last frame spent on tessellation alone. Shrinking the frame buys back time in the
  // render and the copy; it buys back nothing here, and the calibration has to tell them apart.
  let lastGeometryMs = 0;
  const drawFrame = (timeMs: number) => {
    const geometryStartedAt = performance.now();
    const next = buildGraph3DSceneGeometry(renderSpec, graph3DAnimationOverridesAt(parameters, timeMs));
    lastGeometryMs = performance.now() - geometryStartedAt;
    if (next !== geometry) {
      updateThreeGraph3DGroup(group, geometry, next);
      geometry = next;
    }
    renderer.render(scene, camera);
    context.drawImage(renderer.domElement, 0, 0, pixelWidth, pixelHeight);
    drawLabels(geometry);
  };

  const resizeFrame = (factor: number) => {
    pixelWidth = Math.max(2, Math.round(pixelWidth * factor / 2) * 2);
    pixelHeight = Math.max(2, Math.round(pixelHeight * factor / 2) * 2);
    scale = pixelWidth / Math.max(1, Math.round(options.width));
    frameCanvas.width = pixelWidth;
    frameCanvas.height = pixelHeight;
    renderer.setSize(pixelWidth, pixelHeight, false);
    // 偶数丸めで縦横比がわずかに動く。カメラを合わせ直さないと絵がその分だけ伸びる。
    updateThreeGraph3DCameraAspect(camera, pixelWidth / pixelHeight);
  };

  /**
   * What this machine can actually draw at video rate, measured on a real frame.
   *
   * Timing the geometry alone was not enough: on a machine without a GPU the render, the copy
   * into the frame and the encode cost more than the tessellation does, and frames the recorder
   * cannot keep up with are dropped — the video then ends before the animation does. Sampling
   * density is given up first; only when even the coarsest one is too slow is the frame made
   * smaller, because both the copy and the encode scale with its area.
   *
   * A third of the way in: the first instant of a sweep is often the degenerate one (an empty
   * section, a zero-height solid) and would time the cheapest frame of the whole animation.
   */
  const calibrate = () => {
    /**
     * The second frame, not the first.
     *
     * Everything the animation does not move is meshed once and cached, so the first frame at a
     * new density pays for the whole figure while every later one pays only for the parts the
     * parameter touches. Timing the first frame charged the recording rate for work it never
     * repeats, and pushed figures with one heavy still solid down a step they did not need.
     */
    const measure = () => {
      drawFrame(durationMs / 3);
      const startedAt = performance.now();
      drawFrame(durationMs / 3 + FRAME_BUDGET_MS * 2);
      return performance.now() - startedAt;
    };
    const affordable = pickGraph3DRecordingDensity((factor) => {
      renderSpec = createGraph3DSampledSpec(spec, factor);
      return measure();
    });
    renderSpec = createGraph3DSampledSpec(spec, affordable);
    if (affordable > 1) return;
    // Even the authored density misses the budget. Give up frame *area*, never plot counts — and
    // only while the area is what costs: a figure whose tessellation alone overruns records at a
    // lower frame rate, rather than at a smaller size that would not have bought anything back.
    while (
      measure() > FRAME_BUDGET_MS &&
      lastGeometryMs < FRAME_BUDGET_MS &&
      Math.max(pixelWidth, pixelHeight) > MIN_LONG_EDGE_PX
    ) {
      resizeFrame(0.75);
    }
  };

  calibrate();

  try {
    const recording = await recordCanvasVideo({
      canvas: frameCanvas,
      durationMs,
      fps: TARGET_FPS,
      drawFrame,
      onProgress,
      signal,
    });
    return { ...recording, pixelWidth, pixelHeight, durationMs };
  } finally {
    scene.remove(group);
    disposeThreeGraph3DGroup(group);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
