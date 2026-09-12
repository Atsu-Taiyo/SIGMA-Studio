import { createId as createDocumentImportId } from "@/lib/id";
import { readListOptions, readNumericItemLabel } from "./tex-import/list-options";
import { readMathAt } from "./tex-import/math";
import {
  readCommandAt, readEnvironmentAt, readBraceGroup, readBracketGroup,
  readCommandContentGroup, readCommandArgument, skipCommandArguments, stripTexComments,
  type TexCommand, type TexEnvironment,
} from "./tex-import/scanner";
import {
  collectTexMacroDefinitions, expandTexMacros, removeTexMacroDefinitions, type TexMacroDefinition,
} from "./tex-import/macros";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import {
  ensurePageLayout,
  type AnswerDefinition,
  type SigmaBlock,
  type SigmaDocument,
  type HeadingNode,
  type InlineNode,
  type ListNode,
  type ParagraphNode,
  type ProblemNode,
  type RichBlock,
  type CodeBlockNode,
  type TextInlineNode,
  type TextMark,
  type TextAlign,
} from "@/features/document";

const MAX_TEX_CHARS = 2 * 1024 * 1024;
const OUTPUT_PROFILES: SigmaDocument["outputProfiles"] = {
  student: { showSolutions: false, showHints: false, includeAnswers: false },
  teacher: { showSolutions: true, showHints: true, includeAnswers: true },
  answerBook: { onlySolutions: true, includeAnswers: true },
};

const TOP_LEVEL_PROBLEM_ENVIRONMENTS = new Set(["problem", "exercise", "question"]);
const SOLUTION_ENVIRONMENTS = new Set(["solution", "solutions", "proof"]);
const HINT_ENVIRONMENTS = new Set(["hint", "hints"]);
const ANSWER_ENVIRONMENTS = new Set(["answer", "answers"]);
const AREA_COMMANDS = new Set(["answer", "solution", "hint"]);
const LIST_ENVIRONMENTS = new Set(["enumerate", "itemize", "description"]);
const TRANSPARENT_TEXT_ENVIRONMENTS = new Set(["quote", "quotation"]);
const IGNORED_TOP_LEVEL_COMMANDS = new Set([
  "author",
  "columnratio",
  "date",
  "documentclass",
  "everymath",
  "geometry",
  "lfoot",
  "lhead",
  "label",
  "large",
  "maketitle",
  "newcommand",
  "newlength",
  "pagestyle",
  "renewcommand",
  "rfoot",
  "rhead",
  "setlist",
  "setstretch",
  "singlespacing",
  "onehalfspacing",
  "doublespacing",
  "title",
  "usetikzlibrary",
  "usepackage",
]);
const MARK_COMMANDS: Partial<Record<string, TextMark>> = {
  anaume: "boxed",
  emph: "italic",
  fbox: "boxed",
  ovalbox: "boxed",
  sanaume: "boxed",
  textbf: "bold",
  textit: "italic",
  underline: "underline",
};
const UNWRAP_TEXT_COMMANDS = new Set([
  "large",
  "mbox",
  "scriptsize",
  "text",
  "textnormal",
  "textrm",
  "textsf",
  "texttt",
]);
const IGNORED_TEXT_COMMANDS = new Set([
  "FloatBarrier",
  "begin",
  "bigskip",
  "centering",
  "clearpage",
  "columnbreak",
  "hfill",
  "hspace",
  "label",
  "large",
  "medskip",
  "newpage",
  "noindent",
  "normalsize",
  "pagebreak",
  "par",
  "phantom",
  "setlength",
  "smallskip",
  "end",
  "vspace",
]);
const TEXT_SYMBOL_COMMANDS: Record<string, string> = {
  LaTeX: "LaTeX",
  TeX: "TeX",
  ldots: "...",
  dots: "...",
};
const TEXT_SPACING_COMMANDS = new Set(["quad", "qquad", "smallskip", "medskip", "bigskip"]);

interface ProblemAreas {
  promptSource: string;
  solutionSources: string[];
  hintSources: string[];
  answerSources: string[];
}

type TexIdFactory = (prefix: string) => string;

