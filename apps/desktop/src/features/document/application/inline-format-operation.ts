import { isSafeCssFontFamily } from "../css-safety";
import type { BoxedTone, BoxedVariant, InlineNode, TextMark } from "../model";
import { SigmaValidationError } from "../validation-error";

export interface InlineFormatPatch {
  /** `null` removes the explicit family and restores inheritance. */
  fontFamily?: string | null;
  /** Point size. `null` removes the explicit size and restores inheritance. */
  fontSize?: number | null;
  boxed?: {
    enabled: boolean;
    paddingY?: number;
    tone?: BoxedTone;
    variant?: BoxedVariant;
  };
}

/** Plain-text length used by AI text-range anchors. Math atoms are represented as `$TeX$`. */
export function inlineNodesReferenceLength(children: readonly InlineNode[]): number {
  return children.reduce((length, child) => (
    length + (child.type === "text" ? child.text.length : child.tex.length + 2)
  ), 0);
}

/**
 * Applies presentation-only formatting to a block-local text range without rebuilding its text.
 * A range that intersects any part of a math atom formats that whole atom, matching editor
 * selection behavior. Adjacent equal text runs are merged again to avoid persistent fragmentation.
 */
export function formatInlineNodeRange(
  children: readonly InlineNode[],
  from: number,
  to: number,
  patch: InlineFormatPatch,
): InlineNode[] {
  validateFormatPatch(patch);
  const length = inlineNodesReferenceLength(children);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > length) {
    throw new SigmaValidationError("inlineFormatRange", `invalid format range: ${from}-${to} / ${length}`, { from, to, length });
  }

  let offset = 0;
  const formatted = children.flatMap((child): InlineNode[] => {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    const nodeFrom = offset;
    const nodeTo = offset + nodeLength;
    offset = nodeTo;

    const overlapFrom = Math.max(from, nodeFrom);
    const overlapTo = Math.min(to, nodeTo);
    if (overlapFrom >= overlapTo) {
      return [child];
    }
    if (child.type === "mathInline") {
      return [applyInlineFormatPatch(child, patch)];
    }

    const localFrom = overlapFrom - nodeFrom;
    const localTo = overlapTo - nodeFrom;
    return [
      ...(localFrom > 0 ? [{ ...child, text: child.text.slice(0, localFrom) }] : []),
      applyInlineFormatPatch({ ...child, text: child.text.slice(localFrom, localTo) }, patch),
      ...(localTo < child.text.length ? [{ ...child, text: child.text.slice(localTo) }] : []),
    ];
  });

  return mergeAdjacentTextNodes(formatted);
}

/**
 * Replaces a block-local text range while treating the existing inline node as the source object
 * for a copy-with update. Unchanged node fields are preserved; replacement nodes inherit
 * presentation fields from the node at the start of the replaced range unless they explicitly
 * provide their own value. Adjacent equivalent text runs may be merged during normalization.
 */
export function replaceInlineNodeRange(
  children: readonly InlineNode[],
  from: number,
  to: number,
  replacement: readonly InlineNode[],
): InlineNode[] {
  const length = inlineNodesReferenceLength(children);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
    throw new SigmaValidationError("inlineReplaceRange", `invalid replace range: ${from}-${to} / ${length}`, { from, to, length });
  }

  const inheritedFrom = findInlineNodeAtOffset(children, from);
  const before: InlineNode[] = [];
  const after: InlineNode[] = [];
  let offset = 0;

  for (const child of children) {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    const nodeFrom = offset;
    const nodeTo = offset + nodeLength;
    offset = nodeTo;

    if (nodeTo <= from) {
      before.push(child);
      continue;
    }
    if (nodeFrom >= to) {
      after.push(child);
      continue;
    }

    if (child.type === "mathInline") {
      if (from > nodeFrom || to < nodeTo) {
        throw new SigmaValidationError("inlineMathPartialRange", "a replace range cannot cover part of an inline math node");
      }
      continue;
    }

    const localFrom = Math.max(0, from - nodeFrom);
    const localTo = Math.min(child.text.length, to - nodeFrom);
    if (localFrom > 0) {
      before.push({ ...child, text: child.text.slice(0, localFrom) });
    }
    if (localTo < child.text.length) {
      after.push({ ...child, text: child.text.slice(localTo) });
    }
  }

  const inheritedReplacement = replacement
    .filter(isNonEmptyInlineNode)
    .map((child) => inheritInlinePresentation(inheritedFrom, child));
  const next = mergeAdjacentTextNodes([...before, ...inheritedReplacement, ...after]);
  return next.length > 0 ? next : [{ type: "text", text: "" }];
}

