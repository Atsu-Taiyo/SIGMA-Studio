import type { InlineNode, OverlayTableShape, SigmaTableCell, SigmaTableCellStyle, TextMark } from "@/features/document";
import { createOverlayClipboardPayload } from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";

const MAX_CELLS = 10_000;
const MAX_HTML_LENGTH = 4_000_000;
const clipboardTables = new WeakMap<DataTransfer, { html: string; payload: ReturnType<typeof spreadsheetClipboardPayload> }>();

export function readSpreadsheetClipboard(data: DataTransfer) {
  const html = data.getData?.("text/html") ?? "";
  if (clipboardTables.get(data)?.html !== html) clipboardTables.set(data, { html, payload: spreadsheetClipboardPayload(html) });
  return clipboardTables.get(data)?.payload ?? null;
}

/** External HTML is parsed in an inert document; only table data and selected CSS values survive. */
export function spreadsheetClipboardPayload(html: string) {
  if (!/<table[\s>]/i.test(html) || html.length > MAX_HTML_LENGTH) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table || doc.querySelectorAll("table").length !== 1 || table.querySelectorAll("*").length > 50_000) return null;
  const rows = Array.from(table.rows);
  if (!rows.length || rows.length > MAX_CELLS) return null;
  const rules: { selector: string; declarations: string }[] = [];
  // Excel emits .xlNN rules, while Sheets generally emits inline styles. Never mount the stylesheet.
  for (const style of doc.querySelectorAll("style")) {
    for (const match of (style.textContent ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of match[1].split(",")) {
        if (/^[\w.*#\s>-]+$/.test(selector.trim())) rules.push({ selector: selector.trim(), declarations: match[2] });
        if (rules.length > 1000) return null;
      }
    }
  }
  const styleFor = (element: Element): CSSStyleDeclaration => {
    const result = doc.createElement("span").style;
    for (const rule of rules) {
      try { if (element.matches(rule.selector)) result.cssText += `;${rule.declarations}`; } catch { /* Invalid external selector. */ }
    }
    result.cssText += `;${element.getAttribute("style") ?? ""}`;
    return result;
  };
  const occupied = new Set<string>();
  const rowIds = rows.map(() => createId("row"));
  const columnIds: string[] = [];
  const widths: number[] = [];
  const heights = rows.map(row => cssPixels(styleFor(row).height || row.getAttribute("height")) ?? 28);
  for (const col of table.querySelectorAll("col")) {
    const width = cssPixels(styleFor(col).width || col.getAttribute("width"));
    for (let i = 0; i < Math.min(col.span || 1, MAX_CELLS); i++) widths.push(width ?? 96);
    if (widths.length > MAX_CELLS) return null;
  }
  const cells: SigmaTableCell[] = [];
  for (let r = 0; r < rows.length; r++) {
    let c = 0;
    for (const cell of Array.from(rows[r].cells)) {
      while (occupied.has(`${r}:${c}`)) c++;
      const rowSpan = Math.min(cell.rowSpan === 0 ? rows.length - r : cell.rowSpan || 1, rows.length - r);
      const colSpan = cell.colSpan || 1;
      if ((c + colSpan) * rows.length > MAX_CELLS) return null;
      for (let y = r; y < r + rowSpan; y++) {
        for (let x = c; x < c + colSpan; x++) {
          if (occupied.has(`${y}:${x}`)) return null;
          occupied.add(`${y}:${x}`);
        }
      }
      while (columnIds.length < c + colSpan) columnIds.push(createId("col"));
      const style = styleFor(cell);
      const width = cssPixels(style.width || cell.getAttribute("width"));
      if (width && colSpan === 1) widths[c] = Math.max(widths[c] ?? 0, width);
      const height = cssPixels(style.height || cell.getAttribute("height"));
      if (height && rowSpan === 1) heights[r] = Math.max(heights[r], height);
      const cellStyle: Partial<SigmaTableCellStyle> = {};
      const align = style.textAlign || cell.getAttribute("align");
      if (align === "left" || align === "center" || align === "right" || align === "justify") cellStyle.align = align;
      const verticalAlign = style.verticalAlign || cell.getAttribute("valign");
      if (verticalAlign === "top" || verticalAlign === "middle" || verticalAlign === "bottom") cellStyle.verticalAlign = verticalAlign;
      const background = safeColor(style.backgroundColor || cell.getAttribute("bgcolor"));
      if (background) cellStyle.backgroundColor = background;
      const children: InlineNode[] = [];
      const visit = (node: Node, inherited: Omit<Extract<InlineNode, { type: "text" }>, "type" | "text">, depth = 0) => {
        if (depth > 64) return;
        if (node.nodeType === 3) {
          const text = node.textContent?.replace(/\r\n?/g, "\n") ?? "";
          if (text) children.push({ type: "text", text, ...inherited });
          return;
        }
        if (!(node instanceof Element) || /^(SCRIPT|STYLE|IFRAME|OBJECT|IMG)$/.test(node.tagName)) return;
        if (node.tagName === "BR") { children.push({ type: "text", text: "\n" }); return; }
        const css = styleFor(node);
        const next = { ...inherited };
        const marks = new Set<TextMark>(inherited.marks);
        if (/^(B|STRONG|TH)$/.test(node.tagName) || css.fontWeight === "bold" || Number(css.fontWeight) >= 600) marks.add("bold");
        if (/^(I|EM)$/.test(node.tagName) || css.fontStyle === "italic") marks.add("italic");
        if (node.tagName === "U" || (css.textDecorationLine || css.textDecoration).includes("underline")) marks.add("underline");
        if (marks.size) next.marks = Array.from(marks);
        const color = safeColor(css.color || node.getAttribute("color"));
        if (color) next.color = color;
        const fontSize = cssPixels(css.fontSize);
        if (fontSize) next.fontSize = fontSize * 72 / 96;
        if (css.fontFamily) next.fontFamily = css.fontFamily;
        if (/^(P|DIV)$/.test(node.tagName) && children.length && children.at(-1)?.type === "text" && !(children.at(-1) as { text: string }).text.endsWith("\n")) children.push({ type: "text", text: "\n" });
        node.childNodes.forEach(child => visit(child, next, depth + 1));
      };
      visit(cell, {});
      const text = children.map(child => child.type === "text" ? child.text : "").join("");
      if (!cellStyle.align && /^[\s¥$€£+−-]*\d[\d,.\s]*%?$/.test(text)) cellStyle.align = "right";
      const lineCount = text.split("\n").length;
      if (rowSpan === 1 && lineCount > 1) {
        const fontSize = Math.max(11, ...children.map(child => child.fontSize ?? 11));
        heights[r] = Math.max(heights[r], lineCount * fontSize * 2 + 4);
      }
      cells.push({ id: createId("cell"), rowId: rowIds[r], columnId: columnIds[c], rowSpan, colSpan,
        content: [{ type: "paragraph", id: createId("p"), children }], style: cellStyle });
      c += colSpan;
    }
  }
  if (!cells.length) return null;
  const columnWidths = columnIds.map((_, i) => widths[i] ?? 96);
  const shape: OverlayTableShape = {
    id: createId("table"), type: "tableShape", x: 0, y: 0,
    props: { w: columnWidths.reduce((a, b) => a + b, 0), h: heights.reduce((a, b) => a + b, 0),
      table: { version: 1, kind: "plain", columns: columnIds.map((id, i) => ({ id, width: { mode: "fixed", value: columnWidths[i] } })),
        rows: rowIds.map((id, i) => ({ id, height: { mode: "fixed", value: heights[i] } })), cells,
        grid: { borderColor: "#b7b7b7", borderWidth: 1, showInnerBorders: true, showOuterBorder: true },
        defaultCellStyle: { paddingX: 4, paddingY: 2, fontSize: 11, align: "left", verticalAlign: "middle", backgroundColor: "#ffffff" } } },
  };
  return createOverlayClipboardPayload([shape], {});
}

function cssPixels(value: string | null): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(px|pt)?$/i);
  if (!match) return undefined;
  const number = Number(match[1]) * (match[2]?.toLowerCase() === "pt" ? 96 / 72 : 1);
  return number > 0 && number <= 4096 ? number : undefined;
}

function safeColor(value: string | null): string | undefined {
  return value && /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(value) ? value : undefined;
}