export function isTexFilename(filename: string): boolean {
  return /\.(?:tex|latex)$/i.test(filename);
}

export function importTexDocument(input: string, filename = "lesson.tex"): SigmaDocument {
  const normalizedInput = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (normalizedInput.length > MAX_TEX_CHARS) {
    throw new Error("TeXファイルが大きすぎます。2MB以下のファイルを選んでください。");
  }

  const source = stripTexComments(normalizedInput);
  const macros = collectTexMacroDefinitions(source);
  const body = expandTexMacros(extractDocumentBody(removeTexMacroDefinitions(source)), macros);
  const createId = createTexIdFactory();
  const content = parseTopLevelTexBlocks(body, createId);

  if (content.length === 0) {
    throw new Error("TeXファイル内に取り込める本文が見つかりませんでした。");
  }

  const title = extractTexTitle(source, createId, macros) ?? titleFromFilename(filename);
  return parseSigmaDocument(ensurePageLayout({
    version: "2.0",
    docId: createDocumentImportId("doc"),
    metadata: { title },
    content,
    outputProfiles: OUTPUT_PROFILES,
    updatedAt: new Date().toISOString(),
  }));
}

/** The site's prompt and explanation fields remain separate SigmaDoc problem areas. */
export interface TexProblemInput {
  title: string;
  prompt: string;
  solution?: string;
  hints?: string;
  preamble?: string;
  tags?: string[];
}

export function importTexProblem(input: TexProblemInput): SigmaDocument {
  const sources = [input.preamble ?? "", input.prompt, input.solution ?? "", input.hints ?? ""];
  if (sources.reduce((length, source) => length + source.length, input.title.length) > MAX_TEX_CHARS) {
    throw new Error("TeXファイルが大きすぎます。2MB以下のファイルを選んでください。");
  }
  const normalized = sources.map((source) => stripTexComments(source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")));
  const macros = collectTexMacroDefinitions(normalized.join("\n"));
  // Validate declarations in the preamble too, even though it is not body content.
  const bodies = normalized.map(removeTexMacroDefinitions);
  const createId = createTexIdFactory();
  const convert = (source: string) => texSourceToRichBlocks(expandTexMacros(extractDocumentBody(source), macros), createId);
  const prompt = convert(bodies[1]);
  if (!prompt.length) throw new Error("TeXファイル内に取り込める本文が見つかりませんでした。");
  const title = input.title.trim() || "TeXインポート";
  return parseSigmaDocument(ensurePageLayout({
    version: "2.0", docId: createDocumentImportId("doc"), metadata: { title },
    content: [{
      type: "problem", id: createId("problem"), tags: [...new Set(input.tags ?? [])],
      lead: [textParagraph(title, createId)], prompt,
      solution: convert(bodies[2]), hints: convert(bodies[3]),
    }],
    outputProfiles: OUTPUT_PROFILES, updatedAt: new Date().toISOString(),
  }));
}

function createTexIdFactory(): TexIdFactory {
  const counts = new Map<string, number>();
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `tex_${prefix}_${next}`;
  };
}

function parseTopLevelTexBlocks(source: string, createId: TexIdFactory): SigmaBlock[] {
  const blocks: SigmaBlock[] = [];
  let buffer = "";
  let index = 0;

  const flushBuffer = () => {
    const richBlocks = texSourceToRichBlocks(buffer, createId);
    blocks.push(...richBlocks);
    buffer = "";
  };

  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      buffer += source.slice(index, math.endIndex);
      index = math.endIndex;
      continue;
    }

    const environment = readEnvironmentAt(source, index);
    if (environment && TOP_LEVEL_PROBLEM_ENVIRONMENTS.has(environment.name)) {
      flushBuffer();
      blocks.push(createProblemFromTex(environment, createId));
      index = environment.endIndex;
      continue;
    }

    if (environment) {
      buffer += source.slice(index, environment.endIndex);
      index = environment.endIndex;
      continue;
    }

    const command = readCommandAt(source, index);
    if (command) {
      const rulecenterProblem = readRulecenterProblemMarker(source, command);
      if (rulecenterProblem) {
        flushBuffer();
        const endIndex = findNextRulecenterProblemBoundary(source, rulecenterProblem.endIndex);
        blocks.push(createProblemFromTex({
          name: "problem",
          option: rulecenterProblem.title,
          contentStartIndex: rulecenterProblem.endIndex,
          body: source.slice(rulecenterProblem.endIndex, endIndex),
          endIndex,
        }, createId));
        index = endIndex;
        continue;
      }

      const heading = readHeadingCommand(source, command, createId);
      if (heading) {
        flushBuffer();
        blocks.push(heading.block);
        index = heading.endIndex;
        continue;
      }

      if (IGNORED_TOP_LEVEL_COMMANDS.has(command.name)) {
        index = skipCommandArguments(source, command.endIndex);
        continue;
      }
    }

    buffer += source[index];
    index += 1;
  }

  flushBuffer();
  return blocks;
}

