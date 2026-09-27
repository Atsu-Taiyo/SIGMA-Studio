import { EMPTY_TIKZ_ENVIRONMENT, isTikzImageSource, type SigmaDocument, type TikzEnvironment, type TikzImageSource,
  type OverlayAsset, type OverlayImageShape } from "@/features/document";
import { createId } from "./id";
import { importTexDocument } from "./tex-import";
import { readMathAt } from "./tex-import/math";
import { readTexMacroDefinition } from "./tex-import/macros";
import { isEscaped, readBraceGroup, readBracketGroup, readCommandAt, readEnvironmentAt, readEnvironmentOpenAt, skipWhitespace } from "./tex-import/scanner";
import type { TikzRenderAPI } from "./tikz-contract";

export interface TexTikzPastePlan {
  document: SigmaDocument;
  figures: Array<{ blockId: string; input: TikzImageSource }>;
  unconvertedFigures: number;
}

const DIAGRAMS = new Set(["tikzpicture", "tikzcd", "circuitikz"]);
const TEXT_ENVIRONMENTS = new Set(["document", "problem", "exercise", "question", "solution", "solutions", "proof",
  "hint", "hints", "answer", "answers", "enumerate", "itemize", "description", "quote", "quotation", "figure", "figure*",
  "center", "flushright", "flushleft", "itembox"]);
const MACROS = new Set(["newcommand", "renewcommand", "providecommand"]);
const DECLARATIONS = new Set(["usepackage", "usetikzlibrary", "usepgflibrary", ...MACROS,
  "newenvironment", "renewenvironment", "def", "tikzset", "pgfplotsset", "pgfdeclarelayer", "pgfsetlayers"]);

/** Keep offsets into the original source, including comments inside each editable diagram. */
function maskComments(source: string): string {
  return source.split("\n").map(line => {
    for (let index = 0; index < line.length; index++) {
      if (line[index] === "%" && !isEscaped(line, index)) return line.slice(0, index) + " ".repeat(line.length - index);
    }
    return line;
  }).join("\n");
}

function declarationEnd(source: string, name: string, start: number): number {
  let cursor = start;
  if (MACROS.has(name)) return readTexMacroDefinition(source, start)?.endIndex ?? start;
  if (name === "def") {
    const command = readCommandAt(source, skipWhitespace(source, cursor));
    if (command) cursor = command.endIndex;
    const brace = source.indexOf("{", cursor);
    return brace < 0 ? cursor : readBraceGroup(source, brace)?.endIndex ?? cursor;
  }
  const limit = /environment$/.test(name) ? 5 : 2;
  for (let count = 0; count < limit; count++) {
    const option = readBracketGroup(source, cursor);
    const group = option ?? readBraceGroup(source, cursor);
    if (!group) break;
    cursor = group.endIndex;
    if (!/environment$/.test(name) && !option) break;
  }
  return cursor;
}

function extendEnvironment(environment: TikzEnvironment, declaration: string, name: string): TikzEnvironment {
  if (name === "usepackage") return { ...environment, packages: [environment.packages, declaration].filter(Boolean).join("\n") };
  if (name === "usetikzlibrary") {
    const libraries = readBraceGroup(maskComments(declaration), readCommandAt(declaration, 0)!.endIndex)?.value ?? "";
    return { ...environment, libraries: [...new Set(`${environment.libraries},${libraries}`.split(",").map(s => s.trim()).filter(Boolean))].join(",") };
  }
  return { ...environment, preamble: [environment.preamble, declaration].filter(Boolean).join("\n") };
}

function preambleEnvironment(source: string, defaults: TikzEnvironment): TikzEnvironment {
  const masked = maskComments(source);
  const chunks: string[] = [];
  let environment = { ...defaults };
  let previous = 0;
  for (let index = 0; index < source.length;) {
    const command = readCommandAt(masked, index);
    if (!command) { index++; continue; }
    if (["documentclass", "title", "author", "date", "usepackage", "usetikzlibrary"].includes(command.name)) {
      const end = declarationEnd(masked, command.name, command.endIndex);
      if (["usepackage", "usetikzlibrary"].includes(command.name)) environment = extendEnvironment(environment, source.slice(index, end), command.name);
      chunks.push(source.slice(previous, index));
      previous = index = end;
    } else index = DECLARATIONS.has(command.name) ? declarationEnd(masked, command.name, command.endIndex) : command.endIndex;
  }
  chunks.push(source.slice(previous));
  return { ...environment, preamble: [defaults.preamble, chunks.join("").trim()].filter(Boolean).join("\n") };
}

