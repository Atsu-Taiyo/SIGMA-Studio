import { getTableCellMatrix } from "./table-grid";
import { inlineNodesToPlainText } from "./rich-text";
import { parseChartNumber } from "./table-number";
import type { SigmaTableCellPlacement } from "./table-grid";
import type { InlineNode, TextInlineNode } from "./rich-text";
import type { SigmaTableCell, SigmaTableCellParagraph, SigmaTableSpec } from "../overlay-model";

/**
 * The Excel error values this engine can produce.
 *
 * They are the canonical ASCII spellings on purpose: this is the document layer, so the value a
 * formula cell holds must not depend on the viewer's language. Localized wording belongs in a
 * tooltip drawn by the UI, never in what the cell displays.
 */
export type SigmaTableFormulaErrorCode =
  | "#DIV/0!"
  | "#NAME?"
  | "#REF!"
  | "#VALUE!"
  | "#NUM!"
  | "#N/A"
  | "#CYCLE!";

/** What one cell holds, once formulas are resolved. */
export type SigmaTableCellValue =
  | { kind: "number"; value: number }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "error"; code: SigmaTableFormulaErrorCode };

export interface SigmaTableFormulaResult {
  /** The source as written, `=` included. */
  source: string;
  value: SigmaTableCellValue;
  /** Locale-independent display text: the number, the text, or the error code. */
  display: string;
  error: SigmaTableFormulaErrorCode | null;
}

export interface SigmaTableEvaluation {
  /**
   * Keyed by `SigmaTableCell.id`, holding only the cells that carry a formula this engine could
   * parse. A cell whose source cannot be parsed is absent on purpose — the surfaces then draw the
   * source text as written, which is how an in-progress `=SUM(A1` keeps looking like what was typed
   * instead of turning into an error value.
   */
  byCellId: ReadonlyMap<string, SigmaTableFormulaResult>;
  /**
   * The same results, keyed by the cell object itself. **Prefer this for anything that draws** —
   * `byCellId` cannot tell two cells apart when a document gives them the same id.
   *
   * This is what the drawing surfaces read. Nothing validates that `cells[].id` is unique — the
   * schema checks row and column ids but not cell ids — so a document giving an ordinary cell the
   * same id as a formula cell would make the ordinary one *display the formula's value* on the
   * canvas, in print and in the exported SVG, while its stored text stayed untouched. Identity
   * cannot be forged by a document.
   */
  byCell: WeakMap<SigmaTableCell, SigmaTableFormulaResult>;
}

const MAX_FORMULA_LENGTH = 4_096;
const MAX_PARSE_STEPS = 20_000;
const MAX_RECURSION_DEPTH = 128;
/**
 * Compiled forms are pure functions of the source text, so they are cached across calls, the same
 * way `features/drawing/math-expression.ts` caches its own. A formula is re-evaluated on every
 * keystroke while its cell is being edited and once per surface that draws the table.
 */
const MAX_COMPILED_CACHE_ENTRIES = 512;
/** The most cells one `A1:B5` may cover. Past this the range is refused rather than walked. */
const MAX_RANGE_CELLS = 4_096;
/** The most formula cells one table evaluation resolves. */
const MAX_EVALUATED_CELLS = 4_096;
/**
 * How deep a chain of cells referencing cells may go.
 *
 * Set well past any believable table because it is *not* the stack guard — `MAX_EVALUATION_FRAMES`
 * is. A cap tight enough to protect the stack on its own would fire before `visiting` ever detects
 * re-entry, and a long circular chain would report `#NUM!` instead of `#CYCLE!`.
 */
const MAX_REFERENCE_DEPTH = 1_024;
/**
 * The real stack guard: live nesting levels, counting reference hops and function calls together.
 *
 * They have to share one counter because they multiply. One formula may nest `MAX_RECURSION_DEPTH`
 * calls, and each call node costs several JS frames, so 1,024 hops each sitting inside 128 nested
 * calls is ~130,000 frames — far past V8's limit — even though both factors are individually legal.
 */
const MAX_EVALUATION_FRAMES = 1_024;
/** Work budget for one formula, so a single heavy cell cannot starve the rest of the table. */
const MAX_FORMULA_EVALUATION_STEPS = 250_000;
/** Work budget for the whole table pass. */
const MAX_TABLE_EVALUATION_STEPS = 2_000_000;
/** `ROUND` past this many digits is refused rather than shifted into an exponent that overflows. */
const MAX_ROUND_DIGITS = 100;
/** Decimals kept when displaying a number, which is also what hides binary floating-point noise. */
const MAX_DISPLAY_DECIMALS = 9;

type FormulaErrorValue = Extract<SigmaTableCellValue, { kind: "error" }>;
type FormulaNumberValue = Extract<SigmaTableCellValue, { kind: "number" }>;

