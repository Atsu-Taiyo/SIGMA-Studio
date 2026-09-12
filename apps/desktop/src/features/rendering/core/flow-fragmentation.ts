/** Text-bearing blocks can continue at measured line boundaries even when they
 * would fit a fresh page. Atomic figures still use the oversized fallback. */
export function isFlowBlockFragmentable(
  block: { type?: string } | undefined,
  height: number,
  segmentHeight: number,
  breakOffsets?: readonly number[],
): boolean {
  return height > 0 && (
    block?.type === "boxBlock"
    || (Boolean(breakOffsets?.some((offset) => offset > 0.5 && offset < height - 0.5))
      && (block?.type === "paragraph"
        || block?.type === "list"
        || block?.type === "quote"
        || block?.type === "codeBlock"))
    || height > segmentHeight + 0.5
  );
}

/** Height to keep with a preceding problem number/lead, rather than keeping
 * the entire first paragraph and defeating its line fragmentation. */
export function getFlowBlockStartHeight(
  block: { type?: string; keepTogether?: boolean; pagination?: { keepTogether?: boolean } } | undefined,
  height: number,
  segmentHeight: number,
  breakOffsets?: readonly number[],
): number {
  if (block?.keepTogether || block?.pagination?.keepTogether) return height;
  return isFlowBlockFragmentable(block, height, segmentHeight, breakOffsets)
    ? Math.min(height, breakOffsets?.[0] ?? height)
    : height;
}

export interface FlowFragmentStepInput {
  available: number;
  breakOffsets?: number[];
  /** Explicit breaks must advance even if the rest fits in this segment. */
  forcedBreakOffsets?: readonly number[];
  fullSegmentHeight: number;
  remaining: number;
  sourceOffsetY: number;
}

export interface FlowFragmentStep {
  advanceToNextSegment: boolean;
  height: number;
}

/**
 * Decide one page/column slice without knowing which visual box style produced
 * it. A measured break list is a hard safety contract: a slice ends only between
 * complete visual lines. The editor canvas and print renderer both use this
 * function so their continuation rules cannot drift apart.
 */
export function resolveFlowFragmentStep({
  available,
  breakOffsets,
  forcedBreakOffsets,
  fullSegmentHeight,
  remaining,
  sourceOffsetY,
}: FlowFragmentStepInput): FlowFragmentStep {
  const nextForcedOffset = forcedBreakOffsets?.filter((offset) => Number.isFinite(offset) && offset > sourceOffsetY + 0.5)
    .sort((a, b) => a - b)[0];
  const forcedHeight = nextForcedOffset === undefined ? remaining : Math.min(remaining, nextForcedOffset - sourceOffsetY);
  if (forcedHeight < remaining - 0.5) {
    return resolveFlowFragmentStep({ available, breakOffsets, fullSegmentHeight, remaining: forcedHeight, sourceOffsetY });
  }
  const rawHeight = Math.min(Math.max(1, available), remaining);

  if (remaining <= available + 0.5) {
    return { advanceToNextSegment: false, height: remaining };
  }

  // Without measured line boxes there is no trustworthy semantic boundary.
  // Retain the bounded pixel fallback for non-text/temporarily unmeasured DOM.
  if (!breakOffsets || breakOffsets.length === 0) {
    return { advanceToNextSegment: false, height: rawHeight };
  }

  const targetOffset = sourceOffsetY + rawHeight;
  const offsets = normalizeFlowFragmentBreakOffsets(breakOffsets, sourceOffsetY + remaining)
    .filter((offset) => offset > sourceOffsetY + 0.5);
  const fittingOffsets = offsets.filter((offset) => offset <= targetOffset + 0.5);
  let snappedOffset = fittingOffsets.at(-1);

  // Do not create a continuation containing only the closing border/padding.
  // Move the final visual line together with that trailing chrome instead.
  if (snappedOffset !== undefined) {
    const trailingHeight = sourceOffsetY + remaining - snappedOffset;
    const previousOffset = fittingOffsets.at(-2);
    if (trailingHeight > 0.5 && trailingHeight < 24) {
      if (
        previousOffset !== undefined
        && sourceOffsetY + remaining - previousOffset <= fullSegmentHeight + 0.5
      ) {
        snappedOffset = previousOffset;
      } else if (remaining <= fullSegmentHeight + 0.5) {
        // Keep the tail together on a fresh region only if it actually fits.
        // A short final line is not permission to overflow the current page.
        return { advanceToNextSegment: true, height: 0 };
      }
    }
  }

  if (snappedOffset !== undefined) {
    return {
      advanceToNextSegment: false,
      height: Math.max(1, snappedOffset - sourceOffsetY),
    };
  }

  const nextSafeOffset = offsets[0];
  if (nextSafeOffset !== undefined) {
    const nextSafeHeight = nextSafeOffset - sourceOffsetY;
    if (available < fullSegmentHeight - 0.5 && nextSafeHeight <= fullSegmentHeight + 0.5) {
      return { advanceToNextSegment: true, height: 0 };
    }
    // A single visual line can itself be taller than a page/column. Keeping it
    // intact may overflow, but is preferable to cutting through the line.
    return { advanceToNextSegment: false, height: Math.max(1, nextSafeHeight) };
  }

  return { advanceToNextSegment: false, height: remaining };
}

