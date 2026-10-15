import {
  ensurePageLayout,
  repairDuplicateTopLevelIds,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type SigmaDocument,
} from "@/features/document";
import { getAppLocale } from "@/lib/i18n";
import type { ExtensionImportIssue } from "@/lib/extension-contracts";
import { importPowerPointPptxBuffer, isPowerPointPptxFilename } from "@/lib/powerpoint-import";
import { recoverSigmaDocument, type SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import { importTexDocument, isTexFilename } from "@/lib/tex-import";

type DocumentFileFormat = "sigmadoc" | "tex" | "pptx";

type ReadableDocumentFileImport = { kind: "readable"; file: File; format: DocumentFileFormat };

interface DocumentFileImportEnvironment extends DocumentBlockClock, DocumentBlockIdFactory {
  createDocumentId(): string;
  defaultTitle(): string;
}

const IMPORT_SUCCESS_KEYS = {
  sigmadoc: "status.jsonImported",
  tex: "status.texConverted",
  pptx: "status.powerPointConverted",
} as const satisfies Record<DocumentFileFormat, string>;

/** ファイル名から取り込み形式を選ぶ。ファイルの読み取りは実行段階で行う。 */
export function planDocumentFileImport(file: File): ReadableDocumentFileImport {
  const format = isTexFilename(file.name) ? "tex"
    : isPowerPointPptxFilename(file.name) ? "pptx" : "sigmadoc";
  return { kind: "readable", file, format };
}

/** 取り込み結果の共通の仕上げ: 開いたファイル名を題名にし、教材の id と更新時刻を新しくする。 */
function finishImportedDocument(imported: SigmaDocument, sourceName: string, environment: DocumentFileImportEnvironment): SigmaDocument {
  const now = environment.now();
  // 開くときに選んだ名前を教材名にする。JSON 内の古い題名や変換元の見出しを優先すると、
  // OS 上で名前を変えて開き直してもタブ・教材一覧にその名前が反映されない。
  const fileTitle = sourceName.trim().replace(/(?:\.(?:sigma|sigmadoc)\.json|\.[^.]+)$/i, "").trim();
  return repairDuplicateTopLevelIds(ensurePageLayout({
    ...imported,
    docId: environment.createDocumentId(),
    metadata: {
      ...imported.metadata,
      title: fileTitle || imported.metadata.title || environment.defaultTitle(),
    },
    updatedAt: now,
  }), environment);
}

export interface PreparedDocumentImport {
  document: SigmaDocument;
  recoveryIssues: SigmaDocumentRecoveryIssue[];
  successMessageKey: typeof IMPORT_SUCCESS_KEYS[DocumentFileFormat] | "status.extensionImported";
  /** 拡張機能が取り込みに添えた所見。ある場合だけ、取り込み後に結果を見せる。 */
  importIssues?: ExtensionImportIssue[];
}

/**
 * 各形式を、別の教材として開ける SigmaDoc へ変換する。
 * ここでは現在の教材・保存先・タブを変更しない。復旧警告と未翻訳の成功キーを返すので、
 * shell が保存と切替を完了してから、その時点の言語で結果を表示できる。
 */
export async function prepareDocumentFileImport(
  request: ReadableDocumentFileImport,
  environment: DocumentFileImportEnvironment,
): Promise<PreparedDocumentImport> {
  const { file, format } = request;
  let imported: SigmaDocument;
  let recoveryIssues: SigmaDocumentRecoveryIssue[] = [];
  switch (request.format) {
    case "tex":
      imported = importTexDocument(await file.text(), file.name);
      break;
    case "pptx":
      imported = await importPowerPointPptxBuffer(await file.arrayBuffer(), file.name, { locale: getAppLocale() });
      break;
    case "sigmadoc": {
      const recovered = recoverSigmaDocument(JSON.parse(await file.text()));
      if (!recovered.ok) {
        throw new Error(recovered.error);
      }
      recoveryIssues = recovered.issues;
      imported = repairDuplicateTopLevelIds(ensurePageLayout(recovered.document), environment);
      break;
    }
  }
  return { document: finishImportedDocument(imported, file.name, environment), recoveryIssues, successMessageKey: IMPORT_SUCCESS_KEYS[format] };
}

/**
 * 拡張機能が返した教材を、別の教材として開ける形にする。
 * 中身はホストが形を検査済みだが、保存に使うので `recoverSigmaDocument` をもう一度通し、壊れた部分は直して警告にする。
 */
export function prepareExtensionDocumentImport(
  result: { document: unknown; issues: ExtensionImportIssue[]; sourceName: string },
  environment: DocumentFileImportEnvironment,
): PreparedDocumentImport {
  const recovered = recoverSigmaDocument(result.document);
  if (!recovered.ok) throw new Error(recovered.error);
  return {
    document: finishImportedDocument(recovered.document, result.sourceName, environment),
    recoveryIssues: recovered.issues,
    successMessageKey: "status.extensionImported",
    ...(result.issues.length ? { importIssues: result.issues } : {}),
  };
}

/** Electron のファイル選択結果を、input / テキスト取り込みと同じ File 境界へ載せ替える。 */
export function fileFromDesktopImport(
  result: { filePath: string; dataBase64: string },
  fallbackName = "document.sigmadoc.json",
): File {
  const baseName = result.filePath.split(/[\\/]/).pop() ?? fallbackName;
  const binary = window.atob(result.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], baseName);
}