function readRulecenterProblemMarker(source: string, command: TexCommand): { title: string; endIndex: number } | null {
  if (command.name !== "rulecenter") {
    return null;
  }
  const group = readBraceGroup(source, command.endIndex);
  if (!group) {
    return null;
  }
  const title = group.value.trim();
  if (!/^問題/.test(title)) {
    return null;
  }
  return { title, endIndex: group.endIndex };
}

function findNextRulecenterProblemBoundary(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      index = math.endIndex;
      continue;
    }

    const environment = readEnvironmentAt(source, index);
    if (environment) {
      index = environment.endIndex;
      continue;
    }
    const command = readCommandAt(source, index);
    if (!command) {
      index += 1;
      continue;
    }

    if (command.name === "rulecenter" && readRulecenterProblemMarker(source, command)) {
      return index;
    }

    if (command.name === "section") {
      return index;
    }

    index = Math.max(command.endIndex, index + 1);
  }
  return source.length;
}

function readHeadingCommand(
  source: string,
  command: TexCommand,
  createId: TexIdFactory,
): { block: SigmaBlock; endIndex: number } | null {
  const level = headingLevelFromCommand(command.name);
  if (!level) {
    return null;
  }
  const group = readBraceGroup(source, command.endIndex);
  if (!group) {
    return null;
  }

  if (command.name === "section") {
    return {
      block: {
        type: "section",
        id: createId("section"),
        title: texToPlainText(group.value, createId),
      },
      endIndex: group.endIndex,
    };
  }

  return {
    block: createHeading(level, group.value, createId),
    endIndex: group.endIndex,
  };
}

function headingLevelFromCommand(commandName: string): 1 | 2 | 3 | null {
  if (commandName === "section") {
    return 1;
  }
  if (commandName === "subsection") {
    return 2;
  }
  if (commandName === "subsubsection" || commandName === "paragraph") {
    return 3;
  }
  return null;
}

function texSourceToRichBlocks(source: string, createId: TexIdFactory, forcedAlign?: TextAlign): Array<RichBlock | CodeBlockNode> {
  const blocks: Array<RichBlock | CodeBlockNode> = [];
  let buffer = "";
  let index = 0;

  const flushBuffer = () => {
    const paragraphs = splitTexParagraphs(buffer)
      .map((paragraph) => createParagraphFromTex(paragraph, createId, forcedAlign))
      .filter((block): block is ParagraphNode => Boolean(block));
    blocks.push(...paragraphs);
    buffer = "";
  };

  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      if (math.display) {
        flushBuffer();
        const children: InlineNode[] = [];
        appendMathNode(children, math.tex, createId);
        if (children.length) blocks.push({ type: "paragraph", id: createId("p"), align: forcedAlign ?? "center", children });
      } else {
        buffer += source.slice(index, math.endIndex);
      }
      index = math.endIndex;
      continue;
    }

    const environment = readEnvironmentAt(source, index);
    if (environment && LIST_ENVIRONMENTS.has(environment.name)) {
      flushBuffer();
      blocks.push(...createListBlocks(environment, createId, forcedAlign));
      index = environment.endIndex;
      continue;
    }

    if (environment?.name === "itembox") {
      flushBuffer();
      blocks.push(...createItemboxBlocks(environment, createId, forcedAlign));
      index = environment.endIndex;
      continue;
    }

    if (environment && TRANSPARENT_TEXT_ENVIRONMENTS.has(environment.name)) {
      flushBuffer();
      blocks.push(...texSourceToRichBlocks(environment.body, createId, forcedAlign));
      index = environment.endIndex;
      continue;
    }

    if (environment && isAlignedTextEnvironment(environment.name)) {
      flushBuffer();
      blocks.push(...texSourceToRichBlocks(environment.body, createId, alignFromEnvironment(environment.name)));
      index = environment.endIndex;
      continue;
    }

    if (environment) {
      flushBuffer();
      blocks.push({ type: "codeBlock", id: createId("code"), language: "latex", children: [{ type: "text", text: source.slice(index, environment.endIndex) }] });
      index = environment.endIndex;
      continue;
    }

    const command = readCommandAt(source, index);
    if (command && IGNORED_TOP_LEVEL_COMMANDS.has(command.name)) {
      index = skipCommandArguments(source, command.endIndex);
      continue;
    }
    const level = command ? headingLevelFromCommand(command.name) : null;
    if (command && level) {
      const group = readBraceGroup(source, command.endIndex);
      if (group) {
        flushBuffer();
        blocks.push(createHeading(level, group.value, createId));
        index = group.endIndex;
        continue;
      }
    }

    buffer += source[index];
    index += 1;
  }

  flushBuffer();
  return blocks;
}

