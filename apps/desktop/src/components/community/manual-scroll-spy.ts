export interface ManualHeadingPosition { id: string; level: number; top: number }

/** Document order wins across sections; at a shared boundary prefer the finest heading. */
export function resolveManualHeading(headings: readonly ManualHeadingPosition[], boundary: number, atEnd = false): string | null {
  if (headings.length === 0) return null;
  if (atEnd) return headings[headings.length - 1].id;
  let current = headings[0];
  for (const heading of headings) {
    if (heading.top > boundary) continue;
    if (heading.top > current.top || (heading.top === current.top && heading.level >= current.level)) current = heading;
  }
  return current.id;
}