const ERROR_DIV0: FormulaErrorValue = { kind: "error", code: "#DIV/0!" };
const ERROR_NAME: FormulaErrorValue = { kind: "error", code: "#NAME?" };
const ERROR_REF: FormulaErrorValue = { kind: "error", code: "#REF!" };
const ERROR_VALUE: FormulaErrorValue = { kind: "error", code: "#VALUE!" };
const ERROR_NUM: FormulaErrorValue = { kind: "error", code: "#NUM!" };
const ERROR_NA: FormulaErrorValue = { kind: "error", code: "#N/A" };
const ERROR_CYCLE: FormulaErrorValue = { kind: "error", code: "#CYCLE!" };
const EMPTY: Extract<SigmaTableCellValue, { kind: "empty" }> = { kind: "empty" };
const ZERO: FormulaNumberValue = { kind: "number", value: 0 };

/**
 * A range only exists between a reference and the function reading it, so it is not a cell value.
 * Putting one where a single value belongs (`=A1:A3+1`) is `#VALUE!`, as in Excel.
 */
type FormulaValue = SigmaTableCellValue | { kind: "range"; cells: readonly SigmaTableCellValue[] };

interface CellAddress {
  rowIndex: number;
  columnIndex: number;
}

interface EvaluationContext {
  readCell(address: CellAddress): SigmaTableCellValue;
  readRange(start: CellAddress, end: CellAddress): FormulaValue;
  /** Charges one nesting level against the stack budget. Throws once the budget is spent. */
  enterFrame(): void;
  leaveFrame(): void;
}

type FormulaNode = (context: EvaluationContext) => FormulaValue;

/** Thrown when a budget runs out; caught at the boundary, where it becomes `#NUM!`. */
class FormulaBudgetExhausted extends Error {}

/**
 * Thrown only by the parser, and only for text it cannot read.
 *
 * It exists so `compileTableFormula` can separate two things that both arrive as exceptions: this
 * string is not a formula, which is a durable fact about the text and worth caching, and something
 * went wrong while we happened to be parsing, which says nothing about the text at all.
 */
class FormulaParseError extends Error {}

/**
 * The formula a cell carries, or `null` when it carries something else.
 *
 * A formula cell is one paragraph of plain text starting with `=`. A cell holding an inline math
 * node, a trend arrow, or a second paragraph is deliberately *not* a formula: those carry structure
 * that flattening to a source string would silently discard.
 */
export function getTableCellFormulaSource(cell: SigmaTableCell | undefined): string | null {
  if (!cell || cell.content.length !== 1) {
    return null;
  }
  const content = cell.content[0];
  if (content.type !== "paragraph") {
    return null;
  }
  if (content.children.some((child) => child.type !== "text")) {
    return null;
  }
  const source = inlineNodesToPlainText(content.children).trim();
  if (!source.startsWith("=") || source.length > MAX_FORMULA_LENGTH) {
    return null;
  }
  return source;
}

/**
 * Every formula in one table, evaluated.
 *
 * Memoized on the identity of the table, which is both the arithmetic saved and the point: the SVG
 * export memoizes table markup on the identity of what it is handed, so returning a fresh map per
 * call would make that cache miss on every render — the same reason `resolveChartData` memoizes.
 * The overlay model treats a `SigmaTableSpec` as an immutable snapshot, so identity is a sound key
 * with no invalidation logic, and the map is held weakly so nothing needs evicting.
 *
 * References resolve inside this table only. That is not a simplification of the feature but a
 * consequence of the render port: `renderTableHtml` is handed one table and no neighbours, so a
 * cross-table reference could not be resolved on the static path at all.
 */
export function evaluateTableFormulas(table: SigmaTableSpec): SigmaTableEvaluation {
  const cached = evaluationCache.get(table);
  if (cached) {
    return cached;
  }
  const evaluation = evaluateTable(table);
  evaluationCache.set(table, evaluation);
  return evaluation;
}

const evaluationCache = new WeakMap<SigmaTableSpec, SigmaTableEvaluation>();

/**
 * The colour an error value is drawn in — `--danger` in `globals.css`, as a literal.
 *
 * It travels on the projected run rather than in a stylesheet because the same nodes are drawn into
 * the self-contained SVG export, which is viewed with no stylesheet at all.
 */
export const TABLE_FORMULA_ERROR_COLOR = "#b42318";

/**
 * The evaluation of the formula this paragraph holds, or `null` when it holds something else.
 *
 * `null` covers three cases that all mean the same thing to a caller — the cell is not a formula,
 * the formula could not be parsed, or this paragraph is not the one the formula was typed into —
 * and in every one of them the cell should be drawn exactly as it is stored.
 */
export function getTableCellFormulaResult(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
  content: SigmaTableCellParagraph,
): SigmaTableFormulaResult | null {
  if (!cell || cell.content.length !== 1 || cell.content[0] !== content) {
    return null;
  }
  return evaluateTableFormulas(table).byCell.get(cell) ?? null;
}

/**
 * What a cell's paragraph should draw: the evaluated value for a formula, its own nodes otherwise.
 *
 * Every surface that draws a table cell ends at an `InlineNode[]`, so projecting the value back
 * into that shape is what lets the editing canvas, the static tree, the print path, the SVG export
 * and the settings preview all show the same thing by changing one argument each — and it adds no
 * DOM, which the editing/display parity tests compare geometrically.
 */