function splitTexParagraphs(source: string): string[] {
  const paragraphs: string[] = [];
  let buffer = "";
  let blankLine = false;

  for (const line of source.split("\n")) {
    if (line.trim() === "") {
      if (buffer.trim() !== "") {
        blankLine = true;
      }
      continue;
    }

    if (blankLine && buffer.trim() !== "") {
      paragraphs.push(buffer.trim());
      buffer = "";
    }
    buffer += buffer ? `\n${line}` : line;
    blankLine = false;
  }

  if (buffer.trim() !== "") {
    paragraphs.push(buffer.trim());
  }
  return paragraphs;
}

function createHeading(level: 1 | 2 | 3, source: string, createId: TexIdFactory): HeadingNode {
  const children = texToInlineNodes(source, createId);
  return {
    type: "heading",
    id: createId("heading"),
    level,
    children: children.length > 0 ? children : [{ type: "text", text: "" }],
  };
}

function createParagraphFromTex(source: string, createId: TexIdFactory, forcedAlign?: TextAlign): ParagraphNode | null {
  const cleanSource = source
    .replace(/\\(?:noindent|smallskip|medskip|bigskip)\b/g, "")
    .trim();
  if (!cleanSource) {
    return null;
  }

  const isCentered = forcedAlign === "center" || /^\\centering\b/.test(cleanSource);
  const withoutAlignmentCommand = cleanSource.replace(/^\\centering\b\s*/, "");
  const children = texToInlineNodes(withoutAlignmentCommand, createId);
  if (children.length === 0) {
    return null;
  }

  return {
    type: "paragraph",
    id: createId("p"),
    children,
    align: isCentered ? "center" : forcedAlign,
  };
}

function createListBlocks(environment: TexEnvironment, createId: TexIdFactory, forcedAlign?: TextAlign): ListNode[] {
  const options = environment.name === "enumerate" ? readListOptions(environment.option) : {};
  const lists: ListNode[] = [];
  let nextNumber = options.start ?? 1;
  for (const item of splitListItems(environment.body)) {
    const explicitNumber = readNumericItemLabel(item.label);
    const numbering = explicitNumber ?? { start: nextNumber, markerStyle: options.markerStyle };
    const label = explicitNumber ? [] : listItemLabelNodes(environment.name, nextNumber, item.label, createId);
    const { body, nested } = extractNestedListsFromItemSource(item.source, createId, forcedAlign);
    const itemBlocks = texSourceToRichBlocks(body, createId, forcedAlign);
    // SigmaDoc list continuations support paragraphs/headings; preserve code as literal text here.
    const paragraphs = itemBlocks.flatMap((block): Array<ParagraphNode | HeadingNode> => {
      if (block.type === "list") return [];
      if (block.type === "codeBlock") return [{ ...block, type: "paragraph" }];
      return [block];
    });
    const [first, ...continuations] = paragraphs;
    const children = prefixInlineNodes(label, first?.children ?? []);
    if (!children.length && !nested.length) continue;
    const listType = explicitNumber || environment.name === "enumerate" ? "ordered" : "bullet";
    let list = lists.at(-1);
    if (!list || list.listType !== listType || list.markerStyle !== numbering.markerStyle
      || (listType === "ordered" && (list.start ?? 1) + list.items.length !== numbering.start)) {
      list = { type: "list", id: createId("list"), listType, items: [],
        ...(listType === "ordered" ? numbering : {}) };
      lists.push(list);
    }
    list.items.push({
      type: "listItem", id: createId("li"), children,
      ...(first?.align ? { align: first.align } : {}),
      ...(continuations.length ? { continuations } : {}),
      ...(nested.length ? { nested } : {}),
    });
    nextNumber = (numbering.start ?? nextNumber) + 1;
  }
  return lists;
}

