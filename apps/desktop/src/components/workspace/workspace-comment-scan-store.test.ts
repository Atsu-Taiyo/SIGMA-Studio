import { describe, expect, it } from "vitest";

import { createCommentScanStore } from "./workspace-comment-scan-store";
import type { CommentScanRecord } from "./workspace-comment-scanner";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    clear: () => data.clear(),
  };
}

const record: CommentScanRecord = {
  stamp: "1:2026-09-01T00:00:00.000Z",
  scannedAt: 100,
  threads: [{
    threadId: "t1", resolved: false, mentioned: true, authored: false, messageId: "m1",
    ownMessage: false, excerpt: "@私", messageCount: 1, activityAt: "2026-09-01T00:00:00.000Z", quote: "",
  }],
};

describe("createCommentScanStore", () => {
  it("reads back what it saved", () => {
    const storage = memoryStorage();
    createCommentScanStore("me", storage)!.save({ a: record });
    expect(createCommentScanStore("me", storage)!.load()).toEqual({ a: record });
  });

  it("keeps each user's results apart and removes the other users' on entry", () => {
    const storage = memoryStorage();
    createCommentScanStore("alice", storage)!.save({ a: record });
    expect(createCommentScanStore("bob", storage)!.load()).toBeNull();
    expect(createCommentScanStore("alice", storage)!.load()).toBeNull();
  });

  it("ignores broken saved values and keeps only well-formed records", () => {
    const storage = memoryStorage();
    const key = "sigma-studio:workspace-comment-scan:v1:me";
    storage.setItem(key, "{not json");
    expect(createCommentScanStore("me", storage)!.load()).toBeNull();
    storage.setItem(key, JSON.stringify({ good: record, badStamp: { ...record, stamp: 1 }, noThreads: { stamp: "x", scannedAt: 1 }, badThread: { ...record, threads: [{}] } }));
    expect(createCommentScanStore("me", storage)!.load()).toEqual({ good: record });
  });

  it("does not throw when saving is refused", () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
    expect(() => createCommentScanStore("me", storage)!.save({ a: record })).not.toThrow();
  });

  it("runs without a store when storage is unavailable", () => {
    expect(createCommentScanStore("me", null)).toBeUndefined();
  });
});
