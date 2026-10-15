import { PDFDocument } from "pdf-lib";
import { BrowserWindow } from "electron";
import { JSDOM } from "jsdom";
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
      mainFrame: { id: 1 },
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

it("restricts conversion capability and import to the main editor frame", async () => {
  mocks.handlers.clear();
  const mainWindow = new BrowserWindow();
  const capability = vi.fn(async () => ({ available: true as const }));
  const convert = vi.fn(async () => ({ ok: false as const, error: "invalid-input" as const }));
  registerFileIpc({ getMainWindow: () => mainWindow, documentConversionClient: { capability, convert } });
  const getCapability = mocks.handlers.get("file:document-conversion-capability")!;
  const convertDocument = mocks.handlers.get("file:convert-document")!;
  const payload = { bytes: Uint8Array.of(1), filename: "数列.prt" };
  expect(await getCapability({ sender })).toEqual({ available: false, reason: "not-allowed" });
  expect(await convertDocument({ sender }, payload)).toEqual({ ok: false, error: "not-allowed" });
  expect(await getCapability({ sender: mainWindow.webContents, senderFrame: { id: 2 } })).toEqual({ available: false, reason: "not-allowed" });
  expect(await convertDocument({ sender: mainWindow.webContents, senderFrame: { id: 2 } }, payload)).toEqual({ ok: false, error: "not-allowed" });
  expect(capability).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  const mainEvent = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  expect(await getCapability(mainEvent)).toEqual({ available: true });
  expect(await convertDocument(mainEvent, payload)).toEqual({ ok: false, error: "invalid-input" });
  expect(capability).toHaveBeenCalledTimes(1);
  expect(convert).toHaveBeenCalledWith(payload);
});

it("only offers the PRT picker filter when conversion is available", async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  const showOpenDialog = vi.mocked((await import("electron")).dialog.showOpenDialog);
  showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  const capability = vi.fn(async () => ({ available: false as const, reason: "unauthorized" as const }));
  registerFileIpc({ getMainWindow: () => new BrowserWindow(), documentConversionClient: {
    capability, convert: vi.fn(),
  } });
  const open = mocks.handlers.get("file:open-import-other-document")!;
  await open({});
  expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
    filters: expect.arrayContaining([{ name: "PowerPoint", extensions: ["pptx"] }]),
  }));
  expect(JSON.stringify(showOpenDialog.mock.calls.at(-1)?.[0])).not.toContain("prt");
  showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/hidden.prt"] });
  expect(await open({})).toBeNull();
  expect((await import("node:fs/promises")).default.readFile).not.toHaveBeenCalled();
  capability.mockResolvedValue({ available: true } as never);
  await open({});
  expect(JSON.stringify(showOpenDialog.mock.calls.at(-1)?.[0])).toContain("prt");
  // 形式名はサービスが名乗らない限り、汎用名になる。
  expect(showOpenDialog.mock.calls.at(-1)?.[0]?.filters).toContainEqual({ name: "外部形式", extensions: ["prt"] });
  capability.mockResolvedValue({ available: true, displayName: "Print Pages" } as never);
  await open({});
  expect(showOpenDialog.mock.calls.at(-1)?.[0]?.filters).toContainEqual({ name: "Print Pages", extensions: ["prt"] });
});

