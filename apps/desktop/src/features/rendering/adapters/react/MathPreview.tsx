import { memo, type ReactNode } from "react";

import type { MathFractionSizing } from "@/features/document";

import type { InlineMathFrameStateOptions } from "../inline-math-frame";
import { countPerformanceEvent } from "@/lib/performance";

import {
  inlineMathBodyClassName,
  inlineMathNodeClassName,
  inlineMathNodeDataAttributes,
} from "../inline-math-frame";
import { renderMathHtml } from "../math-html";
import { useMathRenderEnvironment } from "./MathEnvironment";

export { renderMathHtml } from "../math-html";

// Shared React projection of the rendering adapter's math output.
interface MathPreviewProps {
  tex: string;
  displayMode?: boolean;
  className?: string;
  mathFractionSizing?: MathFractionSizing | null;
}

// Memoized: a math node only re-renders when its tex/mode/class actually changes.
// Without this, every inline math in the whole document re-renders on each keystroke
// (the parent editor trees re-render), which dominated typing latency.
export const MathPreview = memo(function MathPreview({ tex, displayMode = false, className, mathFractionSizing }: MathPreviewProps) {
  countPerformanceEvent("MathPreview.render");
  // 描画は main の math render parity (環境を渡す) に合わせる。
  const mathEnvironment = useMathRenderEnvironment(mathFractionSizing);
  const html = renderMathHtml(tex, mathEnvironment);
  // クラスの組み立ては共通出典から (編集面の NodeView・静的レンダラと同じ文字列にする)。
  const classes = inlineMathBodyClassName(displayMode, className);

  return (
    <span
      className={classes}
      dangerouslySetInnerHTML={{ __html: html }}
      data-empty={!tex ? "true" : "false"}
    />
  );
});

interface InlineMathFrameRenderProps {
  children: ReactNode;
  className: string;
  dataAttributes: ReturnType<typeof inlineMathNodeDataAttributes>;
}

interface InlineMathPreviewProps extends InlineMathFrameStateOptions {
  children?: ReactNode;
  id?: string;
  mathClassName?: string;
  mathFractionSizing?: MathFractionSizing | null;
  renderFrame?: (props: InlineMathFrameRenderProps) => ReactNode;
  tex: string;
  title?: string;
}

export { inlineMathNodeClassName, inlineMathNodeDataAttributes };

export function InlineMathPreview({
  children,
  className,
  displayMode = false,
  editing = false,
  id,
  mathClassName,
  mathFractionSizing,
  renderFrame,
  selected = false,
  tex,
  textSelected = false,
  title,
}: InlineMathPreviewProps) {
  const content = children ?? <MathPreview tex={tex} displayMode={displayMode} className={mathClassName} mathFractionSizing={mathFractionSizing} />;
  const frameProps: InlineMathFrameRenderProps = {
    children: content,
    className: inlineMathNodeClassName({ className, displayMode, editing, selected, textSelected }),
    dataAttributes: inlineMathNodeDataAttributes({ id, tex, title }),
  };

  if (renderFrame) {
    return renderFrame(frameProps);
  }

  return (
    <span className={frameProps.className} {...frameProps.dataAttributes}>
      {frameProps.children}
    </span>
  );
}