function extractNestedListsFromItemSource(
  source: string,
  createId: TexIdFactory,
  forcedAlign?: TextAlign,
): { body: string; nested: ListNode[] } {
  const nested: ListNode[] = [];
  let body = "";
  let index = 0;

  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      body += source.slice(index, math.endIndex);
      index = math.endIndex;
      continue;
    }

    const environment = readEnvironmentAt(source, index);
    if (environment && LIST_ENVIRONMENTS.has(environment.name)) {
      nested.push(...createListBlocks(environment, createId, forcedAlign));
      body += " ";
      index = environment.endIndex;
      continue;
    }

    body += source[index];
    index += 1;
  }

  return {
    body: body.trim(),
    nested,
  };
}

function createItemboxBlocks(environment: TexEnvironment, createId: TexIdFactory, forcedAlign?: TextAlign): Array<RichBlock | CodeBlockNode> {
  const { title, body } = splitItemboxTitleAndBody(environment.body);
  const blocks = texSourceToRichBlocks(body, createId, forcedAlign);
  if (!title) return blocks;
  const titleNodes = texToInlineNodes(`【${title}】`, createId);
  const [firstBlock, ...restBlocks] = blocks;
  if (firstBlock?.type === "paragraph") {
    return [{ ...firstBlock, children: [...titleNodes, { type: "text", text: " " }, ...firstBlock.children] }, ...restBlocks];
  }
  return [{ type: "paragraph", id: createId("p"), children: titleNodes, align: forcedAlign }, ...blocks];
}

function splitItemboxTitleAndBody(source: string): { title: string | null; body: string } {
  const group = readBraceGroup(source, 0);
  if (!group) {
    return { title: null, body: source };
  }
  return {
    title: group.value.trim(),
    body: source.slice(group.endIndex),
  };
}

function splitListItems(source: string): Array<{ label?: string; source: string }> {
  const items: Array<{ label?: string; source: string }> = [];
  let current = "";
  let currentLabel: string | undefined;
  let index = 0;

  const flush = () => {
    if (current.trim()) {
      items.push({ label: currentLabel, source: current.trim() });
    }
    current = "";
    currentLabel = undefined;
  };

  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      current += source.slice(index, math.endIndex);
      index = math.endIndex;
      continue;
    }

    const environment = readEnvironmentAt(source, index);
    if (environment) {
      current += source.slice(index, environment.endIndex);
      index = environment.endIndex;
      continue;
    }

    const command = readCommandAt(source, index);
    if (command?.name === "item") {
      flush();
      const labelGroup = readBracketGroup(source, command.endIndex);
      currentLabel = labelGroup?.value.trim();
      index = labelGroup?.endIndex ?? command.endIndex;
      continue;
    }

    current += source[index];
    index += 1;
  }

  flush();
  return items;
}

function listItemLabelNodes(
  environmentName: string,
  _itemNumber: number,
  explicitLabel: string | undefined,
  createId: TexIdFactory,
): InlineNode[] {
  if (explicitLabel) {
    return [...texToInlineNodes(explicitLabel, createId), { type: "text", text: " " }];
  }
  if (environmentName === "description") {
    return [];
  }
  return [];
}

