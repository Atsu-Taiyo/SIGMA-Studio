import type {
  HeadingNumberingConfig,
  HeadingNumberingStyle,
  SigmaBlock,
} from "@/features/document";

export type HeadingCounters = readonly [number, number, number];

/**
 * Formats the display-only prefix shared by the editor and every static renderer.
 */
export function formatHeadingNumber(
  counters: HeadingCounters,
  level: 1 | 2 | 3,
  style: HeadingNumberingStyle = "decimal",
): string {
  const decimal = counters.slice(0, level).join(".");
  if (style === "sectionSign") {
    return `§${decimal}`;
  }
  if (style === "chapterJa" && level === 1) {
    return `第${counters[0]}章`;
  }
  return decimal;
}

/**
 * Derives heading labels without modifying SigmaDoc content.
 *
 * Only top-level headings and direct children of top-level layout sections participate in the
 * document outline. Headings inside quotes, boxes, problems, headers, and footers are deliberately
 * excluded because those containers do not define document sections.
 */
export function getHeadingNumberMap(
  content: SigmaBlock[],
  config?: HeadingNumberingConfig,
): Map<string, string> {
  const numbers = new Map<string, string>();
  if (config?.enabled !== true) {
    return numbers;
  }

  const counters: [number, number, number] = [0, 0, 0];
  const depth = config.depth ?? 3;
  const style = config.style ?? "decimal";

  const countHeading = (block: SigmaBlock | Extract<SigmaBlock, { type: "layoutSection" }>["children"][number]) => {
    if (block.type !== "heading" && block.type !== "section") {
      return;
    }
    const level = block.type === "section" ? 1 : block.level;
    // Invisible levels must not affect a later visible heading. In particular, do not initialize
    // an implied ancestor or increment this level before applying the configured depth.
    if (level > depth) {
      return;
    }
    const index = level - 1;
    // A skipped level still needs a usable display hierarchy. This changes only the derived
    // counters; no implied heading is inserted into SigmaDoc.
    for (let ancestor = 0; ancestor < index; ancestor += 1) {
      if (counters[ancestor] === 0) {
        counters[ancestor] = 1;
      }
    }
    counters[index] += 1;
    for (let deeper = index + 1; deeper < counters.length; deeper += 1) {
      counters[deeper] = 0;
    }
    numbers.set(block.id, formatHeadingNumber(counters, level, style));
  };

  for (const block of content) {
    if (block.type === "layoutSection") {
      block.children.forEach(countHeading);
    } else {
      countHeading(block);
    }
  }

  return numbers;
}
