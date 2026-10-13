import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { OverlayTextBlocksView } from "@/components/editor/text-flow/OverlayTextBlocksView";
import type { MeasureSvgOverlayText } from "@/lib/svg-text-to-overlay";
import { DEFAULT_MATH_RENDER_ENVIRONMENT, type MathRenderEnvironment } from "@/lib/math-environment";
import { MathEnvironmentValueProvider } from "@/features/rendering/adapters/react";
import { measureOverlayTextContentHeight } from "./text-shape-measure";

export async function prepareSvgTextFonts() {
  if (!document.fonts) return;
  await Promise.allSettled(Array.from(document.fonts).filter((font) => font.family.startsWith("KaTeX_")).map((font) => font.load()));
  await document.fonts.ready;
}

/** Measure with the same text/math renderer as the canvas, including its real font baseline. */
export function measureSvgOverlayText(shape: Parameters<MeasureSvgOverlayText>[0], environment: MathRenderEnvironment = DEFAULT_MATH_RENDER_ENVIRONMENT) {
  const container = document.createElement("div");
  container.className = "overlay-text-shape";
  Object.assign(container.style, { position: "fixed", left: "-100000px", top: "0", visibility: "hidden", pointerEvents: "none",
    width: "max-content", minWidth: "0", lineHeight: "1", fontSize: `${shape.props.fontSize}pt`, color: shape.props.color });
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<MathEnvironmentValueProvider environment={environment}>
      <OverlayTextBlocksView blocks={shape.props.blocks} selfContained />
    </MathEnvironmentValueProvider>));
    const content = container.querySelector<HTMLElement>(".overlay-text-shape-content");
    const paragraph = content?.querySelector("p");
    if (!content || !paragraph) return null;
    content.style.whiteSpace = "nowrap";
    const probe = document.createElement("span");
    Object.assign(probe.style, { display: "inline-block", width: "0", height: "0", verticalAlign: "baseline" });
    paragraph.appendChild(probe);
    const box = content.getBoundingClientRect();
    return { width: box.width + 2, height: measureOverlayTextContentHeight(content), baseline: probe.getBoundingClientRect().top - box.top };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
}