function prefixInlineNodes(prefix: InlineNode[], children: InlineNode[]): InlineNode[] {
  if (prefix.length === 0) {
    return children;
  }
  return [...prefix, ...children];
}

function createProblemFromTex(environment: TexEnvironment, createId: TexIdFactory): ProblemNode {
  const title = environment.option ? texToPlainText(environment.option, createId).trim() : "";
  const areas = extractProblemAreas(environment.body);
  const prompt = texSourceToRichBlocks(areas.promptSource, createId);
  const solution = areas.solutionSources.flatMap((source) => texSourceToRichBlocks(source, createId));
  const hints = areas.hintSources.flatMap((source) => texSourceToRichBlocks(source, createId));
  const lead = title ? [textParagraph(title, createId)] : [];
  const tag = title.replace(/[#\s　]/g, "");

  return {
    type: "problem",
    id: createId("problem"),
    tags: tag ? [tag] : [],
    lead,
    prompt: prompt.length > 0 ? prompt : [emptyParagraph(createId)],
    answer: createAnswerDefinition(areas.answerSources.join("\n\n"), createId),
    solution,
    hints,
  };
}

/** One pass preserves source order when command and environment forms are mixed. */
function extractProblemAreas(source: string): ProblemAreas {
  const result: ProblemAreas = { promptSource: "", solutionSources: [], hintSources: [], answerSources: [] };
  let index = 0;
  while (index < source.length) {
    const math = readMathAt(source, index);
    if (math) {
      result.promptSource += source.slice(index, math.endIndex);
      index = math.endIndex;
      continue;
    }
    const environment = readEnvironmentAt(source, index);
    if (environment) {
      if (isProblemAreaEnvironment(environment.name)) {
        pushProblemAreaSource(result, environment.name, environment.body);
      } else {
        result.promptSource += source.slice(index, environment.endIndex);
      }
      index = environment.endIndex;
      continue;
    }
    const command = readCommandAt(source, index);
    if (command) {
      const group = readBraceGroup(source, command.endIndex);
      if (group && AREA_COMMANDS.has(command.name)) {
        pushProblemAreaSource(result, command.name, group.value);
        index = group.endIndex;
        continue;
      }
      if (group && command.name === "ovalbox" && group.value.trim() === "解答") {
        result.solutionSources.push(source.slice(group.endIndex));
        break;
      }
    }
    // A group's content belongs to its surrounding text command, not to problem structure.
    const group = source[index] === "{" ? readBraceGroup(source, index) : null;
    if (group) {
      result.promptSource += source.slice(index, group.endIndex);
      index = group.endIndex;
      continue;
    }
    result.promptSource += source[index++];
  }
  return result;
}

function isProblemAreaEnvironment(environmentName: string): boolean {
  return SOLUTION_ENVIRONMENTS.has(environmentName)
    || HINT_ENVIRONMENTS.has(environmentName)
    || ANSWER_ENVIRONMENTS.has(environmentName);
}

function pushProblemAreaSource(
  result: Pick<ProblemAreas, "solutionSources" | "hintSources" | "answerSources">,
  areaName: string,
  source: string,
) {
  if (SOLUTION_ENVIRONMENTS.has(areaName) || areaName === "solution") {
    result.solutionSources.push(source);
    return;
  }
  if (HINT_ENVIRONMENTS.has(areaName) || areaName === "hint") {
    result.hintSources.push(source);
    return;
  }
  result.answerSources.push(source);
}

function createAnswerDefinition(source: string, createId: TexIdFactory): AnswerDefinition | undefined {
  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }

  const math = extractSingleMathTex(trimmed);
  if (math !== null) {
    return { type: "math", expected: math };
  }

  return {
    type: "text",
    expected: texToPlainText(trimmed, createId),
  };
}

function extractSingleMathTex(source: string): string | null {
  const math = readMathAt(source, 0);
  return math?.endIndex === source.length ? math.tex : null;
}

function textParagraph(text: string, createId: TexIdFactory): ParagraphNode {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [{ type: "text", text }],
  };
}

