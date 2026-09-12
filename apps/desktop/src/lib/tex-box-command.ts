import { createId } from "@/lib/id";
import { texToInlineNodes } from "@/lib/tex-import";
import type { BoxedTone, BoxedVariant, InlineNode, TextMark } from "@/features/document";

/**
 * Backslash box commands that produce TeX-style typeset boxes when typed in body
 * text. The set is intentionally small and aimed at the box environments teachers
 * reach for: `\fbox`/`\thickbox`/`\doublebox`/`\ovalbox` (frames) and
 * `\tcolorbox`/`\shadebox`/`\itembox` (filled, optionally titled boxes).
 *
 * `\itembox` is the only command that takes a leading `{title}` argument; the rest
 * wrap a single `{body}` group.
 */
const FRAME_COMMANDS = new Set(["fbox", "framebox"]);
const THICK_COMMANDS = new Set(["thickbox"]);
const DOUBLE_COMMANDS = new Set(["doublebox"]);
const OVAL_COMMANDS = new Set(["ovalbox", "Ovalbox"]);
const SHADE_COMMANDS = new Set(["tcolorbox", "tcbox", "shadebox", "itembox"]);
const TITLED_COMMANDS = new Set(["itembox"]);

export const TEX_BOX_COMMAND_NAMES: readonly string[] = [
  ...FRAME_COMMANDS,
  ...THICK_COMMANDS,
  ...DOUBLE_COMMANDS,
  ...OVAL_COMMANDS,
  ...SHADE_COMMANDS,
];

export interface TexBoxCommand {
  command: string;
  variant: BoxedVariant;
  tone?: BoxedTone;
  /** Raw TeX of the title argument (only for titled commands such as `\itembox`). */
  titleTex?: string;
  /** Raw TeX of the box body. */
  bodyTex: string;
}

/** Whether `name` (without the leading backslash) is a supported box command. */
export function isTexBoxCommandName(name: string): boolean {
  return FRAME_COMMANDS.has(name) ||
    THICK_COMMANDS.has(name) ||
    DOUBLE_COMMANDS.has(name) ||
    OVAL_COMMANDS.has(name) ||
    SHADE_COMMANDS.has(name);
}

/**
 * Parse a fully typed box command such as `\tcolorbox[blue]{重要}` or
 * `\itembox{ポイント}{本文}`. Returns `null` when the input is not a recognized box
 * command, when its braces do not close, or when extra content trails the command —
 * so an arbitrary TeX expression is never silently turned into a box.
 */
export function parseTexBoxCommand(tex: string): TexBoxCommand | null {
  const source = tex.trim();
  const match = /^\\([A-Za-z]+)/.exec(source);
  if (!match) {
    return null;
  }

  const command = match[1];
  const variant = variantForCommand(command);
  if (!variant) {
    return null;
  }

  let cursor = match[0].length;
  const option = readBracketGroup(source, cursor);
  if (option) {
    cursor = option.endIndex;
  }

  const titled = TITLED_COMMANDS.has(command);
  const firstGroup = readBraceGroup(source, cursor);
  if (!firstGroup) {
    return null;
  }
  cursor = firstGroup.endIndex;

  let titleTex: string | undefined;
  let bodyTex = firstGroup.value;

  if (titled) {
    const secondGroup = readBraceGroup(source, cursor);
    if (secondGroup) {
      titleTex = firstGroup.value;
      bodyTex = secondGroup.value;
      cursor = secondGroup.endIndex;
    }
  }

  // Reject trailing content so we only convert when the whole field is the command.
  if (source.slice(cursor).trim() !== "") {
    return null;
  }

  return {
    command,
    variant,
    tone: variant === "shade" ? toneFromOption(option?.value, command) : undefined,
    titleTex,
    bodyTex,
  };
}

