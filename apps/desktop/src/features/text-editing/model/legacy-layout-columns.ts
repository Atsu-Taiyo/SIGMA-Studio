import type { LayoutSectionNode } from "@/features/document";

/** Import boundary for the former CSS-multicol projection inside containers.
 * Once columnStartIds exist they always win, including after deleting/moving a child.
 * Legacy explicit breaks are migrated once to ownership; they are never used to
 * repartition an already independent layout.
 */
export function migrateLegacyLayoutColumns(section: LayoutSectionNode): LayoutSectionNode {
  if (section.layout.columnStartIds?.length || section.children.length < 2) return section;
  const count = Math.min(section.children.length, Math.max(1, Math.min(4, Math.floor(section.layout.columnCount))));
  const starts = [0, ...section.children.flatMap((child, index) => index > 0 && child.pagination?.break ? [index] : [])].slice(0, count);
  if (starts.length === 1) {
    starts.push(...Array.from({ length: count - 1 }, (_, index) => Math.ceil((index + 1) * section.children.length / count)));
  }
  while (starts.length < count) {
    let largest = 0;
    let chosen = -1;
    for (let index = 0; index < starts.length; index += 1) {
      const length = (starts[index + 1] ?? section.children.length) - starts[index];
      if (length > largest && length > 1) { largest = length; chosen = index; }
    }
    if (chosen < 0) break;
    starts.splice(chosen + 1, 0, starts[chosen] + Math.ceil(largest / 2));
  }
  return { ...section, layout: { ...section.layout, columnStartIds: starts.map(index => section.children[index].id) } };
}
