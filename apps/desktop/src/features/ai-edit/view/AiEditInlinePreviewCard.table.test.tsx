import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OverlayTableShape, SigmaTableCell, SigmaTableSpec } from "@/features/document";
import { OverlayTableStaticView } from "@/features/rendering/adapters/react";
import type { AiEditDraft } from "@/lib/ai/sigma-doc-edit-schema";

import {
  deriveAiEditPreviewDiff,
  overlayShapeNoun,
  type AiEditPreviewState,
} from "../model/preview";
import {
  AiEditInlinePreviewCard,
  type AiEditInlinePreviewEntry,
} from "./AiEditInlinePreviewCard";

/**
 * The AI preview card used to carry its own table renderer — a plain `rows × columns` double loop
 * with no span expansion, so a cell with `colSpan`/`rowSpan` pushed every following column of its
 * row past the table's edge.
 *
 * That renderer could never run. `AiEditInlinePreviewCard` filters every overlay insert out of the
 * body card (`isOverlayOwnedAiEditDraft`) because a proposed shape is decided on the canvas, where
 * it is drawn as a ghost by the ordinary shape renderer. So the fix is not to make the card's grid
 * correct but to stop it owning a grid at all: one renderer fewer to keep in step, and the table the
 * user actually sees comes from `OverlayTableStaticView` and the shared grid model.
 *
 * These tests pin both halves — the card renders no table (the premise that makes the deletion
 * behaviour-preserving), and the proposed shape that reaches the canvas keeps its merged cells.
 */

const srcDirectory = path.resolve(import.meta.dirname, "../../..");
const globalsCss = readFileSync(path.join(srcDirectory, "app/globals.css"), "utf8");
const cardSource = readFileSync(path.join(import.meta.dirname, "AiEditInlinePreviewCard.tsx"), "utf8");

/** The fixture size of an AI-proposed table shape (`insertTableShape` draft). */
const SHAPE_WIDTH = 460;
const SHAPE_HEIGHT = 132;

interface RenderedCell {
  colSpan: null | string;
  rowSpan: null | string;
  text: string;
}

function column(id: string, value: number) {
  return { id, width: { mode: "fixed" as const, value } };
}

function row(id: string, value: number) {
  return { id, height: { mode: "fixed" as const, value } };
}

function paragraphCell(
  id: string,
  rowId: string,
  columnId: string,
  text: string,
  extra: Partial<SigmaTableCell> = {},
): SigmaTableCell {
  return {
    id,
    rowId,
    columnId,
    content: [{ id: `${id}_p`, type: "paragraph", children: [{ type: "text", text }] }],
    ...extra,
  };
}

/** Three columns, two rows, and `r1:c1` merged across two columns. */
function mergedTable(overrides: Partial<SigmaTableSpec> = {}): SigmaTableSpec {
  return {
    version: 1,
    kind: "plain",
    columns: [column("c1", 150), column("c2", 150), column("c3", 160)],
    rows: [row("r1", 66), row("r2", 66)],
    cells: [
      paragraphCell("cell_a", "r1", "c1", "A", { colSpan: 2 }),
      paragraphCell("cell_c", "r1", "c3", "C"),
      paragraphCell("cell_d", "r2", "c1", "D"),
      paragraphCell("cell_e", "r2", "c2", "E"),
      paragraphCell("cell_f", "r2", "c3", "F"),
    ],
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: { align: "center", verticalAlign: "middle" },
    ...overrides,
  };
}

function tableShape(spec: SigmaTableSpec): OverlayTableShape {
  return {
    id: "generated_table",
    type: "tableShape",
    x: 0,
    y: 56,
    props: { w: SHAPE_WIDTH, h: SHAPE_HEIGHT, table: spec },
  };
}

function tableDraft(spec: SigmaTableSpec): AiEditDraft {
  return {
    operation: "insertTableShape",
    summary: "表を挿入",
    targetId: "p1",
    tableShape: tableShape(spec),
  };
}

function entryOf(draft: AiEditDraft, operationIndex = 0, operationCount = 1): AiEditInlinePreviewEntry {
  return { kind: "operation", draft, operationIndex, operationCount, sessionSummary: "表を挿入します" };
}

function renderCard(entries: AiEditInlinePreviewEntry[]): string {
  return renderToStaticMarkup(
    <AiEditInlinePreviewCard entries={entries} providers={["chatgpt"]} applying={false} />,
  );
}

/** Rows of `<td>` descriptors, so a span leaking into the next column shows up as a count. */
function readRows(html: string): RenderedCell[][] {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const rows = Array.from(container.querySelectorAll("tr")).map((rowElement) => (
    Array.from(rowElement.querySelectorAll("td")).map((cell) => ({
      colSpan: cell.getAttribute("colspan"),
      rowSpan: cell.getAttribute("rowspan"),
      text: (cell.textContent ?? "").trim(),
    }))
  ));
  window.close();
  return rows;
}

function previewState(operations: AiEditDraft[]): AiEditPreviewState {
  return {
    targetId: operations[0]?.targetId ?? "",
    draft: { summary: "挿入します", plan: [], operations, warnings: [] },
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
  };
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : listSourceFiles(entryPath);
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
      ? [entryPath]
      : [];
  });
}

function relativeSourceFilesContaining(needle: string): string[] {
  return listSourceFiles(srcDirectory)
    .filter((file) => readFileSync(file, "utf8").includes(needle))
    .map((file) => path.relative(srcDirectory, file).replace(/\\/g, "/"))
    .sort();
}