function normalizeFlowFragmentBreakOffsets(offsets: number[], totalHeight: number): number[] {
  const normalized = offsets
    .filter((offset) => Number.isFinite(offset) && offset > 0.5 && offset < totalHeight - 0.5)
    .sort((left, right) => left - right);
  normalized.push(totalHeight);
  return Array.from(new Set(normalized.map((offset) => Math.round(offset * 100) / 100)));
}

/** A container supplies regions; the fragmenter alone owns content coverage. */
export interface FlowFragmentRegion {
  x: number;
  y: number;
  width: number;
  available: number;
  fullHeight: number;
}

export interface FlowContentFragment {
  fragmentIndex: number;
  sourceOffsetY: number;
  height: number;
  x: number;
  y: number;
  width: number;
}

/**
 * Shared continuation protocol for pages, flowing columns and independent columns.
 * Containers own their cursor and decoration insets, never the splitting loop.
 * Every emitted slice consumes the source exactly once, including bounded overflow.
 */
export function fragmentFlowBlock(input: {
  height: number;
  breakOffsets?: number[];
  forcedBreakOffsets?: readonly number[];
  maxFragments: number;
  region: () => FlowFragmentRegion;
  advance: () => boolean;
  consume: (height: number) => void;
}): FlowContentFragment[] {
  const fragments: FlowContentFragment[] = [];
  let remaining = Math.max(0, input.height);
  let sourceOffsetY = 0;
  const budget = Math.max(1, Math.floor(input.maxFragments));
  const append = (height: number) => {
    const region = input.region();
    fragments.push({
      fragmentIndex: fragments.length, sourceOffsetY, height,
      x: region.x, y: region.y, width: region.width,
    });
    sourceOffsetY += height;
    remaining -= height;
    input.consume(height);
  };
  // Attempts, not only emitted fragments, are bounded: an unusable region must
  // never make a malformed container loop forever. Keep a final remainder slot.
  for (let attempt = 0; remaining > 0.5 && attempt < budget - 1; attempt += 1) {
    if (input.region().available <= 0.5 && !input.advance()) break;
    const region = input.region();
    const step = resolveFlowFragmentStep({
      available: Math.max(1, region.available),
      fullSegmentHeight: Math.max(1, region.fullHeight),
      breakOffsets: input.breakOffsets,
      forcedBreakOffsets: input.forcedBreakOffsets,
      remaining, sourceOffsetY,
    });
    if (step.advanceToNextSegment) {
      if (!input.advance()) break;
      continue;
    }
    append(step.height);
    if (remaining > 0.5 && !input.advance()) break;
  }
  if (remaining > 0.5) append(remaining);
  return fragments;
}
