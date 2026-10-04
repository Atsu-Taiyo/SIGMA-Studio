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
  type AiEditPreviewState,
} from "../model/preview";
import { buildPendingProposalContent, type AiProposalContent } from "../model/proposal-content";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { AiEditInlinePreviewCard } from "./AiEditInlinePreviewCard";

/**
 * The AI preview card used to carry its own table renderer — a plain `rows × columns` double loop
 * with no span expansion, so a cell with `colSpan`/`rowSpan` pushed every following column of its
 * row past the table's edge.
 *
 * That renderer could never run. A proposed shape is decided on the canvas, where it is drawn as a
 * ghost by the ordinary shape renderer, so the body card never draws overlay inserts — the proposal
 * content model routes them to `shapes` and the card shows only body hunks. So the fix is not to make
 * the card's grid correct but to stop it owning a grid at all: one renderer fewer to keep in step,
 * and the table the user actually sees comes from `OverlayTableStaticView` and the shared grid model.
 *
 * These tests pin both halves — the card renders no table (the premise that makes the deletion
 * behaviour-preserving), and the proposed shape that reaches the canvas keeps its merged cells.
 */

const srcDirectory = path.resolve(import.meta.dirname, "../../..");
const globalsCss = readFileSync(path.join(srcDirectory, "app/globals.css"), "utf8");
const cardSource = readFileSync(path.join(import.meta.dirname, "AiEditInlinePreviewCard.tsx"), "utf8");
const contentViewSource = readFileSync(path.join(import.meta.dirname, "AiProposalContentView.tsx"), "utf8");

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

function contentOf(...operations: AiEditDraft[]): AiProposalContent {
  const document = parseSigmaDocument({
    version: "2.0",
    docId: "doc_table",
    metadata: { title: "表" },
    content: [{ id: "p1", type: "paragraph", children: [{ type: "text", text: "本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
  return buildPendingProposalContent(document, null, previewState(operations));
}

function renderCard(content: AiProposalContent): string {
  return renderToStaticMarkup(<AiEditInlinePreviewCard content={content} applying={false} />);
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
    const content = contentOf(tableDraft(mergedTable()));

    expect(content.hunks).toEqual([]);
    expect(content.shapes.map((entry) => entry.shape.id)).toEqual(["generated_table"]);
    expect(renderCard(content)).toBe("");
  });

  it("keeps a table insert out of a proposal that also edits the body", () => {
    const html = renderCard(contentOf(
      tableDraft(mergedTable()),
      {
        operation: "insertAfter",
        summary: "本文を追加",
        targetId: "p1",
        insertedBlock: { id: "ins_1", type: "paragraph", children: [{ type: "text", text: "追加した本文" }] },
      },
    ));

    expect(html).toContain("追加した本文");
    expect(readRows(html)).toEqual([]);
    expect(html).not.toContain("<td");
  });

  it.each([
    ["the card", () => cardSource],
    ["the shared content view", () => contentViewSource],
  ])("leaves no table renderer, cell-style duplicate, or trend glyph in %s", (_label, source) => {
    expect(source()).not.toMatch(/<t(?:able|body|r|d)[\s>]/);
    expect(source()).not.toContain("colSpan");
    expect(source()).not.toContain("rowSpan");
    expect(source()).not.toContain("defaultCellStyle");
    // The KaTeX trend arrow this file used to build was the fourth glyph implementation.
    expect(source()).not.toContain("nearrow");
    expect(source()).not.toContain("MathPreview");
  });

  // A plain substring scan rather than a selector parser: it also catches a rule re-added inside an
  // at-rule (`@media print { … }`), which a prelude-matching parser skips over.
  it("drops the table-preview stylesheet rules the card no longer produces markup for", () => {
    expect(globalsCss).not.toContain("ai-inline-table");
    expect(relativeSourceFilesContaining("ai-inline-table")).toEqual([]);
  });

  it("no longer keeps an unreachable placeholder branch for overlay inserts in the card", () => {
    // The card used to name the shape ("表を挿入します") in a branch the overlay filter made
    // unreachable. The content model now never hands overlay inserts to the card at all.
    expect(cardSource).not.toContain("ai-inline-preview-placeholder");
    expect(relativeSourceFilesContaining("ai-inline-preview-placeholder")).toEqual([]);
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
