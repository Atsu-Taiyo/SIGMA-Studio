import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  executeJavaScript: vi.fn(),
  visiblePrintToPDF: vi.fn(),
  printToPDF: vi.fn(),
  hiddenExecuteJavaScript: vi.fn(),
  hiddenLoadURL: vi.fn(),
  hiddenClose: vi.fn(),
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  getPath: vi.fn(() => "/Users/test/Downloads"),
}));

const sender = {
  executeJavaScript: mocks.executeJavaScript,
  printToPDF: mocks.visiblePrintToPDF,
  isDestroyed: () => false,
  getURL: () => "file:///tmp/out/index.html",
  session: undefined,
};

vi.mock("electron", () => ({
  app: { getPath: mocks.getPath },
  shell: { showItemInFolder: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: mocks.showSaveDialog,
  },
  BrowserWindow: class BrowserWindow {
    static fromWebContents = vi.fn(() => null);
    webContents = {
      executeJavaScript: mocks.hiddenExecuteJavaScript,
      printToPDF: mocks.printToPDF,
      isDestroyed: () => false,
    };
    loadURL = mocks.hiddenLoadURL;
    close = mocks.hiddenClose;
    isDestroyed = () => false;
  },
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: mocks.writeFile,
    mkdir: mocks.mkdir,
    open: mocks.open,
  },
}));

import { registerFileIpc } from "./file";

const B5 = {
  surfaceId: "pdf_surface_test",
  revision: 4,
  pageCount: 2,
  pageWidthMm: 182,
  pageHeightMm: 257,
};

describe("file:export-pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.hiddenLoadURL.mockResolvedValue(undefined);
    mocks.hiddenExecuteJavaScript.mockResolvedValue(true);
    mocks.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes("pdfCaptureMode")) {
        const pageIndex = script.includes("const pageIndex = 0") ? 0 : 1;
        return { ...B5, pageIndex, documentHtml: "<html><body>page</body></html>" };
      }
      return B5;
    });
  });

  it("prints each settled preview page once from a hidden window and writes their validated merged PDF", async () => {
    const pagePdf = await createPdf(1, B5.pageWidthMm, B5.pageHeightMm);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/Users/test/Downloads/教材" });
    mocks.printToPDF.mockResolvedValue(pagePdf);

    registerFileIpc({ getMainWindow: () => null });

    const handler = mocks.handlers.get("file:export-pdf");
    expect(handler).toBeDefined();

    await expect(handler?.({ sender }, {
      ...B5,
      suggestedName: "教材.pdf",
    })).resolves.toEqual({ filePath: "/Users/test/Downloads/教材.pdf", pageCount: 2 });

    expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "PDFを書き出し",
      defaultPath: "教材.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    }));
    expect(mocks.visiblePrintToPDF).not.toHaveBeenCalled();
    expect(mocks.printToPDF).toHaveBeenCalledTimes(2);
    expect(mocks.printToPDF).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pageSize: { width: 182 / 25.4, height: 257 / 25.4 },
      preferCSSPageSize: true,
      printBackground: true,
    }));
    expect(mocks.hiddenLoadURL).toHaveBeenCalledWith("file:///tmp/out/print.html");
    expect(mocks.hiddenClose).toHaveBeenCalled();

    const captureScripts = mocks.executeJavaScript.mock.calls.map((call) => String(call[0]));
    expect(captureScripts.some((script) => script.includes("pdfCaptureMode"))).toBe(true);
    expect(captureScripts.every((script) => (
      !script.includes("document.documentElement.setAttribute(\"data-sigma-pdf-export-page\"")
      && !script.includes("document.body.appendChild")
    ))).toBe(true);

    const written = mocks.writeFile.mock.calls[0]?.[1] as Buffer;
    const parsed = await PDFDocument.load(written);
    expect(parsed.getPageCount()).toBe(2);
    expect(mocks.writeFile).toHaveBeenCalledWith("/Users/test/Downloads/教材.pdf", expect.any(Buffer));
  });

  it("does not render or write when the save dialog is cancelled", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });

    registerFileIpc({ getMainWindow: () => null });

    const handler = mocks.handlers.get("file:export-pdf");
    await expect(handler?.({ sender }, B5)).resolves.toBeNull();
    expect(mocks.executeJavaScript).not.toHaveBeenCalled();
    expect(mocks.visiblePrintToPDF).not.toHaveBeenCalled();
    expect(mocks.printToPDF).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("fails closed when the preview revision changes during export", async () => {
    const pagePdf = await createPdf(1, B5.pageWidthMm, B5.pageHeightMm);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/Users/test/Downloads/教材.pdf" });
    mocks.printToPDF.mockResolvedValue(pagePdf);
    mocks.executeJavaScript.mockImplementation(async () => ({
      ...B5,
      revision: B5.revision + 1,
      pageIndex: 0,
      documentHtml: "<html></html>",
    }));

    registerFileIpc({ getMainWindow: () => null });

    const handler = mocks.handlers.get("file:export-pdf");
    await expect(handler?.({ sender }, B5)).rejects.toThrow("PDFプレビューが更新されたため");
    expect(mocks.visiblePrintToPDF).not.toHaveBeenCalled();
    expect(mocks.printToPDF).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.hiddenClose).toHaveBeenCalled();
  });

  it("fails closed when Chromium returns more than one page for an isolated page", async () => {
    const invalidPdf = await createPdf(2, B5.pageWidthMm, B5.pageHeightMm);
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/Users/test/Downloads/教材.pdf" });
    mocks.printToPDF.mockResolvedValue(invalidPdf);

    registerFileIpc({ getMainWindow: () => null });

    const handler = mocks.handlers.get("file:export-pdf");
    await expect(handler?.({ sender }, B5)).rejects.toThrow("PDFのページ数がプレビューと一致しません");
    expect(mocks.visiblePrintToPDF).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.hiddenClose).toHaveBeenCalled();
  });
});

