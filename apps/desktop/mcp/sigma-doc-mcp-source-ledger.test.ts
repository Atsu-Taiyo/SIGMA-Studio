import { beforeEach, describe, expect, it } from "vitest";

import {
  MCP_SOURCE_LEDGER_RUN_LIMIT,
  clearSourceLedgerForTests,
  collectUsedSourceReferences,
  getSourceLedgerRunCountForTests,
  recordDocumentRead,
  recordLibrarySearchHits,
  recordMentionedDocuments,
} from "./sigma-doc-mcp-source-ledger";

describe("MCP source ledger", () => {
  beforeEach(() => {
    clearSourceLedgerForTests();
  });

  it("cites a library hit only after the agent actually read it", () => {
    recordLibrarySearchHits("run-1", [
      { fileId: "file_a", title: "微分法①" },
      { fileId: "file_b", title: "微分法②" },
    ]);
    recordDocumentRead("run-1", "file_a");

    expect(collectUsedSourceReferences("run-1", "file_current")).toEqual([
      { type: "document", fileId: "file_a", title: "微分法①" },
    ]);
  });

  it("cites a mentioned document even when it was never read", () => {
    recordMentionedDocuments("run-1", [{ fileId: "file_m", title: "指数関数" }]);

    expect(collectUsedSourceReferences("run-1", "file_current")).toEqual([
      { type: "document", fileId: "file_m", title: "指数関数" },
    ]);
  });

  it("never cites the document currently being edited", () => {
    recordLibrarySearchHits("run-1", [{ fileId: "file_current", title: "編集中" }]);
    recordDocumentRead("run-1", "file_current");
    recordMentionedDocuments("run-1", [{ fileId: "file_current", title: "編集中" }]);

    expect(collectUsedSourceReferences("run-1", "file_current")).toEqual([]);
  });

  it("folds a document that was both a search hit and a mention into one citation", () => {
    recordLibrarySearchHits("run-1", [{ fileId: "file_a", title: "微分法①" }]);
    recordDocumentRead("run-1", "file_a");
    recordMentionedDocuments("run-1", [{ fileId: "file_a", title: "微分法①" }]);

    expect(collectUsedSourceReferences("run-1", "file_current")).toHaveLength(1);
  });

  it("keeps runs isolated from each other", () => {
    recordLibrarySearchHits("run-1", [{ fileId: "file_a" }]);
    recordDocumentRead("run-1", "file_a");
    recordDocumentRead("run-2", "file_a");

    expect(collectUsedSourceReferences("run-2", "file_current")).toEqual([]);
  });

  it("ignores calls without a runId so external CLIs keep the old behaviour", () => {
    recordLibrarySearchHits(undefined, [{ fileId: "file_a" }]);
    recordDocumentRead(undefined, "file_a");

    expect(collectUsedSourceReferences(undefined, "file_current")).toEqual([]);
    expect(getSourceLedgerRunCountForTests()).toBe(0);
  });

  it("drops a title that is only whitespace instead of citing a blank label", () => {
    recordLibrarySearchHits("run-1", [{ fileId: "file_a", title: "   " }]);
    recordDocumentRead("run-1", "file_a");

    expect(collectUsedSourceReferences("run-1", "file_current")).toEqual([
      { type: "document", fileId: "file_a" },
    ]);
  });

  it("evicts the oldest runs so a long-lived shared server cannot grow without bound", () => {
    for (let index = 0; index < MCP_SOURCE_LEDGER_RUN_LIMIT + 5; index += 1) {
      recordDocumentRead(`run-${index}`, "file_a");
    }

    expect(getSourceLedgerRunCountForTests()).toBe(MCP_SOURCE_LEDGER_RUN_LIMIT);
    expect(collectUsedSourceReferences("run-0", "file_current")).toEqual([]);
  });

  it("bounds how many documents a single run can accumulate", () => {
    const overflow = 400;
    for (let index = 0; index < overflow; index += 1) {
      recordMentionedDocuments("run-1", [{ fileId: `file_${index}` }]);
    }

    expect(collectUsedSourceReferences("run-1", "file_current").length).toBeLessThanOrEqual(200);
  });
});
