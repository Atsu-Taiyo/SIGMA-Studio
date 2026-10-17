import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { measureSvgFragment } from "@/components/editor/overlay-canvas/svg-fragment-bounds";
import { measureSvgOverlayText, prepareSvgTextFonts } from "@/components/editor/overlay-canvas/svg-text-measurement";
import { createMathRenderEnvironment } from "@/lib/math-environment";
import { AI_SVG_CONVERSION_LINE_SIZES, convertSvgImageShape, SvgConversionError, type SvgImageConversion } from "@/lib/svg-to-sigma";

export type SvgConversionTaskResult = { ok: true; conversion: SvgImageConversion } | { ok: false; error: string };

declare global {
  interface Window {
    /** Read by the main process (`convertAiSvgImage`) once the hidden page has converted its one image. */
    __sigmaSvgConversion?: Promise<SvgConversionTaskResult>;
  }
}

/**
 * The AI's `convert_svg_image`, run in a hidden print page: the same converter and the same text, math
 * and fragment measurement as "図形に変換" on the canvas, with the document's TeX preamble. Strokes stay at
 * "細" or thicker (`AI_SVG_CONVERSION_LINE_SIZES`); only this AI path does that.
 */
export async function runSvgConversionTask(document: SigmaDocument, shapeId: string): Promise<SvgConversionTaskResult> {
  try {
    const snapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
    const image = snapshot.shapes.find((shape) => shape.id === shapeId);
    if (image?.type !== "image") {
      return { ok: false, error: "source" };
    }
    await prepareSvgTextFonts();
    const environment = createMathRenderEnvironment(document.metadata.texPreamble);
    const conversion = convertSvgImageShape(
      { image, asset: snapshot.assets[image.props.assetId] },
      undefined,
      measureSvgFragment,
      (shape) => measureSvgOverlayText(shape, environment),
      { lineSizes: AI_SVG_CONVERSION_LINE_SIZES },
    );
    return { ok: true, conversion };
  } catch (error) {
    return { ok: false, error: error instanceof SvgConversionError ? error.reason : error instanceof Error ? error.message : String(error) };
  }
}
