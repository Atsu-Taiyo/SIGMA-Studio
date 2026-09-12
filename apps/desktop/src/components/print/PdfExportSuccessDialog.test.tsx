import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PdfExportSuccessDialog } from "./PdfExportSuccessDialog";

describe("PdfExportSuccessDialog", () => {
  it("shows that the PDF was saved and where it was written", () => {
    const html = renderToStaticMarkup(
      <PdfExportSuccessDialog filePath="/Users/test/Downloads/教材.pdf" onClose={vi.fn()} />,
    );

    expect(html).toContain("PDFを保存しました");
    expect(html).toContain("PDFをこのPCに保存しました。");
    expect(html).toContain("/Users/test/Downloads/教材.pdf");
    expect(html.match(/aria-label="閉じる"/g)).toHaveLength(1);
    expect(html).not.toContain("<footer>");
  });
});