export function getTableCellDisplayNodes(
  table: SigmaTableSpec,
  cell: SigmaTableCell | undefined,
  content: SigmaTableCellParagraph,
): readonly InlineNode[] {
  const result = getTableCellFormulaResult(table, cell, content);
  if (!result) {
    return content.children;
  }
  let byContent = displayNodesCache.get(result);
  if (!byContent) {
    byContent = new WeakMap();
    displayNodesCache.set(result, byContent);
  }
  const cached = byContent.get(content);
  if (cached) {
    return cached;
  }
  const projected = projectFormulaValue(result, content.children);
  byContent.set(content, projected);
  return projected;
}

/**
 * Keyed on the result first: a result object is created fresh by each table evaluation, so a table
 * that changed cannot serve the projection computed for the one before it — even where structural
 * sharing handed the new table the very same paragraph object.
 */
const displayNodesCache = new WeakMap<
  SigmaTableFormulaResult,
  WeakMap<SigmaTableCellParagraph, readonly InlineNode[]>
>();

/**
 * One run carrying the value, wearing the formatting of the run the formula was typed into.
 *
 * Collapsing to a single run is deliberate: a formula is one value, and splitting it across the
 * source's runs would put a bold `=` in front of a plain number.
 */
function projectFormulaValue(
  result: SigmaTableFormulaResult,
  children: readonly InlineNode[],
): readonly InlineNode[] {
  // The longest text run, not the first: an author who bolds only the leading `=` (or pastes a
  // partially formatted formula) would otherwise have the whole value painted with the `=`'s
  // formatting. The run carrying the body of the formula is the one that describes the value.
  let template: TextInlineNode | undefined;
  for (const child of children) {
    if (child.type === "text" && (!template || child.text.length > template.text.length)) {
      template = child;
    }
  }
  const projected: TextInlineNode = {
    ...(template ?? {}),
    type: "text",
    text: result.display,
    // Copied, not shared: this node is cached and handed to every renderer, and aliasing the array
    // would let anything that sorted or spliced marks in place edit the author's stored document
    // through something presented as a read-only projection.
    ...(template?.marks ? { marks: [...template.marks] } : {}),
  };
  if (result.error) {
    projected.color = TABLE_FORMULA_ERROR_COLOR;
  }
  return [projected];
}

