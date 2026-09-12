import {
  ensurePageLayout,
  repairDuplicateTopLevelIds,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type SigmaDocument,
} from "@/features/document";
import { getAppLocale } from "@/lib/i18n";
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
    : isPowerPointPptxFilename(file.name) ? "pptx"
      : "sigmadoc";
  return { kind: "readable", file, format };
}

/**
 * 各形式を、別の教材として開ける SigmaDoc へ変換する。
 * ここでは現在の教材・保存先・タブを変更しない。復旧警告と未翻訳の成功キーを返すので、
 * shell が保存と切替を完了してから、その時点の言語で結果を表示できる。
 */
export async function prepareDocumentFileImport(
  request: ReadableDocumentFileImport,
  environment: DocumentFileImportEnvironment,
): Promise<{
  document: SigmaDocument;
  recoveryIssues: SigmaDocumentRecoveryIssue[];
  successMessageKey: typeof IMPORT_SUCCESS_KEYS[DocumentFileFormat];
}> {
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
  const now = environment.now();
  // 開くときに選んだ名前を教材名にする。JSON 内の古い題名や変換元の見出しを優先すると、
  // OS 上で名前を変えて開き直してもタブ・教材一覧にその名前が反映されない。
  const fileTitle = file.name.trim().replace(/(?:\.sigmadoc\.json|\.[^.]+)$/i, "").trim();
  const document = repairDuplicateTopLevelIds(ensurePageLayout({
    ...imported,
    docId: environment.createDocumentId(),
    metadata: {
      ...imported.metadata,
      title: fileTitle || imported.metadata.title || environment.defaultTitle(),
    },
    updatedAt: now,
  }), environment);

  return { document, recoveryIssues, successMessageKey: IMPORT_SUCCESS_KEYS[format] };
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