function emptyParagraph(createId: TexIdFactory): ParagraphNode {
  return {
    type: "paragraph",
    id: createId("p"),
    children: [{ type: "text", text: "" }],
  };
}

function texToPlainText(source: string, createId: TexIdFactory): string {
  return inlineNodesToPlainText(texToInlineNodes(source, createId)).trim();
}

function inlineNodesToPlainText(children: InlineNode[]): string {
  return children.map((child) => child.type === "mathInline" ? child.tex : child.text).join("");
}

export function texToInlineNodes(source: string, createId: TexIdFactory): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let index = 0;

  const flushText = () => {
    appendInlineNodes(nodes, texTextToInlineNodes(buffer));
    buffer = "";
  };

  while (index < source.length) {
    const command = readCommandAt(source, index);
    const mark = command ? MARK_COMMANDS[command.name] : undefined;
    if (command && (mark || UNWRAP_TEXT_COMMANDS.has(command.name))) {
      const group = readCommandContentGroup(source, command.endIndex);
      if (group) {
        flushText();
        const children = texToInlineNodes(group.value, createId);
        appendInlineNodes(nodes, children.map((node): InlineNode => {
          if (!mark) return node;
          if (node.type === "text") return { ...node, marks: addMark(node.marks ?? [], mark) };
          if (mark === "boxed" || mark === "underline") return { ...node, marks: [...new Set([...(node.marks ?? []), mark])] };
          return node;
        }));
        index = group.endIndex;
        continue;
      }
    }

    const math = readMathAt(source, index);
    if (math) {
      flushText();
      appendMathNode(nodes, math.tex, createId);
      index = math.endIndex;
      continue;
    }

    buffer += source[index];
    index += 1;
  }

  flushText();
  return nodes;
}

function appendMathNode(nodes: InlineNode[], tex: string, createId: TexIdFactory) {
  if (!tex) {
    return;
  }
  nodes.push({
    type: "mathInline",
    id: createId("math"),
    tex,
    display: "inline",
  });
}

function texTextToInlineNodes(source: string, activeMarks: TextMark[] = []): TextInlineNode[] {
  const nodes: TextInlineNode[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    const text = normalizeTextSegment(buffer);
    if (text) {
      appendTextNode(nodes, text, activeMarks);
    }
    buffer = "";
  };

  while (index < source.length) {
    const command = readCommandAt(source, index);
    if (command) {
      const mark = MARK_COMMANDS[command.name];
      const group = readCommandContentGroup(source, command.endIndex);
      if (command.name === "rule") {
        const width = readCommandContentGroup(source, command.endIndex);
        const height = width ? readBraceGroup(source, width.endIndex) : null;
        if (height) {
          index = height.endIndex;
          continue;
        }
      }

      if (command.name === "includegraphics") {
        const filename = group ? texToImageFilename(group.value) : "";
        flush();
        appendTextNode(nodes, filename ? `［画像: ${filename}］` : "［画像］", activeMarks);
        index = group?.endIndex ?? skipCommandArguments(source, command.endIndex);
        continue;
      }

      if (command.name === "footnote" && group) {
        flush();
        appendTextNode(nodes, "（注: ", activeMarks);
        appendTextNodes(nodes, texTextToInlineNodes(group.value, activeMarks));
        appendTextNode(nodes, "）", activeMarks);
        index = group.endIndex;
        continue;
      }

      if (command.name === "maru") {
        const argument = readCommandArgument(source, command.endIndex);
        if (argument) {
          buffer += circledText(texTextToInlineNodes(argument.value).map((node) => node.text).join(""));
          index = argument.endIndex;
          continue;
        }
      }

      if (command.name === "textcircled" && group) {
        flush();
        appendTextNode(nodes, circledText(texTextToInlineNodes(group.value).map((node) => node.text).join("")), activeMarks);
        index = group.endIndex;
        continue;
      }

      if (mark && group) {
        flush();
        appendTextNodes(nodes, texTextToInlineNodes(group.value, addMark(activeMarks, mark)));
        index = group.endIndex;
        continue;
      }

      if (UNWRAP_TEXT_COMMANDS.has(command.name) && group) {
        flush();
        appendTextNodes(nodes, texTextToInlineNodes(group.value, activeMarks));
        index = group.endIndex;
        continue;
      }

      if (TEXT_SYMBOL_COMMANDS[command.name]) {
        buffer += TEXT_SYMBOL_COMMANDS[command.name];
        index = command.endIndex;
        continue;
      }

      if (IGNORED_TEXT_COMMANDS.has(command.name)) {
        index = skipCommandArguments(source, command.endIndex);
        continue;
      }

      if (TEXT_SPACING_COMMANDS.has(command.name)) {
        buffer += " ";
        index = command.endIndex;
        continue;
      }

      buffer += `\\${command.name}${command.starred ? "*" : ""}`;
      index = command.endIndex;
      continue;
    }

    if (source[index] === "\\") {
      const escaped = source[index + 1];
      if (escaped) {
        if (escaped === "\\") {
          flush();
          appendTextNode(nodes, "\n", activeMarks);
        } else {
          buffer += escapedTextCharacter(escaped);
        }
        index += 2;
        continue;
      }
    }

    buffer += source[index];
    index += 1;
  }

  flush();
  return nodes;
}