function evaluateTable(table: SigmaTableSpec): SigmaTableEvaluation {
  const matrix = getTableCellMatrix(table);
  /**
   * Every formula in the table, parsed before a single one is evaluated.
   *
   * Compiling here rather than inside the reference walk is what keeps a parse from ever running on
   * a nearly-exhausted stack. `compileTableFormula` caches failures in a process-global map keyed
   * only on the source text, so a non-parse error mistaken for a parse error there would poison
   * that source string for every other table in the process.
   */
  const compiledByKey = new Map<string, FormulaNode>();
  const sourcesByKey = new Map<string, string>();
  for (const row of matrix.origins) {
    for (const placement of row) {
      const source = getTableCellFormulaSource(placement.cell);
      if (source === null) {
        continue;
      }
      const compiled = compileTableFormula(source);
      if (!compiled) {
        continue;
      }
      const key = `${placement.rowIndex}:${placement.columnIndex}`;
      compiledByKey.set(key, compiled);
      sourcesByKey.set(key, source);
    }
  }

  /** Resolved cell values, keyed by the grid position their origin sits at. */
  const resolved = new Map<string, SigmaTableCellValue>();
  /** Positions currently being evaluated; re-entering one is the cycle. */
  const visiting = new Set<string>();
  let tableSteps = 0;
  let formulaSteps = 0;
  let frames = 0;

  function step(): void {
    tableSteps += 1;
    formulaSteps += 1;
    if (tableSteps > MAX_TABLE_EVALUATION_STEPS || formulaSteps > MAX_FORMULA_EVALUATION_STEPS) {
      throw new FormulaBudgetExhausted();
    }
  }

  // Checked before incrementing so a refusal leaves the counter balanced: the caller only pairs a
  // `leaveFrame` with an `enterFrame` that returned.
  function enterFrame(): void {
    if (frames >= MAX_EVALUATION_FRAMES) {
      throw new FormulaBudgetExhausted();
    }
    frames += 1;
  }

  function leaveFrame(): void {
    frames -= 1;
  }

  function readCell(address: CellAddress): SigmaTableCellValue {
    step();
    const { rowIndex, columnIndex } = address;
    if (
      rowIndex < 0 || columnIndex < 0 ||
      rowIndex >= matrix.rowCount || columnIndex >= matrix.columnCount
    ) {
      return ERROR_REF;
    }
    const placement = matrix.occupants[rowIndex][columnIndex];
    // Only the origin of a merged cell holds its value. Reading the covered positions as the same
    // value would make `SUM(A1:B1)` count a two-column merge twice — the opposite of what the chart
    // derivation wants from `occupants`, where a merged header deliberately names every column.
    if (!placement || placement.rowIndex !== rowIndex || placement.columnIndex !== columnIndex) {
      return EMPTY;
    }
    return valueOfPlacement(placement);
  }

  function readRange(start: CellAddress, end: CellAddress): FormulaValue {
    const top = Math.min(start.rowIndex, end.rowIndex);
    const bottom = Math.max(start.rowIndex, end.rowIndex);
    const left = Math.min(start.columnIndex, end.columnIndex);
    const right = Math.max(start.columnIndex, end.columnIndex);
    if (top < 0 || left < 0 || bottom >= matrix.rowCount || right >= matrix.columnCount) {
      return ERROR_REF;
    }
    if ((bottom - top + 1) * (right - left + 1) > MAX_RANGE_CELLS) {
      return ERROR_NUM;
    }
    const cells: SigmaTableCellValue[] = [];
    for (let rowIndex = top; rowIndex <= bottom; rowIndex += 1) {
      for (let columnIndex = left; columnIndex <= right; columnIndex += 1) {
        cells.push(readCell({ rowIndex, columnIndex }));
      }
    }
    return { kind: "range", cells };
  }

  const context: EvaluationContext = { readCell, readRange, enterFrame, leaveFrame };

  function valueOfPlacement(placement: SigmaTableCellPlacement): SigmaTableCellValue {
    const cell = placement.cell;
    if (!cell) {
      return EMPTY;
    }
    const key = `${placement.rowIndex}:${placement.columnIndex}`;
    const memo = resolved.get(key);
    if (memo) {
      return memo;
    }
    // Deliberately not memoized: this cell is an ancestor of itself only along the path we are on.
    if (visiting.has(key)) {
      return ERROR_CYCLE;
    }
    const compiled = compiledByKey.get(key);
    if (!compiled) {
      const literal = readLiteralCellValue(cell);
      resolved.set(key, literal);
      return literal;
    }
    // Throwing rather than returning `#NUM!` here, because a limit says nothing about *this* cell —
    // only about the path that reached it. Memoizing the refusal would let whoever walked deepest
    // first decide the displayed value of a cell that is perfectly computable on its own.
    //
    // The cell cap counts *distinct* cells resolved, not entries: a walk that is refused memoizes
    // nothing, so its cells are re-entered by the next walk, and counting entries would spend the
    // whole allowance on retries of the same few cells. Total work stays bounded by the step
    // budgets either way.
    if (resolved.size >= MAX_EVALUATED_CELLS || visiting.size >= MAX_REFERENCE_DEPTH) {
      throw new FormulaBudgetExhausted();
    }
    visiting.add(key);
    enterFrame();
    let value: SigmaTableCellValue;
    try {
      value = toCellValue(compiled(context));
    } finally {
      leaveFrame();
      visiting.delete(key);
    }
    resolved.set(key, value);
    return value;
  }

  const byCellId = new Map<string, SigmaTableFormulaResult>();
  const byCell = new WeakMap<SigmaTableCell, SigmaTableFormulaResult>();
  for (const row of matrix.origins) {
    for (const placement of row) {
      const cell = placement.cell;
      const key = `${placement.rowIndex}:${placement.columnIndex}`;
      const source = sourcesByKey.get(key);
      if (!cell || source === undefined) {
        continue;
      }
      formulaSteps = 0;
      frames = 0;
      let value: SigmaTableCellValue;
      try {
        value = valueOfPlacement(placement);
      } catch {
        // Normally `FormulaBudgetExhausted`. The catch is deliberately blanket anyway: this function
        // must not throw, because a table that cannot be computed still has to render and an error
        // escaping here would take the whole document's paint down with it. The cost is that a
        // genuine defect in this module would surface as a `#NUM!` indistinguishable from a real
        // one, which is why the known non-budget throws (the stack, and spreading a large
        // population into `Math.max`) are prevented above rather than caught here.
        value = ERROR_NUM;
      }
      const result: SigmaTableFormulaResult = {
        source,
        value,
        display: formatCellValue(value),
        error: value.kind === "error" ? value.code : null,
      };
      byCellId.set(cell.id, result);
      byCell.set(cell, result);
    }
  }
  return { byCellId, byCell };
}

/** What a non-formula cell contributes: its number, its text, or nothing. */
function readLiteralCellValue(cell: SigmaTableCell): SigmaTableCellValue {
  // A trend cell is a direction arrow, never a measurement — the rule `chart-data.ts` already uses.
  if (cell.content.some((content) => content.type === "trend")) {
    return EMPTY;
  }
  const texts = cell.content
    .flatMap((content) => (
      content.type === "paragraph" ? [inlineNodesToPlainText(content.children)] : []
    ))
    .map((text) => text.trim())
    .filter((text) => text !== "");
  if (texts.length === 0) {
    return EMPTY;
  }
  // Two paragraphs are ambiguous rather than one value — splicing "1" and "2" would read as 12.
  if (texts.length > 1) {
    return { kind: "text", text: texts.join("\n") };
  }
  const parsed = parseChartNumber(texts[0]);
  return parsed === null ? { kind: "text", text: texts[0] } : { kind: "number", value: parsed };
}

/** The value a formula settles on. An empty reference reads as 0, the way `=A1` does in Excel. */
/**
 * A one-cell range is just that cell, the way `=A1:A1` is `=A1` in Excel.
 *
 * Users produce these by dragging a single-row selection, and refusing them would make a formula
 * fail for a reason invisible in the text.
 */
function unwrapSingleCellRange(value: FormulaValue): FormulaValue {
  return value.kind === "range" && value.cells.length === 1 ? value.cells[0] : value;
}

