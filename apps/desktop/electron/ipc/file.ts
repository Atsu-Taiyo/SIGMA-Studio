import { app, ipcMain, dialog, BrowserWindow, shell, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

import {
  renderPdfOutputSession,
  type PdfOutputSessionExpectation,
} from "../pdf-output-session";

const te = createCurrentLocaleTranslator("error");

interface ExportPdfPayload {
  suggestedName?: unknown;
  surfaceId?: unknown;
  revision?: unknown;
  pageCount?: unknown;
  pageWidthMm?: unknown;
  pageHeightMm?: unknown;
}

function ensurePdfFilePath(filePath: string): string {
  return filePath.toLowerCase().endsWith(".pdf") ? filePath : `${filePath}.pdf`;
}

function parsePdfOutputSession(payload: ExportPdfPayload): PdfOutputSessionExpectation {
  const surfaceId = typeof payload.surfaceId === "string" ? payload.surfaceId.trim() : "";
  const revision = Number(payload.revision);
  const pageCount = Number(payload.pageCount);
  const pageWidthMm = Number(payload.pageWidthMm);
  const pageHeightMm = Number(payload.pageHeightMm);
  if (!surfaceId) {
    throw new Error(te("electron.file.pdfSessionMissing"));
  }
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error(te("electron.file.pdfRevisionInvalid"));
  }
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error(te("electron.file.pdfPageCountInvalid"));
  }
  if (!Number.isFinite(pageWidthMm) || pageWidthMm <= 0 || !Number.isFinite(pageHeightMm) || pageHeightMm <= 0) {
    throw new Error(te("electron.file.pdfPageSizeInvalid"));
  }
  return { surfaceId, revision, pageCount, pageWidthMm, pageHeightMm };
}

/**
 * Extensions the renderer may drop into the download folder without a save dialog.
 *
 * The channel writes bytes the renderer produced to a fixed, user-visible directory, so what it
 * may write is pinned here rather than taken from the caller: an executable or a script would be
 * a very different thing to leave in someone's Downloads.
 */
const DOWNLOADABLE_EXTENSIONS = new Set(["mp4", "webm"]);
/** Well past any figure animation; a bound, not a target. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

interface SaveToDownloadsPayload {
  fileName?: unknown;
  dataBase64?: unknown;
}

/**
 * File name the renderer asked for, reduced to a leaf name this process is willing to create.
 *
 * Directory separators, `..`, control characters and the leading dot of a hidden file are all
 * removed rather than rejected: the caller's name is a suggestion drawn from a document title,
 * and a title with a slash in it should still export.
 */
function sanitizeDownloadFileName(rawName: string): { base: string; extension: string } {
  const leaf = rawName.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, "")
    .replace(/^\.+/u, "")
    .trim();
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : "";
  if (!DOWNLOADABLE_EXTENSIONS.has(extension)) {
    throw new Error(te("electron.file.downloadFormatUnsupported"));
  }
  const base = cleaned.slice(0, dot).slice(0, 120).trim();
  return { base: base || "export", extension };
}