describe("the body-flow proposal card never draws a proposed table", () => {
  // Characterization: this already held before the card's table renderer was deleted, and it is
  // exactly why deleting it changes nothing a user can see. If a change makes the card render an
  // overlay insert again, this fails first — and whatever renders it then has to expand spans.
  it("renders no card at all for a table insert, merged cells included", () => {
    expect(renderCard([entryOf(tableDraft(mergedTable()))])).toBe("");
  });

  it("keeps a table insert out of a proposal that also edits the body", () => {
    const html = renderCard([
      entryOf(tableDraft(mergedTable()), 0, 2),
      entryOf({
        operation: "insertAfter",
        summary: "本文を追加",
        targetId: "p1",
        insertedBlock: { id: "ins_1", type: "paragraph", children: [{ type: "text", text: "追加した本文" }] },
      }, 1, 2),
    ]);

    expect(html).toContain("追加した本文");
    expect(readRows(html)).toEqual([]);
    expect(html).not.toContain("<td");
  });

  it("no longer carries a table renderer, cell-style duplicate, or trend glyph", () => {
    expect(cardSource).not.toMatch(/<t(?:able|body|r|d)[\s>]/);
    expect(cardSource).not.toContain("colSpan");
    expect(cardSource).not.toContain("rowSpan");
    expect(cardSource).not.toContain("defaultCellStyle");
    // The KaTeX trend arrow this file used to build was the fourth glyph implementation.
    expect(cardSource).not.toContain("nearrow");
    expect(cardSource).not.toContain("MathPreview");
  });

  // A plain substring scan rather than a selector parser: it also catches a rule re-added inside an
  // at-rule (`@media print { … }`), which a prelude-matching parser skips over.
  it("drops the table-preview stylesheet rules the card no longer produces markup for", () => {
    expect(globalsCss).not.toContain("ai-inline-table");
    expect(relativeSourceFilesContaining("ai-inline-table")).toEqual([]);
  });

  it("names the shape with the change summary's noun for the branch the filter makes unreachable", () => {
    expect(cardSource).toContain("ai-inline-preview-placeholder");
    // The placeholder used to print the internal shape type ("tableShape を挿入します"). The noun
    // helper is the same one `deriveAiEditChangeSummaryLines` uses, so the two surfaces agree.
    expect(cardSource).toContain("overlayShapeNoun(draft.operation === \"insertTableShape\"");
    expect(overlayShapeNoun(tableShape(mergedTable()))).toBe("表");
  });
});

describe("the proposed table the user does see comes from the shared grid model", () => {
  /**
   * The canvas path: `deriveAiEditPreviewDiff` turns the draft into a pending ghost shape, and
   * `AiPageCanvasEditor` hands that shape to the ordinary shape renderer — `OverlayTableStaticView`
   * on every non-interactive surface. This is the acceptance case the card's broken grid used to
   * contradict: a merged cell stays merged.
   */
  it("keeps a colSpan cell merged instead of pushing the row past the table edge", () => {
    const spec = mergedTable();
    const { addedShapes } = deriveAiEditPreviewDiff([previewState([tableDraft(spec)])]);

    expect(addedShapes.map((added) => added.shape.id)).toEqual(["generated_table"]);
    const shape = addedShapes[0].shape as OverlayTableShape;
    const rows = readRows(renderToStaticMarkup(
      <OverlayTableStaticView table={shape.props.table} width={shape.props.w} height={shape.props.h} />,
    ));

    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0].colSpan).toBe("2");
    expect(rows[0][1].colSpan).toBeNull();
    expect(rows[0].map((cell) => cell.text)).toEqual(["A", "C"]);
    expect(rows[1]).toHaveLength(3);
    expect(spec.columns).toHaveLength(3);
  });

  it("drops the cells a rowSpan covers from the following row", () => {
    const rows = readRows(renderToStaticMarkup(
      <OverlayTableStaticView
        table={mergedTable({
          cells: [
            paragraphCell("cell_a", "r1", "c1", "A", { rowSpan: 2 }),
            paragraphCell("cell_b", "r1", "c2", "B"),
            paragraphCell("cell_c", "r1", "c3", "C"),
            paragraphCell("cell_e", "r2", "c2", "E"),
            paragraphCell("cell_f", "r2", "c3", "F"),
          ],
        })}
        width={SHAPE_WIDTH}
        height={SHAPE_HEIGHT}
      />,
    ));

    expect(rows[0][0].rowSpan).toBe("2");
    expect(rows[0]).toHaveLength(3);
    expect(rows[1].map((cell) => cell.text)).toEqual(["E", "F"]);
  });
});

/**
 * Span expansion belongs to the shared read model, including use from editor surfaces.
 *
 * Limitation worth stating: this matches the literal `coveredCells` name. A copy that spelled the
 * same pass differently would pass — the check is a tripwire against the obvious regression, not a
 * proof of uniqueness.
 */
describe("span expansion lives in the shared model", () => {
  it("uses only the shared model", () => {
    expect(relativeSourceFilesContaining("coveredCells")).toEqual([
      "features/rendering/core/overlay-table-read-model.ts",
    ]);
  });

  it.each(["<td", "<table", "coveredCells", "defaultCellStyle", "getTableCellStyleModel"])(
    "keeps %s out of the whole AI feature, not just the one file that had it",
    (needle) => {
      expect(relativeSourceFilesContaining(needle).filter((file) => file.startsWith("features/ai-edit/")))
        .toEqual([]);
    },
  );
});
