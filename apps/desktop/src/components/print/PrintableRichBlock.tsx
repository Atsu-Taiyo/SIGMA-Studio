"use client";

import {
  TextFlowStaticBlock,
  type TextFlowStaticBlockClassNames,
  type TextFlowStaticBlockNode,
} from "@/components/editor/text-flow/TextFlowStaticBlock";
import type { MathFractionSizing } from "@/features/document";

type TextResolver = (text: string) => string;

interface PrintableRichBlockProps {
  block: TextFlowStaticBlockNode;
  mathFractionSizing?: MathFractionSizing | null;
  resolveText?: TextResolver;
}

/**
 * The `.print-*` family of the shared static block renderer.
 *
 * `PrintPreview` (and through it the embedded viewer, the material thumbnails and the template
 * gallery) styles against these class names, so they stay. The markup itself is
 * `TextFlowStaticBlock`'s — the header/footer path renders the same component without the classes,
 * which is what removed the second implementation.
 */
const PRINT_CLASS_NAMES: TextFlowStaticBlockClassNames = {
  heading: "print-heading",
  list: "print-list",
  paragraph: "print-paragraph",
  quote: "print-quote",
  code: "print-code",
  divider: "print-divider",
};

export function PrintableRichBlock({ block, mathFractionSizing, resolveText }: PrintableRichBlockProps) {
  return (
    <TextFlowStaticBlock
      block={block}
      classNames={PRINT_CLASS_NAMES}
      mathFractionSizing={mathFractionSizing}
      resolveText={resolveText}
    />
  );
}
