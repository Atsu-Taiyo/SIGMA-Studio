import type { DocumentLoadFailureKind, DocumentLoadResult } from "@/lib/runtime";
import type { SigmaDocumentSchemaFailure } from "@/lib/sigma-doc-schema";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

/** SigmaDocのスキーマ定義の在り処。修復プロンプトに載せてAIの当たりを付けさせる。 */
export const SIGMA_DOC_SCHEMA_SOURCE_PATH = "apps/desktop/src/lib/sigma-doc-schema.ts";

const DEFAULT_ERROR_TRANSLATE = createCurrentLocaleTranslator("error");

function translate(t: Translate<"error">, key: string, replace?: Record<string, unknown>): string {
  return (t as unknown as (key: string, options?: { replace: Record<string, unknown> }) => string)(
    key,
    replace ? { replace } : undefined,
  );
}

/**
 * 「教材の中身が原因で開けなかった」ことを、失敗画面と修復プロンプトの両方へ
 * 渡すために一本化した状態。fileId 単位で保持し、その教材がアクティブな間だけ
 * 本文の代わりに原因を表示する。
 */
export interface DocumentOpenFailure {
  fileId: string;
  title: string;
  error: string;
  kind: DocumentLoadFailureKind;
  failures: SigmaDocumentSchemaFailure[];
  documentPath?: string;
}

/**
 * 教材そのものが壊れている失敗 (json/schema) だけを失敗画面の対象にする。
 * 台帳に無い・IO失敗は「その教材を開いたまま原因を出す」意味が無いので対象外。
 */
export function toDocumentOpenFailure(
  fileId: string,
  result: Extract<DocumentLoadResult, { ok: false }>,
  fallbackTitle: string,
): DocumentOpenFailure | null {
  if (result.failureKind !== "schema" && result.failureKind !== "json") {
    return null;
  }
  return {
    fileId,
    title: result.title?.trim() || fallbackTitle,
    error: result.error,
    kind: result.failureKind,
    failures: result.failures ?? [],
    documentPath: result.documentPath,
  };
}

export function describeDocumentOpenFailureCause(
  failure: DocumentOpenFailure,
  t: Translate<"error"> = DEFAULT_ERROR_TRANSLATE,
): string {
  return failure.kind === "json"
    ? translate(t, "documentOpen.jsonCause")
    : translate(t, "documentOpen.schemaCause");
}

function formatSchemaFailureLines(failures: SigmaDocumentSchemaFailure[], t: Translate<"error">): string {
  return failures
    .map((failure, index) => {
      const lines = [
        `${index + 1}. ${failure.path}`,
        translate(t, "documentOpen.prompt.message", { message: failure.message }),
      ];
      if (failure.expected) {
        lines.push(translate(t, "documentOpen.prompt.expected", { value: failure.expected }));
      }
      if (failure.received !== undefined) {
        lines.push(translate(t, "documentOpen.prompt.actual", { value: failure.received }));
      }
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * そのままAIへ貼れば原因調査と修復に入れる自己完結プロンプト。
 * 教材JSONの絶対パス・違反箇所・スキーマ定義の場所・取り得る2つの直し方を含める。
 */
export function buildDocumentRepairPrompt(
  failure: DocumentOpenFailure,
  t: Translate<"error"> = DEFAULT_ERROR_TRANSLATE,
): string {
  const sections: string[] = [];

  sections.push([
    translate(t, "documentOpen.prompt.intro"),
    "",
    translate(t, "documentOpen.prompt.materialHeading"),
    translate(t, "documentOpen.prompt.materialName", { title: failure.title }),
    `- fileId: ${failure.fileId}`,
    failure.documentPath
      ? translate(t, "documentOpen.prompt.documentJson", { path: failure.documentPath })
      : translate(t, "documentOpen.prompt.unknownDocumentJson"),
    translate(t, "documentOpen.prompt.schemaSource", { path: SIGMA_DOC_SCHEMA_SOURCE_PATH }),
  ].join("\n"));

  sections.push([
    translate(t, "documentOpen.prompt.errorHeading"),
    failure.error,
  ].join("\n"));

  if (failure.failures.length > 0) {
    sections.push([
      translate(t, "documentOpen.prompt.violationsHeading", { count: failure.failures.length }),
      formatSchemaFailureLines(failure.failures, t),
    ].join("\n"));
  }

  sections.push([
    translate(t, "documentOpen.prompt.tasksHeading"),
    translate(t, "documentOpen.prompt.task1"),
    translate(t, "documentOpen.prompt.task2"),
    translate(t, "documentOpen.prompt.task3"),
    translate(t, "documentOpen.prompt.task4"),
    "",
    translate(t, "documentOpen.prompt.preserveContent"),
  ].join("\n"));

  return `${sections.join("\n\n")}\n`;
}