function toCellValue(input: FormulaValue): SigmaTableCellValue {
  const value = unwrapSingleCellRange(input);
  switch (value.kind) {
    case "range":
      return ERROR_VALUE;
    case "empty":
      return ZERO;
    case "number":
      return Number.isFinite(value.value) ? value : ERROR_NUM;
    default:
      return value;
  }
}

function formatCellValue(value: SigmaTableCellValue): string {
  switch (value.kind) {
    case "number":
      return formatFormulaNumber(value.value);
    case "text":
      return value.text;
    case "error":
      return value.code;
    default:
      return "";
  }
}

/**
 * A number as text, without a locale.
 *
 * No `Intl`, no `toLocaleString`, no thousands separators: this string can end up inside a document
 * (and inside a self-contained SVG export), so it has to read the same everywhere. Rounding to a
 * fixed number of decimals is also what keeps `0.1 + 0.2` from displaying its binary tail.
 */
function formatFormulaNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  const plain = String(value);
  // Past ~1e21 and below ~1e-7 JS already prints an exponent, and so does a spreadsheet.
  if (plain.includes("e")) {
    return plain;
  }
  // `String` is already the shortest text that round-trips to this double, so it never shows a
  // binary tail. Re-expanding it with `toFixed` past that length *invents* digits — 1000000000000.1
  // comes back as 1000000000000.099975586 — so only round when the shortest form is longer than we
  // mean to display.
  const point = plain.indexOf(".");
  if (point < 0 || plain.length - point - 1 <= MAX_DISPLAY_DECIMALS) {
    return plain;
  }
  const rounded = roundHalfAwayFromZero(value, MAX_DISPLAY_DECIMALS);
  if (!Number.isFinite(rounded)) {
    return plain;
  }
  const trimmed = rounded.toFixed(MAX_DISPLAY_DECIMALS).replace(/\.?0+$/u, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/**
 * Excel rounds halves away from zero, so `ROUND(-2.5, 0)` is -3 where `Math.round` gives -2.
 *
 * The shift goes through the decimal *string* rather than multiplying by a power of ten: `2.345`
 * times 100 is 234.49999999999997 in binary, which rounds to 2.34 and disagrees with every
 * spreadsheet. Reparsing `"2.345e2"` gives 234.5 and the expected 2.35.
 */
function roundHalfAwayFromZero(value: number, digits: number): number {
  if (!Number.isFinite(value) || Math.abs(digits) > MAX_ROUND_DIGITS) {
    return Number.NaN;
  }
  const scaled = shiftDecimalExponent(value, digits);
  if (!Number.isFinite(scaled)) {
    return Number.NaN;
  }
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return shiftDecimalExponent(rounded, -digits);
}

function shiftDecimalExponent(value: number, exponent: number): number {
  const [mantissa, currentExponent] = String(value).split("e");
  const shifted = currentExponent === undefined ? exponent : Number(currentExponent) + exponent;
  return Number(`${mantissa}e${shifted}`);
}

const compiledCache = new Map<string, FormulaNode | null>();

/** The parsed form of one source, or `null` when it is not a formula this language can read. */
function compileTableFormula(source: string): FormulaNode | null {
  const cached = compiledCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: FormulaNode | null;
  try {
    compiled = new TableFormulaParser(source.slice(1)).parse();
  } catch (error) {
    // Only a parse failure is cached: an in-progress formula is re-parsed on every keystroke, and
    // re-parsing a known-bad string is the same wasted work as re-parsing a good one. Anything else
    // says nothing about this text, and caching it would poison the source string for every other
    // table in the process — this cache is module-global and keyed on the text alone.
    if (!(error instanceof FormulaParseError)) {
      throw error;
    }
    compiled = null;
  }
  if (compiledCache.size >= MAX_COMPILED_CACHE_ENTRIES) {
    // Insertion-ordered eviction: sources churn while typing, so the oldest is the least likely
    // to be wanted again.
    const oldest = compiledCache.keys().next().value;
    if (oldest !== undefined) {
      compiledCache.delete(oldest);
    }
  }
  compiledCache.set(source, compiled);
  return compiled;
}

/**
 * `$A$1`, `A1`, `a1` — the dollars are decoration until references are rewritten on row insert.
 *
 * `(` is in the rejection set so a call whose name happens to have this shape (`ABS1(2)`, or a
 * future `LOG10`) is read as a function name rather than silently tokenized as a cell.
 */
const CELL_REFERENCE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![A-Za-z0-9_.$(])/u;
const NUMBER_LITERAL = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu;
/** Function names may hold a dot (`STDEV.P`); starting with a letter keeps them off `.5`. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/u;

/**
 * Recursive descent over the Excel subset, shaped like `features/drawing/math-expression.ts`:
 * parsing builds a tree of small closures, and there is no `eval`, no `Function`, no dynamic import
 * and no caller-provided callback anywhere in it.
 *
 * `^` is deliberately absent. Excel's exponentiation is left-associative *and* binds tighter than
 * unary minus (`-2^2` is 4), which is the opposite of the sibling parser in this repository
 * (`-x^2` is `-(x^2)`). Two contradictory power rules in one codebase is a bug waiting to be
 * written, and `POWER(2,3)` already covers the need. Comparison operators, `&`, whole-column `A:A`
 * and cross-table references are out for the same "not needed yet" reason.
 */
class TableFormulaParser {
  private index = 0;
  private steps = 0;
  private depth = 0;

  constructor(private readonly input: string) {}

  parse(): FormulaNode {
    const node = this.parseAdditive();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new FormulaParseError(`Unexpected token at ${this.index}`);
    }
    return node;
  }

  private parseAdditive(): FormulaNode {
    let node = this.parseMultiplicative();
    while (true) {
      this.step();
      this.skipWhitespace();
      if (this.consume("+")) {
        node = arithmeticNode(node, this.parseMultiplicative(), (left, right) => left + right);
      } else if (this.consume("-")) {
        node = arithmeticNode(node, this.parseMultiplicative(), (left, right) => left - right);
      } else {
        return node;
      }
    }
  }

  private parseMultiplicative(): FormulaNode {
    let node = this.parseUnary();
    while (true) {
      this.step();
      this.skipWhitespace();
      if (this.consume("*")) {
        node = arithmeticNode(node, this.parseUnary(), (left, right) => left * right);
      } else if (this.consume("/")) {
        node = divisionNode(node, this.parseUnary());
      } else {
        return node;
      }
    }
  }

  private parseUnary(): FormulaNode {
    this.step();
    this.skipWhitespace();
    if (this.consume("+")) {
      return this.withDepth(() => this.parseUnary());
    }
    if (this.consume("-")) {
      const operand = this.withDepth(() => this.parseUnary());
      return (context) => {
        const value = toNumber(operand(context));
        return value.kind === "error" ? value : numberValue(-value.value);
      };
    }
    return this.parsePostfix();
  }

  /** `%` binds tighter than a unary sign, so `-50%` is -0.5 rather than -(50)%. */
  private parsePostfix(): FormulaNode {
    let node = this.parsePrimary();
    while (true) {
      this.step();
      this.skipWhitespace();
      if (!this.consume("%")) {
        return node;
      }
      const operand = node;
      node = (context) => {
        const value = toNumber(operand(context));
        return value.kind === "error" ? value : numberValue(value.value / 100);
      };
    }
  }

  private parsePrimary(): FormulaNode {
    this.step();
    this.skipWhitespace();
    if (this.consume("(")) {
      const node = this.withDepth(() => this.parseAdditive());
      this.skipWhitespace();
      if (!this.consume(")")) {
        throw new FormulaParseError("Expected closing parenthesis");
      }
      return node;
    }

    const literal = this.parseNumber();
    if (literal !== null) {
      const value: SigmaTableCellValue = { kind: "number", value: literal };
      return () => value;
    }

    const start = this.parseReference();
    if (start) {
      this.skipWhitespace();
      if (!this.consume(":")) {
        return (context) => context.readCell(start);
      }
      this.skipWhitespace();
      const end = this.parseReference();
      if (!end) {
        throw new FormulaParseError(`Expected a cell reference at ${this.index}`);
      }
      return (context) => context.readRange(start, end);
    }

    const identifier = this.parseIdentifier();
    if (identifier) {
      return this.parseCall(identifier);
    }
    throw new FormulaParseError(`Expected a value at ${this.index}`);
  }

  private parseCall(identifier: string): FormulaNode {
    this.skipWhitespace();
    if (!this.consume("(")) {
      // A bare name is not a value here. Excel answers `#NAME?` rather than refusing the formula,
      // and an error value beats dropping back to the raw source for something this close to right.
      return () => ERROR_NAME;
    }
    const args: FormulaNode[] = [];
    this.skipWhitespace();
    if (!this.consume(")")) {
      do {
        args.push(this.withDepth(() => this.parseAdditive()));
        this.skipWhitespace();
      } while (this.consume(","));
      if (!this.consume(")")) {
        throw new FormulaParseError("Expected closing parenthesis");
      }
    }
    const operation = getFormulaFunction(identifier.toLowerCase());
    if (!operation) {
      return () => ERROR_NAME;
    }
    // Charged against the same budget as a reference hop: a call node costs several JS frames, and
    // nesting inside a chain of referencing cells is what multiplies the two into a stack overflow.
    return (context) => {
      context.enterFrame();
      try {
        return operation(args.map((argument) => argument(context)));
      } finally {
        context.leaveFrame();
      }
    };
  }

  private parseNumber(): number | null {
    const match = NUMBER_LITERAL.exec(this.input.slice(this.index));
    if (!match) {
      return null;
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseReference(): CellAddress | null {
    const match = CELL_REFERENCE.exec(this.input.slice(this.index));
    if (!match) {
      return null;
    }
    this.index += match[0].length;
    return { rowIndex: Number(match[2]) - 1, columnIndex: columnIndexFromLetters(match[1]) };
  }

  private parseIdentifier(): string | null {
    const match = IDENTIFIER.exec(this.input.slice(this.index));
    if (!match) {
      return null;
    }
    this.index += match[0].length;
    return match[0];
  }

  private consume(token: string): boolean {
    if (!this.input.startsWith(token, this.index)) {
      return false;
    }
    this.index += token.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private withDepth<T>(operation: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_RECURSION_DEPTH) {
      throw new FormulaParseError("Formula is too deeply nested");
    }
    try {
      return operation();
    } finally {
      this.depth -= 1;
    }
  }

  private step(): void {
    this.steps += 1;
    if (this.steps > MAX_PARSE_STEPS) {
      throw new FormulaParseError("Formula is too complex");
    }
  }
}

/** `A` is 0, `Z` is 25, `AA` is 26 — bijective base 26, as spreadsheets number their columns. */
function columnIndexFromLetters(letters: string): number {
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function numberValue(value: number): SigmaTableCellValue {
  return Number.isFinite(value) ? { kind: "number", value } : ERROR_NUM;
}

/** Arithmetic reads an empty cell as 0 and refuses text; the leftmost error wins. */
function toNumber(input: FormulaValue): FormulaNumberValue | FormulaErrorValue {
  const value = unwrapSingleCellRange(input);
  switch (value.kind) {
    case "number":
      return Number.isFinite(value.value) ? value : ERROR_NUM;
    case "empty":
      return ZERO;
    case "error":
      return value;
    default:
      return ERROR_VALUE;
  }
}

function arithmeticNode(
  left: FormulaNode,
  right: FormulaNode,
  combine: (left: number, right: number) => number,
): FormulaNode {
  return (context) => {
    const a = toNumber(left(context));
    if (a.kind === "error") {
      return a;
    }
    const b = toNumber(right(context));
    if (b.kind === "error") {
      return b;
    }
    return numberValue(combine(a.value, b.value));
  };
}

function divisionNode(left: FormulaNode, right: FormulaNode): FormulaNode {
  return (context) => {
    const a = toNumber(left(context));
    if (a.kind === "error") {
      return a;
    }
    const b = toNumber(right(context));
    if (b.kind === "error") {
      return b;
    }
    return b.value === 0 ? ERROR_DIV0 : numberValue(a.value / b.value);
  };
}

type FormulaFunction = (args: readonly FormulaValue[]) => FormulaValue;

/** Flattens ranges into the cells they hold, errors included; the caller decides what to do. */
function flattenArguments(args: readonly FormulaValue[]): SigmaTableCellValue[] {
  const values: SigmaTableCellValue[] = [];
  for (const arg of args) {
    if (arg.kind === "range") {
      // Appended one at a time: spreading a whole range into `push` throws once it outgrows the
      // call-argument limit, and a range may hold `MAX_RANGE_CELLS` of them.
      for (const cell of arg.cells) {
        values.push(cell);
      }
      continue;
    }
    values.push(arg);
  }
  return values;
}

function firstErrorOf(values: readonly SigmaTableCellValue[]): FormulaErrorValue | null {
  for (const value of values) {
    if (value.kind === "error") {
      return value;
    }
  }
  return null;
}

type PairedNumbers = { kind: "pairs"; first: number[]; second: number[] } | FormulaErrorValue;

/** Two equal-length populations, paired by position; a pair with a non-number is dropped. */
function collectPairs(args: readonly FormulaValue[]): PairedNumbers {
  if (args.length !== 2) {
    return ERROR_VALUE;
  }
  const left = flattenArguments([args[0]]);
  const leftError = firstErrorOf(left);
  if (leftError) {
    return leftError;
  }
  const right = flattenArguments([args[1]]);
  const rightError = firstErrorOf(right);
  if (rightError) {
    return rightError;
  }
  if (left.length !== right.length) {
    return ERROR_NA;
  }
  const first: number[] = [];
  const second: number[] = [];
  left.forEach((value, index) => {
    const other = right[index];
    if (value.kind === "number" && other.kind === "number") {
      first.push(value.value);
      second.push(other.value);
    }
  });
  return { kind: "pairs", first, second };
}

function meanOf(numbers: readonly number[]): number {
  return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

/** Σ(a-ā)(b-b̄) over paired populations of the same length. */
function coMoment(a: readonly number[], b: readonly number[]): number {
  const meanA = meanOf(a);
  const meanB = meanOf(b);
  return a.reduce((total, value, index) => total + (value - meanA) * (b[index] - meanB), 0);
}

function varianceOf(numbers: readonly number[], sample: boolean): FormulaValue {
  const count = numbers.length;
  if (count < (sample ? 2 : 1)) {
    return ERROR_DIV0;
  }
  return numberValue(coMoment(numbers, numbers) / (sample ? count - 1 : count));
}

function deviationOf(numbers: readonly number[], sample: boolean): FormulaValue {
  const variance = varianceOf(numbers, sample);
  return variance.kind === "number" ? numberValue(Math.sqrt(variance.value)) : variance;
}

/**
 * Aggregates that compute a value from every numeric cell of their arguments.
 *
 * An error anywhere in the population wins. These functions answer with a number, and a cell
 * quietly dropped from a class average is a wrong number presented as a right one — far worse than
 * a visible `#DIV/0!` the author can go and fix. `COUNT`/`COUNTA` are deliberately not routed here:
 * their job is to survive bad cells, and Excel has them do exactly that.
 */
function aggregate(
  args: readonly FormulaValue[],
  reduce: (numbers: number[]) => FormulaValue,
): FormulaValue {
  if (args.length === 0) {
    return ERROR_VALUE;
  }
  const values = flattenArguments(args);
  const error = firstErrorOf(values);
  if (error) {
    return error;
  }
  return reduce(values.flatMap((value) => (value.kind === "number" ? [value.value] : [])));
}

/** `SLOPE`/`INTERCEPT` take the y population first, as Excel does. */
function linearFit(args: readonly FormulaValue[], want: "slope" | "intercept"): FormulaValue {
  const paired = collectPairs(args);
  if (paired.kind === "error") {
    return paired;
  }
  const ys = paired.first;
  const xs = paired.second;
  if (xs.length < 2) {
    return ERROR_DIV0;
  }
  const spread = coMoment(xs, xs);
  if (spread === 0) {
    return ERROR_DIV0;
  }
  const slope = coMoment(xs, ys) / spread;
  return numberValue(want === "slope" ? slope : meanOf(ys) - slope * meanOf(xs));
}

function scalarFunction(
  args: readonly FormulaValue[],
  arity: number,
  apply: (values: number[]) => FormulaValue,
): FormulaValue {
  if (args.length !== arity) {
    return ERROR_VALUE;
  }
  const values: number[] = [];
  for (const arg of args) {
    const value = toNumber(arg);
    if (value.kind === "error") {
      return value;
    }
    values.push(value.value);
  }
  return apply(values);
}

const FORMULA_FUNCTIONS: Readonly<Record<string, FormulaFunction>> = {
  sum: (args) => aggregate(args, (numbers) => (
    numberValue(numbers.reduce((total, value) => total + value, 0))
  )),
  average: (args) => aggregate(args, (numbers) => (
    numbers.length === 0 ? ERROR_DIV0 : numberValue(meanOf(numbers))
  )),
  // `COUNT` and `COUNTA` survive error cells instead of adopting them, as Excel does. Counting is
  // the one job that must still answer when part of the table is broken: "how many marks are in?"
  // stays answerable even though one of the cells beside them cannot be computed.
  count: (args) => (args.length === 0 ? ERROR_VALUE : {
    kind: "number",
    value: flattenArguments(args).filter((value) => value.kind === "number").length,
  }),
  // An error cell is occupied, so it counts as present.
  counta: (args) => (args.length === 0 ? ERROR_VALUE : {
    kind: "number",
    value: flattenArguments(args).filter((value) => value.kind !== "empty").length,
  }),
  // Excel answers 0, not an error, when a range holds no numbers at all.
  // Reduced rather than spread: `Math.max(...numbers)` passes every value as an argument and throws
  // `RangeError` once a population outgrows the call-argument limit, which several ranges together
  // reach well inside `MAX_RANGE_CELLS`.
  max: (args) => aggregate(args, (numbers) => (
    numbers.length === 0 ? ZERO : numberValue(numbers.reduce((a, b) => (b > a ? b : a)))
  )),
  min: (args) => aggregate(args, (numbers) => (
    numbers.length === 0 ? ZERO : numberValue(numbers.reduce((a, b) => (b < a ? b : a)))
  )),
  median: (args) => aggregate(args, (numbers) => {
    if (numbers.length === 0) {
      return ERROR_NUM;
    }
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return numberValue(sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2);
  }),
  "stdev.p": (args) => aggregate(args, (numbers) => deviationOf(numbers, false)),
  "stdev.s": (args) => aggregate(args, (numbers) => deviationOf(numbers, true)),
  "var.p": (args) => aggregate(args, (numbers) => varianceOf(numbers, false)),
  "var.s": (args) => aggregate(args, (numbers) => varianceOf(numbers, true)),
  correl: (args) => {
    const paired = collectPairs(args);
    if (paired.kind === "error") {
      return paired;
    }
    if (paired.first.length < 2) {
      return ERROR_DIV0;
    }
    const spread = coMoment(paired.first, paired.first) * coMoment(paired.second, paired.second);
    if (spread === 0) {
      return ERROR_DIV0;
    }
    return numberValue(coMoment(paired.first, paired.second) / Math.sqrt(spread));
  },
  slope: (args) => linearFit(args, "slope"),
  intercept: (args) => linearFit(args, "intercept"),
  round: (args) => scalarFunction(args, 2, ([value, digits]) => (
    numberValue(roundHalfAwayFromZero(value, Math.trunc(digits)))
  )),
  abs: (args) => scalarFunction(args, 1, ([value]) => numberValue(Math.abs(value))),
  sqrt: (args) => scalarFunction(args, 1, ([value]) => (
    value < 0 ? ERROR_NUM : numberValue(Math.sqrt(value))
  )),
  power: (args) => scalarFunction(args, 2, ([base, exponent]) => (
    base === 0 && exponent < 0 ? ERROR_DIV0 : numberValue(base ** exponent)
  )),
};

function getFormulaFunction(name: string): FormulaFunction | null {
  // Keep inherited names such as `constructor` or `toString` from resolving. The canonical
  // document source is also compiled by the Viewer package, whose library target predates
  // `Object.hasOwn`, so use the equivalent cross-target form here.
  if (!Object.prototype.hasOwnProperty.call(FORMULA_FUNCTIONS, name)) {
    return null;
  }
  return FORMULA_FUNCTIONS[name];
}
