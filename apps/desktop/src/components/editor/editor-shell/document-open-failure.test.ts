import { describe, expect, it } from "vitest";

import {
  buildDocumentRepairPrompt,
  describeDocumentOpenFailureCause,
  toDocumentOpenFailure,
  type DocumentOpenFailure,
} from "./document-open-failure";
import { createTranslator } from "@/lib/i18n";

const SCHEMA_FAILURE: DocumentOpenFailure = {
  fileId: "file_1",
  title: "三角関数の総復習",
  error: 'SigmaDocの必須構造を読み込めませんでした (pageLayout.preset): Invalid option: expected one of "A4"|"A3"',
  kind: "schema",
  documentPath: "/Users/me/Library/Application Support/Sigma Studio/data/documents/file_1.sigmadoc.json",
  failures: [
    {
      path: "pageLayout.preset",
      message: 'Invalid option: expected one of "A4"|"A3"',
      code: "invalid_value",
      expected: '"A4" | "A3"',
      received: '"whiteboard"',
    },
  ],
};

describe("toDocumentOpenFailure", () => {
  it("keeps failures caused by the document contents and prefers the ledger title", () => {
    expect(toDocumentOpenFailure("file_1", {
      ok: false,
      error: "壊れています",
      failureKind: "schema",
      failures: [{ path: "content[0].type", message: "Invalid input" }],
      documentPath: "/data/documents/file_1.sigmadoc.json",
      title: "台帳のタイトル",
    }, "一覧のタイトル")).toEqual({
      fileId: "file_1",
      title: "台帳のタイトル",
      error: "壊れています",
      kind: "schema",
      failures: [{ path: "content[0].type", message: "Invalid input" }],
      documentPath: "/data/documents/file_1.sigmadoc.json",
    });
  });

  it("falls back to the given title and tolerates a missing failure breakdown", () => {
    expect(toDocumentOpenFailure("file_2", {
      ok: false,
      error: "教材JSONの構文が壊れているため読み込めませんでした。",
      failureKind: "json",
    }, "一覧のタイトル")).toMatchObject({
      title: "一覧のタイトル",
      kind: "json",
      failures: [],
    });
  });

  it("ignores failures that are not about the document contents", () => {
    // 台帳に無い/IO失敗は「その教材を開いたまま原因を出す」対象にしない。
    expect(toDocumentOpenFailure("file_3", {
      ok: false,
      error: "教材ファイルが見つかりません。",
      failureKind: "missing",
    }, "一覧のタイトル")).toBeNull();
    expect(toDocumentOpenFailure("file_4", {
      ok: false,
      error: "EACCES",
      failureKind: "io",
    }, "一覧のタイトル")).toBeNull();
    expect(toDocumentOpenFailure("file_5", { ok: false, error: "不明" }, "一覧のタイトル")).toBeNull();
  });
});

describe("describeDocumentOpenFailureCause", () => {
  it("separates broken JSON from schema violations", () => {
    expect(describeDocumentOpenFailureCause(SCHEMA_FAILURE)).toBe("教材の内容がSigmaDocのスキーマに合っていません");
    expect(describeDocumentOpenFailureCause({ ...SCHEMA_FAILURE, kind: "json" }))
      .toBe("教材JSONの構文が壊れています");
  });

  it("resolves the cause in English", () => {
    const t = createTranslator("en", "error");
    expect(describeDocumentOpenFailureCause(SCHEMA_FAILURE, t))
      .toBe("The teaching material does not match the SigmaDoc schema");
  });
});

describe("buildDocumentRepairPrompt", () => {
  it("carries everything an AI needs: the document path, the violations and both repair options", () => {
    const prompt = buildDocumentRepairPrompt(SCHEMA_FAILURE);

    expect(prompt).toContain("三角関数の総復習");
    expect(prompt).toContain("file_1");
    expect(prompt).toContain("/Users/me/Library/Application Support/Sigma Studio/data/documents/file_1.sigmadoc.json");
    expect(prompt).toContain("apps/desktop/src/lib/sigma-doc-schema.ts");
    expect(prompt).toContain(SCHEMA_FAILURE.error);
    expect(prompt).toContain("1. pageLayout.preset");
    expect(prompt).toContain('   - 期待される値: "A4" | "A3"');
    expect(prompt).toContain('   - 実際の値: "whiteboard"');
    expect(prompt).toContain("スキーマ側に定義を足して");
    expect(prompt).toContain("教材JSONの該当箇所だけを正しい形へ直して");
  });

  it("explains where to look when the document path is unknown and skips an empty breakdown", () => {
    const prompt = buildDocumentRepairPrompt({
      ...SCHEMA_FAILURE,
      documentPath: undefined,
      failures: [],
    });

    expect(prompt).toContain("data/documents/<fileId>.sigmadoc.json");
    expect(prompt).not.toContain("スキーマに合わなかった箇所");
  });

  it("localizes instructions but preserves paths and raw schema diagnostics", () => {
    const prompt = buildDocumentRepairPrompt(SCHEMA_FAILURE, createTranslator("en", "error"));

    expect(prompt).toContain("## Material that could not be opened");
    expect(prompt).toContain(SCHEMA_FAILURE.documentPath);
    expect(prompt).toContain(SCHEMA_FAILURE.error);
    expect(prompt).toContain('   - Expected: "A4" | "A3"');
    expect(prompt).toContain('   - Actual: "whiteboard"');
    expect(prompt).not.toContain("## やってほしいこと");
  });
});