/**
 * Compatibility path for callers that still submit a complete replacement. It reduces that
 * payload to one minimal text patch, then applies the same copy-with semantics as replace_text.
 * Unchanged prefix/suffix content therefore keeps its SigmaDoc fields and style.
 */
export function reconcileInlineNodeReplacement(
  current: readonly InlineNode[],
  replacement: readonly InlineNode[],
): InlineNode[] {
  const currentText = inlineNodesReferenceText(current);
  const replacementText = inlineNodesReferenceText(replacement);
  if (currentText === replacementText) {
    return current.map(cloneInlineNode);
  }

  let commonPrefix = 0;
  const maxPrefix = Math.min(currentText.length, replacementText.length);
  while (commonPrefix < maxPrefix && currentText[commonPrefix] === replacementText[commonPrefix]) {
    commonPrefix += 1;
  }

  let commonSuffix = 0;
  const maxSuffix = Math.min(currentText.length - commonPrefix, replacementText.length - commonPrefix);
  while (
    commonSuffix < maxSuffix
    && currentText[currentText.length - 1 - commonSuffix] === replacementText[replacementText.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }

  const currentFrom = moveStartOutsideMath(current, commonPrefix);
  const replacementFrom = moveStartOutsideMath(replacement, commonPrefix);
  const currentTo = moveEndOutsideMath(current, currentText.length - commonSuffix);
  const replacementTo = moveEndOutsideMath(replacement, replacementText.length - commonSuffix);

  return replaceInlineNodeRange(
    current,
    currentFrom,
    currentTo,
    sliceInlineNodeRange(replacement, replacementFrom, replacementTo),
  );
}

function inlineNodesReferenceText(children: readonly InlineNode[]): string {
  return children.map((child) => child.type === "text" ? child.text : `$${child.tex}$`).join("");
}

function sliceInlineNodeRange(children: readonly InlineNode[], from: number, to: number): InlineNode[] {
  if (to <= from) return [];
  let offset = 0;
  return children.flatMap((child): InlineNode[] => {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    const nodeFrom = offset;
    const nodeTo = offset + nodeLength;
    offset = nodeTo;
    const overlapFrom = Math.max(from, nodeFrom);
    const overlapTo = Math.min(to, nodeTo);
    if (overlapFrom >= overlapTo) return [];
    if (child.type === "mathInline") return [cloneInlineNode(child)];
    return [{ ...child, text: child.text.slice(overlapFrom - nodeFrom, overlapTo - nodeFrom) }];
  });
}

function moveStartOutsideMath(children: readonly InlineNode[], targetOffset: number): number {
  let offset = 0;
  for (const child of children) {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    const nodeTo = offset + nodeLength;
    if (child.type === "mathInline" && targetOffset > offset && targetOffset < nodeTo) return offset;
    offset = nodeTo;
  }
  return targetOffset;
}

function moveEndOutsideMath(children: readonly InlineNode[], targetOffset: number): number {
  let offset = 0;
  for (const child of children) {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    const nodeTo = offset + nodeLength;
    if (child.type === "mathInline" && targetOffset > offset && targetOffset < nodeTo) return nodeTo;
    offset = nodeTo;
  }
  return targetOffset;
}

function cloneInlineNode(child: InlineNode): InlineNode {
  return {
    ...child,
    ...(child.marks === undefined ? {} : { marks: [...child.marks] }),
  } as InlineNode;
}

function findInlineNodeAtOffset(children: readonly InlineNode[], targetOffset: number): InlineNode | undefined {
  let offset = 0;
  for (const child of children) {
    const nodeLength = child.type === "text" ? child.text.length : child.tex.length + 2;
    if (targetOffset < offset + nodeLength) {
      return child;
    }
    offset += nodeLength;
  }
  return children.at(-1);
}

function inheritInlinePresentation(source: InlineNode | undefined, replacement: InlineNode): InlineNode {
  if (!source) return { ...replacement };

  const inherited = {
    ...(source.marks === undefined ? {} : { marks: [...source.marks] }),
    ...(source.color === undefined ? {} : { color: source.color }),
    ...(source.backgroundColor === undefined ? {} : { backgroundColor: source.backgroundColor }),
    ...(source.fontFamily === undefined ? {} : { fontFamily: source.fontFamily }),
    ...(source.fontSize === undefined ? {} : { fontSize: source.fontSize }),
    ...(source.boxedPaddingY === undefined ? {} : { boxedPaddingY: source.boxedPaddingY }),
    ...(source.boxedVariant === undefined ? {} : { boxedVariant: source.boxedVariant }),
    ...(source.boxedTone === undefined ? {} : { boxedTone: source.boxedTone }),
  };
  if (replacement.type === "text") {
    return { ...inherited, ...replacement } as InlineNode;
  }

  const inheritedMathMarks = inherited.marks?.filter(
    (mark): mark is Extract<TextMark, "underline" | "boxed"> => mark === "underline" || mark === "boxed",
  );
  return {
    ...inherited,
    ...(inheritedMathMarks && inheritedMathMarks.length > 0 ? { marks: inheritedMathMarks } : { marks: undefined }),
    ...replacement,
  } as InlineNode;
}

function isNonEmptyInlineNode(child: InlineNode): boolean {
  return child.type === "mathInline" || child.text.length > 0;
}

function validateFormatPatch(patch: InlineFormatPatch): void {
  if (patch.fontFamily !== undefined && patch.fontFamily !== null && !isSafeCssFontFamily(patch.fontFamily)) {
    throw new SigmaValidationError("unsafeFontFamily", "unsafe font-family value");
  }
  if (
    patch.fontSize !== undefined
    && patch.fontSize !== null
    && (!Number.isFinite(patch.fontSize) || patch.fontSize <= 0 || patch.fontSize > 512)
  ) {
    throw new SigmaValidationError("fontSizeRange", "font size must be within (0, 512] pt");
  }
  if (
    patch.boxed?.paddingY !== undefined
    && (!Number.isFinite(patch.boxed.paddingY) || patch.boxed.paddingY < 0 || patch.boxed.paddingY > 100)
  ) {
    throw new SigmaValidationError("boxedPaddingRange", "boxed vertical padding must be within [0, 100]");
  }
  if (patch.fontFamily === undefined && patch.fontSize === undefined && patch.boxed === undefined) {
    throw new SigmaValidationError("emptyFormatPatch", "a format patch must change at least one property");
  }
}

function applyInlineFormatPatch<T extends InlineNode>(child: T, patch: InlineFormatPatch): T {
  const next: InlineNode = { ...child };
  if (patch.fontFamily !== undefined) {
    if (patch.fontFamily === null) {
      delete next.fontFamily;
    } else {
      next.fontFamily = patch.fontFamily.trim();
    }
  }
  if (patch.fontSize !== undefined) {
    if (patch.fontSize === null) {
      delete next.fontSize;
    } else {
      next.fontSize = patch.fontSize;
    }
  }
  if (patch.boxed) {
    const marks = new Set<TextMark>(next.marks ?? []);
    if (patch.boxed.enabled) {
      marks.add("boxed");
      if (patch.boxed.paddingY !== undefined) next.boxedPaddingY = patch.boxed.paddingY;
      if (patch.boxed.variant !== undefined) next.boxedVariant = patch.boxed.variant;
      if (patch.boxed.tone !== undefined) next.boxedTone = patch.boxed.tone;
    } else {
      marks.delete("boxed");
      delete next.boxedPaddingY;
      delete next.boxedVariant;
      delete next.boxedTone;
    }
    if (marks.size > 0) {
      next.marks = [...marks] as T["marks"];
    } else {
      delete next.marks;
    }
  }
  return next as T;
}

function mergeAdjacentTextNodes(children: readonly InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const child of children) {
    const previous = merged.at(-1);
    if (previous?.type === "text" && child.type === "text" && haveSameTextStyle(previous, child)) {
      previous.text += child.text;
    } else {
      merged.push({ ...child });
    }
  }
  return merged;
}

function haveSameTextStyle(
  left: Extract<InlineNode, { type: "text" }>,
  right: Extract<InlineNode, { type: "text" }>,
): boolean {
  return textStyleSignature(left) === textStyleSignature(right);
}

function textStyleSignature(node: Extract<InlineNode, { type: "text" }>): string {
  return JSON.stringify({
    marks: node.marks,
    color: node.color,
    backgroundColor: node.backgroundColor,
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    boxedPaddingY: node.boxedPaddingY,
    boxedVariant: node.boxedVariant,
    boxedTone: node.boxedTone,
  });
}