async function createPdf(pageCount: number, widthMm: number, heightMm: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const size: [number, number] = [widthMm / 25.4 * 72, heightMm / 25.4 * 72];
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage(size);
  }
  return Buffer.from(await pdf.save());
}

describe("file:save-to-downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.getPath.mockReturnValue("/Users/test/Downloads");
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    mocks.writeFile.mockResolvedValue(undefined);
    registerFileIpc({ getMainWindow: () => null });
  });

  const save = (payload: unknown) => mocks.handlers.get("file:save-to-downloads")!({}, payload);

  it("writes the bytes into the download folder", async () => {
    const result = await save({ fileName: "3Dアニメーション.mp4", dataBase64: Buffer.from("movie").toString("base64") });

    expect(result).toEqual({ filePath: "/Users/test/Downloads/3Dアニメーション.mp4" });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/Users/test/Downloads/3Dアニメーション.mp4",
      Buffer.from("movie"),
    );
  });

  it("never lets the renderer choose the directory or the kind of file", async () => {
    // パスを渡されても葉の名前しか使わない。拡張子は許可リストにあるものだけ。
    await save({ fileName: "../../evil/../3D.mp4", dataBase64: Buffer.from("x").toString("base64") });
    expect(mocks.open).toHaveBeenCalledWith("/Users/test/Downloads/3D.mp4", "wx");

    await expect(save({ fileName: "run.sh", dataBase64: Buffer.from("x").toString("base64") }))
      .rejects.toThrow("この形式のファイルは保存できません。");
  });

  it("adds a suffix instead of replacing a file that is already there", async () => {
    const taken = Object.assign(new Error("exists"), { code: "EEXIST" });
    mocks.open.mockRejectedValueOnce(taken).mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });

    const result = await save({ fileName: "3D.mp4", dataBase64: Buffer.from("x").toString("base64") });

    expect(result).toEqual({ filePath: "/Users/test/Downloads/3D-2.mp4" });
  });

  it("refuses an empty payload", async () => {
    await expect(save({ fileName: "3D.mp4", dataBase64: "" })).rejects.toThrow("保存する内容が指定されていません。");
  });
});


describe("hidden PDF route", () => {
  it("uses the live print route for the Electron development server", async () => {
    const { resolveHiddenPdfDocumentUrl } = await import("../pdf-output-session");
    expect(resolveHiddenPdfDocumentUrl("http://127.0.0.1:3107/?x=1#page")).toBe("http://127.0.0.1:3107/print");
    expect(resolveHiddenPdfDocumentUrl("file:///tmp/out/index.html?x=1#page")).toBe("file:///tmp/out/print.html");
  });
});