function texToImageFilename(source: string): string {
  return source.trim().replace(/^["']|["']$/g, "");
}

function circledText(value: string): string {
  const normalized = value.trim();
  const numericValue = Number(normalized);
  if (Number.isInteger(numericValue) && numericValue >= 1 && numericValue <= 20) {
    return String.fromCodePoint(0x2460 + numericValue - 1);
  }
  return normalized ? `(${normalized})` : "";
}

function normalizeTextSegment(text: string): string {
  return text
    .replace(/\n/g, " ")
    .replace(/~/g, " ")
    .replace(/[ \t\f\v]+/g, " ");
}

function appendInlineNodes(target: InlineNode[], nodes: InlineNode[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      appendTextNode(target, node.text, node.marks);
      continue;
    }
    target.push(node);
  }
}

function appendTextNodes(target: TextInlineNode[], nodes: TextInlineNode[]) {
  for (const node of nodes) {
    appendTextNode(target, node.text, node.marks);
  }
}

function appendTextNode(target: InlineNode[], text: string, marks?: TextMark[]) {
  if (!text) {
    return;
  }
  const normalizedMarks = marks && marks.length > 0 ? [...marks] : undefined;
  const last = target[target.length - 1];
  if (
    last?.type === "text"
    && JSON.stringify(last.marks ?? []) === JSON.stringify(normalizedMarks ?? [])
  ) {
    last.text += text;
    return;
  }
  target.push(normalizedMarks ? { type: "text", text, marks: normalizedMarks } : { type: "text", text });
}

function addMark(marks: TextMark[], mark: TextMark): TextMark[] {
  return marks.includes(mark) ? marks : [...marks, mark];
}

function escapedTextCharacter(character: string): string {
  if (character === "\\" || character === " ") {
    return "\n";
  }
  if (character === "," || character === ";" || character === ":") {
    return " ";
  }
  if ("{}$&_#%~^".includes(character)) {
    return character;
  }
  return character;
}

function extractTexTitle(source: string, createId: TexIdFactory, macros: Map<string, TexMacroDefinition>): string | null {
  let index = 0;
  while (index < source.length) {
    const command = readCommandAt(source, index);
    if (command?.name === "title") {
      const group = readBraceGroup(source, command.endIndex);
      if (group) {
        const title = texToPlainText(expandTexMacros(group.value, macros), createId);
        return title || null;
      }
    }
    index += 1;
  }
  return null;
}

function extractDocumentBody(source: string): string {
  let index = 0;
  while (index < source.length) {
    const environment = readEnvironmentAt(source, index);
    if (environment?.name === "document") {
      return environment.body;
    }
    index += 1;
  }
  return source;
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "") || "TeXインポート";
}

function isAlignedTextEnvironment(environmentName: string): boolean {
  return environmentName === "center" || environmentName === "flushright" || environmentName === "flushleft";
}

function alignFromEnvironment(environmentName: string): TextAlign {
  if (environmentName === "center") {
    return "center";
  }
  if (environmentName === "flushright") {
    return "right";
  }
  return "left";
}