/** `name.mp4`, then `name-2.mp4`… — an export never silently replaces an earlier one. */
async function reserveDownloadPath(base: string, extension: string): Promise<string> {
  const directory = app.getPath("downloads");
  await fs.mkdir(directory, { recursive: true });
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = path.join(directory, `${base}${index === 1 ? "" : `-${index}`}.${extension}`);
    try {
      // `wx` fails when the path exists, so the name is taken by creating it, not by checking it.
      const handle = await fs.open(candidate, "wx");
      await handle.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(te("electron.file.downloadNameUnavailable"));
}

export interface RegisterFileIpcDeps {
  getMainWindow: () => BrowserWindow | null;
}

export function registerFileIpc(deps: RegisterFileIpcDeps): void {
  const { getMainWindow } = deps;

  async function exportDocumentPdf(
    sender: WebContents,
    payload: ExportPdfPayload,
  ): Promise<{ filePath: string; pageCount: number } | null> {
    const outputSession = parsePdfOutputSession(payload);
    const saveDialogOptions = {
      title: te("electron.file.exportPdf"),
      defaultPath: typeof payload.suggestedName === "string" && payload.suggestedName.trim()
        ? payload.suggestedName
        : "document.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const senderWindow = BrowserWindow.fromWebContents(sender);
    const fallbackWindow = getMainWindow();
    const parentWindow = senderWindow && !senderWindow.isDestroyed() ? senderWindow : fallbackWindow;
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
      : await dialog.showSaveDialog(saveDialogOptions);
    if (result.canceled || !result.filePath) {
      return null;
    }
    const outputFilePath = ensurePdfFilePath(result.filePath);
    const pdf = await renderPdfOutputSession(sender, outputSession);
    await fs.writeFile(outputFilePath, pdf);
    return { filePath: outputFilePath, pageCount: outputSession.pageCount };
  }

  ipcMain.handle("file:open-sigma-doc", async () => {
    const result = await dialog.showOpenDialog({
      title: te("electron.file.openSigmaDoc"),
      filters: [
        { name: "SigmaDoc", extensions: ["sigmadoc.json", "json"] },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    const data = await fs.readFile(filePath, "utf8");
    return { filePath, data };
  });

  ipcMain.handle("file:open-import-document", async () => {
    const result = await dialog.showOpenDialog({
      title: te("electron.file.importDocument"),
      filters: [
        { name: te("electron.file.documentFiles"), extensions: ["sigmadoc.json", "json", "tex", "latex"] },
        { name: "SigmaDoc", extensions: ["sigmadoc.json", "json"] },
        { name: "TeX", extensions: ["tex", "latex"] },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    const dataBase64 = (await fs.readFile(filePath)).toString("base64");
    return { filePath, dataBase64 };
  });

  ipcMain.handle("file:open-import-other-document", async () => {
    const result = await dialog.showOpenDialog({
      title: te("electron.file.importOtherDocument"),
      filters: [
        { name: te("electron.file.powerPoint"), extensions: ["pptx"] },
        { name: "PowerPoint", extensions: ["pptx"] },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    const dataBase64 = (await fs.readFile(filePath)).toString("base64");
    return { filePath, dataBase64 };
  });

  ipcMain.handle("file:save-sigma-doc", async (_event, payload: { suggestedName?: string; data: string }) => {
    const result = await dialog.showSaveDialog({
      title: te("electron.file.saveSigmaDoc"),
      defaultPath: payload.suggestedName ?? "document.sigmadoc.json",
      filters: [{ name: "SigmaDoc", extensions: ["sigmadoc.json", "json"] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await fs.writeFile(result.filePath, payload.data, "utf8");
    return { filePath: result.filePath };
  });

  ipcMain.handle("file:save-to-downloads", async (_event, payload: SaveToDownloadsPayload) => {
    const fileName = typeof payload?.fileName === "string" ? payload.fileName : "";
    const dataBase64 = typeof payload?.dataBase64 === "string" ? payload.dataBase64 : "";
    if (!fileName || !dataBase64) {
      throw new Error(te("electron.file.downloadContentMissing"));
    }
    const { base, extension } = sanitizeDownloadFileName(fileName);
    const data = Buffer.from(dataBase64, "base64");
    if (data.byteLength === 0) {
      throw new Error(te("electron.file.downloadContentEmpty"));
    }
    if (data.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(te("electron.file.downloadFileTooLarge"));
    }
    const filePath = await reserveDownloadPath(base, extension);
    await fs.writeFile(filePath, data);
    return { filePath };
  });

  ipcMain.handle("file:show-in-folder", async (_event, filePath: unknown) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle("file:export-pdf", async (event, payload: ExportPdfPayload) => {
    return exportDocumentPdf(event.sender, payload);
  });
}