/**
 * Build the boxed inline nodes for a parsed box command. The body is parsed with the
 * shared TeX inline parser so nested `$math$` and inline formatting survive, then the
 * boxed mark (with variant/tone) is applied to every node. Titled boxes get a bold
 * `【title】` lead, matching how `\itembox` imports render today.
 */
export function boxCommandToInlineNodes(
  box: TexBoxCommand,
  makeId: (prefix: string) => string = createId,
): InlineNode[] {
  const nodes: InlineNode[] = [];

  if (box.titleTex && box.titleTex.trim() !== "") {
    const titleNodes = texToInlineNodes(`【${box.titleTex}】`, makeId);
    for (const node of titleNodes) {
      if (node.type === "text") {
        node.marks = addMark(node.marks, "bold");
      }
      nodes.push(node);
    }
    nodes.push({ type: "text", text: " " });
  }

  nodes.push(...texToInlineNodes(box.bodyTex, makeId));

  return nodes
    .filter((node) => node.type !== "text" || node.text.length > 0)
    .map((node) => applyBoxedStyle(node, box.variant, box.tone));
}

function variantForCommand(command: string): BoxedVariant | null {
  if (FRAME_COMMANDS.has(command)) {
    return "frame";
  }
  if (THICK_COMMANDS.has(command)) {
    return "thick";
  }
  if (DOUBLE_COMMANDS.has(command)) {
    return "double";
  }
  if (OVAL_COMMANDS.has(command)) {
    return "oval";
  }
  if (SHADE_COMMANDS.has(command)) {
    return "shade";
  }
  return null;
}

function applyBoxedStyle(node: InlineNode, variant: BoxedVariant, tone?: BoxedTone): InlineNode {
  if (node.type === "mathInline") {
    return {
      ...node,
      marks: ["boxed"],
      ...(variant !== "frame" ? { boxedVariant: variant } : {}),
      ...(tone ? { boxedTone: tone } : {}),
    };
  }

  return {
    ...node,
    marks: addMark(node.marks, "boxed"),
    ...(variant !== "frame" ? { boxedVariant: variant } : {}),
    ...(tone ? { boxedTone: tone } : {}),
  };
}

function addMark(marks: TextMark[] | undefined, mark: TextMark): TextMark[] {
  if (marks?.includes(mark)) {
    return marks;
  }
  return [...(marks ?? []), mark];
}

const TONE_KEYWORDS: Record<string, BoxedTone> = {
  gray: "gray",
  grey: "gray",
  black: "gray",
  blue: "blue",
  cyan: "blue",
  green: "green",
  teal: "green",
  red: "red",
  pink: "red",
  orange: "yellow",
  yellow: "yellow",
};

function toneFromOption(option: string | undefined, command: string): BoxedTone | undefined {
  if (option) {
    // tcolorbox-style keys such as `colback=red!5!white` — read the colour name.
    const colback = /colback\s*=\s*([A-Za-z]+)/.exec(option);
    const candidate = (colback?.[1] ?? option).trim().toLowerCase();
    for (const [keyword, tone] of Object.entries(TONE_KEYWORDS)) {
      if (candidate.includes(keyword)) {
        return tone;
      }
    }
  }
  // `\shadebox`/`\itembox` default to a neutral grey fill when no colour is given.
  return command === "tcolorbox" || command === "tcbox" ? undefined : "gray";
}

interface TexGroup {
  value: string;
  endIndex: number;
}

function readBraceGroup(source: string, index: number): TexGroup | null {
  return readDelimitedGroup(source, index, "{", "}");
}

function readBracketGroup(source: string, index: number): TexGroup | null {
  return readDelimitedGroup(source, index, "[", "]");
}

function readDelimitedGroup(source: string, index: number, open: string, close: string): TexGroup | null {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  if (source[cursor] !== open) {
    return null;
  }
  cursor += 1;
  const start = cursor;
  let depth = 1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return { value: source.slice(start, cursor), endIndex: cursor + 1 };
      }
    }
    cursor += 1;
  }

  return null;
}