/** Protect diagrams before the text importer expands macros or normalizes whitespace. */
export function planTexTikzPaste(text: string, defaults: TikzEnvironment = EMPTY_TIKZ_ENVIRONMENT): TexTikzPastePlan | null {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim()
    .replace(/^```(?:latex|tex|tikz)?\s*\n([\s\S]*?)\n```$/i, "$1");
  if (source.length > 2 * 1024 * 1024) throw new Error("TeX source limit");
  const masked = maskComments(source);
  const entries: Array<{ marker: string; input: TikzImageSource }> = [];
  const chunks: string[] = [];
  let environment = { ...defaults };
  let index = 0;
  let previous = 0;
  const token = createId("tikz").replace(/[^a-zA-Z]/g, "");
  while (index < source.length) {
    const math = readMathAt(masked, index);
    if (math) { index = math.endIndex; continue; }
    const command = readCommandAt(masked, index);
    if (command && DECLARATIONS.has(command.name)) {
      const end = declarationEnd(masked, command.name, command.endIndex);
      environment = extendEnvironment(environment, source.slice(index, end), command.name);
      // Keep text macros available to the existing importer; do not expose styles as prose.
      if (!MACROS.has(command.name)) {
        chunks.push(source.slice(previous, index));
        previous = end;
      }
      index = end;
      continue;
    }
    const env = command?.name === "begin" ? readEnvironmentAt(masked, index) : null;
    const open = command?.name === "begin" ? readEnvironmentOpenAt(masked, index) : null;
    if (!env && open && DIAGRAMS.has(open.name)) {
      const document = importTexDocument("TeX");
      document.content = [{ type: "codeBlock", id: createId("tex"), language: "latex", children: [{ type: "text", text: source }] }];
      return { document, figures: [], unconvertedFigures: 1 };
    }
    if (env?.name === "document") environment = preambleEnvironment(source.slice(0, index), defaults);
    if (env && DIAGRAMS.has(env.name)) {
      const marker = `\\begin{${token}}${entries.length}\\end{${token}}`;
      entries.push({ marker, input: { source: source.slice(index, env.endIndex), environment: { ...environment } } });
      chunks.push(source.slice(previous, index), `\n${marker}\n`);
      previous = index = env.endIndex;
      continue;
    }
    if (env && !TEXT_ENVIRONMENTS.has(env.name)) { index = env.endIndex; continue; }
    index = command?.endIndex ?? index + 1;
  }
  if (!entries.length) return null;
  chunks.push(source.slice(previous));
  const imported = importTexDocument(chunks.join(""));
  const figures: TexTikzPastePlan["figures"] = [];
  const document = transform(imported, (node) => {
    if (typeof node.id === "string") node.id = createId("tex");
    if (Array.isArray(node.children)) {
      const literal = node.children.map((child: { type?: string; text?: string }) => child.type === "text" ? child.text : "\0").join("").trim();
      const entry = entries.find(item => item.marker === literal);
      if (entry && typeof node.id === "string") {
        figures.push({ blockId: node.id, input: entry.input });
        node.children = [{ type: "text", text: entry.input.source }];
      }
    }
    // Unsupported surrounding environments stay editable source, with no internal tokens.
    if (typeof node.text === "string") for (const entry of entries) node.text = (node.text as string).replaceAll(entry.marker, entry.input.source);
    return node;
  }) as SigmaDocument;
  return { document, figures, unconvertedFigures: entries.length - figures.length };
}

/** Sequential work bounds memory; callers commit only the complete result. */
export async function renderTexTikzPaste(plan: TexTikzPastePlan, render: TikzRenderAPI["render"], options: {
  cancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  imageWidthLimit?: number;
} = {}): Promise<{ document: SigmaDocument; failures: number } | null> {
  const shapes: OverlayImageShape[] = [];
  const assets: Record<string, OverlayAsset> = {};
  const replacements = new Map<string, { height?: number; source?: string }>();
  let failures = plan.unconvertedFigures;
  for (const { blockId, input } of plan.figures) {
    if (options.cancelled?.()) return null;
    try {
      if (!isTikzImageSource(input)) throw new Error("TikZ source limit");
      const response = await render(input);
      if (options.cancelled?.()) return null;
      if (!response.ok) throw new Error(response.error);
      const image = response.image;
      const scale = Math.min(1, (options.imageWidthLimit ?? 480) / image.width, 360 / image.height);
      const height = image.height * scale;
      const assetId = createId("asset");
      assets[assetId] = { id: assetId, type: "image", props: { src: image.src, w: image.width, h: image.height,
        name: "TikZ.svg", mimeType: "image/svg+xml", isAnimated: false, fileSize: atob(image.src.split(",")[1]).length } };
      shapes.push({ id: createId("shape"), type: "image", x: 0, y: 0, rotation: 0,
        anchor: { type: "block", blockId, dx: 0, dy: 0 },
        props: { assetId, w: image.width * scale, h: height, tikz: input } });
      replacements.set(blockId, { height });
    } catch {
      failures++;
      const env = input.environment;
      replacements.set(blockId, { source: [env.packages, env.libraries ? `\\usetikzlibrary{${env.libraries}}` : "", env.preamble, input.source].filter(Boolean).join("\n") });
    }
    options.onProgress?.(replacements.size, plan.figures.length);
  }
  if (options.cancelled?.()) return null;
  const document = transform(plan.document, (node) => {
    const replacement = replacements.get(node.id as string);
    if (!replacement) return node;
    if (replacement.height !== undefined) return { ...node, type: node.type === "codeBlock" ? "paragraph" : node.type,
      children: [{ type: "text", text: "" }], language: undefined, spaceAfterPx: Math.ceil(replacement.height + 16) };
    return { ...node, children: [{ type: "text", text: replacement.source }] };
  }) as SigmaDocument;
  document.pageLayout!.overlay = { ...document.pageLayout!.overlay!, overlaySnapshot: { version: 1, shapes, assets } };
  return { document, failures };
}

// SigmaDoc is JSON; this also covers nested containers and list continuations.
function transform(value: unknown, visit: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => transform(item, visit));
  if (!value || typeof value !== "object") return value;
  const node = visit({ ...value });
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, transform(child, visit)]));
}
