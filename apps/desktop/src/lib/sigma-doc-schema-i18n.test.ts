import { afterEach, describe, expect, it } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { ensurePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import { getDocumentIssues, getTexIssues, parseSigmaDocument, recoverSigmaDocument } from "@/lib/sigma-doc-schema";

describe("SigmaDoc schema and recovery i18n", () => {
  afterEach(() => {
    setAppLocale("ja");
  });

  it("resolves recovery and validation messages in the active locale", () => {
    setAppLocale("en");

    const unrecoverable = recoverSigmaDocument({ nope: true });
    expect(unrecoverable.ok).toBe(false);
    if (!unrecoverable.ok) {
      expect(unrecoverable.error).toContain("Could not read the required SigmaDoc structure");
    }

    const recovered = recoverSigmaDocument({
      ...ensurePageLayout(sampleDocument),
      comments: { invalid: true },
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.issues[0]?.message).toBe("Dropped the comment list because its format is invalid.");
    }

    expect(getTexIssues(String.raw`\unknown`, "math_1"))
      .toContain("Formula math_1 contains the disallowed TeX command \\unknown.");

    setAppLocale("ja");
    expect(getTexIssues(String.raw`\unknown`, "math_1"))
      .toContain("数式 math_1 に未許可のTeXコマンド \\unknown があります。");
    const recoveredInJapanese = recoverSigmaDocument({
      ...ensurePageLayout(sampleDocument),
      comments: { invalid: true },
    });
    expect(recoveredInJapanese.ok && recoveredInJapanese.issues[0]?.message)
      .toBe("コメント一覧の形式が異なるため除外しました。");
  });

  it("localizes whiteboard validation without changing the document", () => {
    const document = ensurePageLayout({
      ...sampleDocument,
      content: sampleDocument.content.slice(0, 1),
    });
    document.pageLayout = {
      ...document.pageLayout!,
      preset: "whiteboard",
    };

    setAppLocale("en");
    expect(() => parseSigmaDocument(document)).toThrow(
      "Documents in infinite-canvas (whiteboard) mode cannot contain body blocks",
    );
    expect(getDocumentIssues(document)).toContain(
      "Documents in infinite-canvas (whiteboard) mode cannot contain body blocks",
    );
    expect(document.content).toHaveLength(1);
  });
});
