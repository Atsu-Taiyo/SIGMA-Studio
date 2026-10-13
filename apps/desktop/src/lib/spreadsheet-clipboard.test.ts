// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isValidOverlaySnapshot } from "@/features/document";
import { spreadsheetClipboardPayload } from "./spreadsheet-clipboard";
import { getSupportedOverlayImageFilesFromDataTransfer } from "./overlay-image-files";

describe("external spreadsheet clipboard", () => {
  it("imports Sheets displayed values, blanks, multiline content and merged cells into valid persistent tables", () => {
    const payload = spreadsheetClipboardPayload('<google-sheets-html-origin><table><colgroup><col width="120"><col width="80"></colgroup><tbody><tr style="height:32px"><td colspan="2" style="background-color:#ffff00;text-align:center;font-weight:700">売上</td></tr><tr><td>0012<br>注記</td><td></td></tr><tr><td rowspan="2">合計</td><td>¥1,234</td></tr><tr><td>25%</td></tr></tbody></table></google-sheets-html-origin>')!;
    expect(isValidOverlaySnapshot({ version: 1, shapes: payload.shapes, assets: payload.assets })).toBe(true);
    const shape = payload.shapes[0];
    if (shape.type !== "tableShape") throw new Error("expected table");
    expect(shape.props.w).toBe(200);
    expect(shape.props.table.cells).toHaveLength(6);
    expect(shape.props.table.cells[0]).toMatchObject({ colSpan: 2, style: { backgroundColor: "#ffff00", align: "center" }, content: [{ children: [{ text: "売上", marks: ["bold"] }] }] });
    expect(shape.props.table.cells[1].content).toMatchObject([{ children: [{ text: "0012" }, { text: "\n" }, { text: "注記" }] }]);
    expect(shape.props.table.cells[2].content).toMatchObject([{ children: [] }]);
    expect(shape.props.table.cells[5].columnId).toBe(shape.props.table.columns[1].id);
  });

  it("reads Excel class CSS and point units without mounting external styles or executable HTML", () => {
    const payload = spreadsheetClipboardPayload('<html><head><style>.xl65 {font-weight:700;font-size:12pt;color:#ff0000;background:#eeeeee} body {background:red}</style></head><body><table><tr height="24"><td width="90" class="xl65" onclick="evil()"><i>Excel</i><script>evil()</script></td></tr></table></body></html>')!;
    const shape = payload.shapes[0];
    if (shape.type !== "tableShape") throw new Error("expected table");
    expect(shape.props.table.cells[0]).toMatchObject({ style: { backgroundColor: "#eeeeee" }, content: [{ children: [{ text: "Excel", marks: ["bold", "italic"], color: "#ff0000", fontSize: 12 }] }] });
    expect(document.body.style.background).toBe("");
    expect(JSON.stringify(payload)).not.toContain("evil");
  });

  it("does not expand pathological ranges or mistake ordinary text for a table", () => {
    expect(spreadsheetClipboardPayload("a\tb\nc\td")).toBeNull();
    expect(spreadsheetClipboardPayload('<table><tr><td colspan="1000">x</td></tr>'.repeat(20))).toBeNull();
    expect(spreadsheetClipboardPayload('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>')).toBeNull();
  });

  it("prefers editable cells over the Office bitmap, but keeps chart-only image files", () => {
    const data = new DataTransfer();
    const file = new File(["png"], "chart.png", { type: "image/png" });
    data.items.add(file);
    data.setData("text/html", "<table><tr><td>12</td></tr></table>");
    expect(getSupportedOverlayImageFilesFromDataTransfer(data)).toEqual([]);
    data.setData("text/html", '<img src="file:///clipboard/chart.png">');
    expect(getSupportedOverlayImageFilesFromDataTransfer(data)).toEqual([file]);
  });

  it("imports embedded chart PNGs but never fetches remote or local image URLs", async () => {
    const data = new DataTransfer();
    data.setData("text/html", '<img src="https://example.com/chart.png"><img src="file:///secret.png"><img src="data:image/png;base64,cG5n">');
    const files = getSupportedOverlayImageFilesFromDataTransfer(data);
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/png");
    expect(await files[0].text()).toBe("png");
  });
});
