import { describe, expect, it } from "vitest";

import type { LedgerSchemaFailure } from "@/lib/library-schema";

import { buildLedgerRepairPrompt } from "./ledger-schema-failure";
import { createTranslator } from "@/lib/i18n";

describe("buildLedgerRepairPrompt", () => {
  it("台帳データだけを直す自己完結プロンプトを生成する", () => {
    const failure: LedgerSchemaFailure = {
      libraryPath: "/Users/example/Library/Application Support/Sigma Studio/data/library.json",
      expectedVersion: 4,
      actualVersion: 3,
      violations: [
        {
          path: "version",
          reason: { kind: "versionMismatch" as const },
          expected: "4",
          received: "3",
        },
        {
          path: "workspaces[0].kind",
          reason: { kind: "forbiddenField" as const, field: "kind" },
          expected: null,
          received: '"cloud"',
        },
      ],
    };

    const prompt = buildLedgerRepairPrompt(failure);

    expect(prompt).toContain(failure.libraryPath);
    expect(prompt).toContain("apps/desktop/src/lib/library-schema.ts");
    expect(prompt).toContain("version");
    expect(prompt).toContain("workspaces[0].kind");
    expect(prompt).toContain("(フィールドが存在しないこと)");
    // `forbiddenField` の枝とその `{{field}}` 補間を、プロンプト経路でも踏む。
    // fixture の reason を versionMismatch のままにしていると、フィールド違反なのに
    // 「バージョンが一致しません」と書かれたプロンプトを緑で通してしまう。
    expect(prompt).toContain("廃止されたフィールド「kind」が残っています。");
    expect(prompt).toContain('"cloud"');
    expect(prompt).toContain("バックアップ");
    expect(prompt).toContain("quarantine");
    expect(prompt).toContain("再読み込み");
    expect(prompt).not.toContain("スキーマ側に定義を足して");
  });

  it("英語UIでは修復手順を英語化し、JSON pathと値を保持する", () => {
    const failure: LedgerSchemaFailure = {
      libraryPath: "/raw/path/library.json",
      expectedVersion: 4,
      actualVersion: 3,
      violations: [{
        path: "workspaces[0].kind",
        reason: { kind: "forbiddenField", field: "kind" },
        expected: null,
        received: '"cloud"',
      }],
    };
    const prompt = buildLedgerRepairPrompt(
      failure,
      createTranslator("en", "error"),
      createTranslator("en", "workspace"),
    );

    expect(prompt).toContain("## Repair target");
    expect(prompt).toContain("/raw/path/library.json");
    expect(prompt).toContain("workspaces[0].kind");
    expect(prompt).toContain('   - Actual: "cloud"');
    expect(prompt).toContain("obsolete field \"kind\"");
    expect(prompt).not.toContain("## やってほしいこと");
  });
});