it("only lets the main editor receive and acknowledge OS-selected paths", async () => {
  const mainWindow = new BrowserWindow();
  const pending = { id: 1, filePath: "/Downloads/数学.sigma", data: "content" };
  const readNext = vi.fn(async () => pending);
  const acknowledge = vi.fn();
  registerFileIpc({ getMainWindow: () => mainWindow, externalDocumentOpenQueue: { readNext, acknowledge } });
  const read = mocks.handlers.get("file:get-pending-open-document")!;
  const ack = mocks.handlers.get("file:acknowledge-open-document")!;
  expect(await read({ sender })).toBeNull();
  await ack({ sender }, 1);
  expect(readNext).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(await read({ sender: mainWindow.webContents })).toEqual(pending);
  await ack({ sender: mainWindow.webContents }, 1);
  expect(acknowledge).toHaveBeenCalledWith(1);
});

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

  it("captures duplicate font faces once while preserving subsets, weights, metrics and different sources", async () => {
    const dom = new JSDOM(`
      <div class="paged-surface" data-paged-surface-id="${B5.surfaceId}" data-paged-surface-state="ready"
        data-paged-surface-revision="${B5.revision}" data-paged-surface-page-count="2"
        data-paged-surface-page-width-mm="${B5.pageWidthMm}" data-paged-surface-page-height-mm="${B5.pageHeightMm}">
        <div class="paged-surface-pages">
          <div class="paged-surface-page-slot"><div class="paged-surface-page">one</div></div>
          <div class="paged-surface-page-slot"><div class="paged-surface-page">two</div></div>
        </div>
      </div>
    `, { url: "https://sigma.test/app/", runScripts: "outside-only" });
    // jsdom's CSS parser does not retain all @font-face descriptors in Vitest.
    // Supply the browser CSSOM shape while evaluating the actual capture script.
    const declarations: Array<Record<string, string>> = [
      { "font-family": "Math", "font-weight": "400", src: "url(font.woff2), url(font.woff)", "font-display": "block" },
      { "font-family": "Math", "font-weight": "400", src: "url(font.woff2)" },
      { "font-family": "Math", "font-weight": "700", src: "url(font.woff2)" },
      { "font-family": "Math", "font-weight": "400", src: "url(font.woff2)", "unicode-range": "U+30-39" },
      { "font-family": "Math", "font-weight": "400", src: "url(font.woff2)", "size-adjust": "110%" },
      { "font-family": "Math", "font-weight": "400", src: "url(other.woff2)" },
    ];
    const rules = declarations.map(declaration => ({
      type: dom.window.CSSRule.FONT_FACE_RULE,
      cssText: "@font-face { " + Object.entries(declaration).map(([name, value]) => `${name}: ${value};`).join(" ") + " }",
      style: { getPropertyValue: (name: string) => declaration[name] ?? "" },
    }));
    Object.defineProperty(dom.window.document, "styleSheets", { value: [{
      cssRules: [...rules, { type: dom.window.CSSRule.STYLE_RULE, cssText: ".paper { color: black; }" }],
    }] });
    const captures: string[] = [];
    mocks.executeJavaScript.mockImplementation(async (script: string) => {
      const result = await dom.window.eval(script) as { documentHtml?: string };
      if (result.documentHtml) captures.push(result.documentHtml);
      return result;
    });
    mocks.printToPDF.mockResolvedValue(await createPdf(1, B5.pageWidthMm, B5.pageHeightMm));
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/Downloads/math.pdf" });
    try {
      registerFileIpc({ getMainWindow: () => null });
      await mocks.handlers.get("file:export-pdf")!({ sender }, B5);
      expect(captures).toHaveLength(2);
      for (const html of captures) {
        expect(html.match(/@font-face/g)).toHaveLength(5);
        expect(html).not.toContain("font-display: block");
        expect(html).toContain("https://sigma.test/app/font.woff2");
        expect(html).toContain("https://sigma.test/app/other.woff2");
        expect(html).toContain("unicode-range: U+30-39");
        expect(html).toContain("size-adjust: 110%");
        expect(html).toContain("font-weight: 700");
        expect(html).toContain(".paper");
      }
      // Capturing the output must not mutate the preview's own font definitions.
      expect(dom.window.document.styleSheets[0].cssRules).toHaveLength(7);
    } finally {
      dom.window.close();
    }
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

  it("normalizes whitespace without changing the download directory or extension", async () => {
    mocks.getPath.mockReturnValue("/Users/test/My Downloads");
    const result = await save({ fileName: " 数学\u3000演習.mp4 ", dataBase64: Buffer.from("x").toString("base64") });
    expect(result).toEqual({ filePath: "/Users/test/My Downloads/数学-演習.mp4" });
  });

  it("never lets the renderer choose the directory or the kind of file", async () => {
    // パスを渡されても葉の名前しか使わない。拡張子は許可リストにあるものだけ。
    await save({ fileName: "../../evil/../3D.mp4", dataBase64: Buffer.from("x").toString("base64") });
    expect(mocks.open).toHaveBeenCalledWith("/Users/test/Downloads/3D.mp4", "wx");

    await expect(save({ fileName: "run.sh", dataBase64: Buffer.from("x").toString("base64") }))
      .rejects.toThrow("この形式のファイルは保存できません。");
  });

  it("accepts a screenshot only when the bytes really are a PNG", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
    const result = await save({ fileName: "screenshot-20261003-142530.png", dataBase64: png.toString("base64") });
    expect(result).toEqual({ filePath: "/Users/test/Downloads/screenshot-20261003-142530.png" });
    expect(mocks.writeFile).toHaveBeenCalledWith("/Users/test/Downloads/screenshot-20261003-142530.png", png);

    mocks.writeFile.mockClear();
    await expect(save({ fileName: "fake.png", dataBase64: Buffer.from("#!/bin/sh").toString("base64") }))
      .rejects.toThrow("この形式のファイルは保存できません。");
    expect(mocks.writeFile).not.toHaveBeenCalled();
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

// These tests isolate handler behavior; sender authorization is tested in trusted-ipc.test.ts.
vi.mock("../trusted-ipc", async () => ({ ipcMain: (await import("electron")).ipcMain }));
