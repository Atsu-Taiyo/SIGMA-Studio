import {
  TEXT_ASCENT_EM,
  TEXT_DESCENT_EM,
  TEXT_SHAPE_LINE_HEIGHT,
  type GraphLabelLayoutPort,
} from "@/features/drawing";
import { evaluateExpression } from "@/lib/graph2d";
import { ptToPx } from "@/lib/font-size-units";
import { createId } from "@/lib/id";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

import { measureTexBoxEm } from "./math-metrics";

/**
 * Builds the `GraphLabelLayoutPort` that `features/drawing`'s pure graph-label-layout functions
 * need to measure/evaluate/mint ids for graph-owned text labels (axis/point/annotation/formula
 * labels). `features/drawing` cannot reach `@/lib/graph2d`/`@/lib/id` itself (see
 * `features/drawing/architecture.test.ts`: it only allows `@/features/document` types and
 * relative imports), so every caller used to hand-roll an identical object literal. Both
 * `components/editor/overlay-canvas/shapes/graph.ts` and `lib/ai/sigma-doc-agent-tools.ts` build
 * this port purely from public, dependency-light modules (`@/features/drawing`, `@/lib/graph2d`,
 * `@/lib/font-size-units`, `@/lib/id`), so it lives here on the shared rendering-adapters
 * entrypoint rather than being duplicated in each.
 */
export function createGraphLabelLayoutPort(): GraphLabelLayoutPort {
  return {
    measureMathLabel(tex, fontSizePt) {
      return measureGraphMathLabelBox(tex, fontSizePt);
    },
    evaluateExpression,
    createInlineMathId: () => createId("overlay_math"),
    createBlockId: () => createId("p"),
  };
}

/**
 * The box a graph-owned label's formula occupies, in CSS pixels.
 *
 * A label's width is decided here, once, when the label is created: the shape stores it as
 * `props.w`, which is the width the author would otherwise have dragged, and the text wraps at it
 * from then on. So this has to be the *rendered* width — KaTeX's own box — and not an estimate:
 * a label narrower than its formula would wrap `y = x^2` onto two lines the moment it is drawn.
 *
 * `measureTexBoxEm` is the same measurement the renderers use, and it answers in em, so the only
 * work left here is the font size.
 *
 * The height is floored on each side separately — a formula's own ascent against plain text's,
 * its descent against plain text's — because that is how a line box holding a formula is built
 * (the line-box rule the estimator this replaced also used). Flooring the sum
 * instead would let a formula that is tall above the baseline and shallow below it come out
 * shorter than the line it sits on.
 *
 * The environment is the default one: a graph label is measured while the graph is being built,
 * outside any document context, so the document's TeX preamble is not in reach.
 */
function measureGraphMathLabelBox(tex: string, fontSizePt: number): { width: number; height: number } {
  const fontSizePx = ptToPx(fontSizePt);
  const metrics = measureTexBoxEm(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);
  const ascentEm = Math.max(TEXT_ASCENT_EM, metrics.ascentEm);
  const descentEm = Math.max(TEXT_DESCENT_EM, metrics.descentEm);
  return {
    width: Math.ceil(metrics.widthEm * fontSizePx),
    // The outer floor is redundant while the two constants sum to one line, which is an invariant
    // `svg-label-metrics.ts` states — but it is kept so the whole rule is written out here rather
    // than half-stated and half-implied.
    height: Math.ceil(fontSizePx * Math.max(TEXT_SHAPE_LINE_HEIGHT, ascentEm + descentEm)),
  };
}
