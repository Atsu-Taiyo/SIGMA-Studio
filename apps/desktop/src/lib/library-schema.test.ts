import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { describeLedgerSchemaFailure, describeLedgerSchemaViolation, findLedgerSchemaViolations } from "./library-schema";

const tJa = createTranslator("ja", "workspace");
const tEn = createTranslator("en", "workspace");

const FAILURE = {
  libraryPath: "/tmp/sigma/library.json",
  expectedVersion: 4,
  actualVersion: 3,
  violations: [
    { path: "version", reason: { kind: "versionMismatch" as const }, expected: "4", received: "3" },
    {
      path: "workspaces[0].kind",
      reason: { kind: "forbiddenField" as const, field: "kind" },
      expected: null,
      received: "\"cloud\"",
    },
  ],
};

describe("describeLedgerSchemaFailure", () => {
  it("includes the ledger path, versions, and each violation detail", () => {
    expect(describeLedgerSchemaFailure(FAILURE, tJa)).toBe(
      "教材ライブラリの索引 (/tmp/sigma/library.json) が現行スキーマに合っていません。期待バージョン 4 / 実際 3。違反 2 件: version (期待 4 / 実際 3), workspaces[0].kind (期待 (フィールドが存在しないこと) / 実際 \"cloud\")",
    );
  });

  /**
   * 違反は**画面 (表示言語) と AI 修復プロンプト (既定ロケール固定) の 2 か所**へ流れる。
   * だから `LedgerSchemaViolation` は訳文ではなく `reason` を持ち、読み手側で文にする。
   * ここでは同じ違反が英語で引くと英語になり、日本語が 1 文字も混ざらないことを見る。
   */
  it("describes the same failure in English without leaving Japanese behind", () => {
    const english = describeLedgerSchemaFailure(FAILURE, tEn);
    expect(english).toContain("/tmp/sigma/library.json");
    expect(english).not.toMatch(/[ぁ-んァ-ヶ一-龥]/u);
    expect(english).not.toBe(describeLedgerSchemaFailure(FAILURE, tJa));
  });
});

describe("findLedgerSchemaViolations", () => {
  it("reports a version mismatch", () => {
    expect(findLedgerSchemaViolations({ version: 3 })).toMatchObject([
      { path: "version", expected: "4", received: "3" },
    ]);
  });

  it("reports a legacy workspace kind with its row index", () => {
    const violations = findLedgerSchemaViolations({
      version: 4,
      workspaces: [{ id: "w", kind: "cloud" }],
    });

    expect(violations[0]?.path).toBe("workspaces[0].kind");
    // 「フィールドが存在しないこと」は**読み手の言語で作る文言**なので、
    // 検出側は `null` (= 期待値なし) だけを持つ。
    expect(violations[0]?.expected).toBeNull();
    expect(describeLedgerSchemaViolation(violations[0]!, tJa).expected).toBe("(フィールドが存在しないこと)");
    expect(violations[0]?.received).toBe("\"cloud\"");
  });

  it.each([
    ["files", "kind", "files[0].kind"],
    ["files", "cloudState", "files[0].cloudState"],
    ["files", "remoteRevision", "files[0].remoteRevision"],
    ["workspaces", "role", "workspaces[0].role"],
    ["workspaces", "memberCount", "workspaces[0].memberCount"],
    ["workspaces", "remoteId", "workspaces[0].remoteId"],
  ] as const)("reports %s[0].%s", (table, field, expectedPath) => {
    const violations = findLedgerSchemaViolations({
      version: 4,
      [table]: [{ [field]: "legacy" }],
    });

    expect(violations[0]?.path).toBe(expectedPath);
  });

  it("does not inspect forensic quarantine entries", () => {
    expect(findLedgerSchemaViolations({
      version: 4,
      quarantine: [{ kind: "cloud" }],
    })).toEqual([]);
  });

  it("accepts a valid v4 ledger", () => {
    expect(findLedgerSchemaViolations({
      version: 4,
      activeWorkspaceId: "w",
      workspaces: [{ id: "w", name: "マイ教材" }],
      folders: [],
      files: [{ fileId: "f", workspaceId: "w" }],
    })).toEqual([]);
  });
});
