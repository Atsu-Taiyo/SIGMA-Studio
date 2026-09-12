import { describe, expect, it } from "vitest";

import { DocumentHistoryController } from "./document-history";

type TestDocument = { id: string };

describe("DocumentHistoryController", () => {
  it("undoes and redoes the same document instances without cloning", () => {
    const history = new DocumentHistoryController<TestDocument, string | null>(10);
    const before = { id: "before" };
    const after = { id: "after" };

    history.record({ document: before, selection: "before-block", metadata: { origin: "user" } });

    const undone = history.undo({ document: after, selection: "after-block" });
    expect(undone?.document).toBe(before);
    expect(undone?.selection).toBe("before-block");

    const redone = history.redo({ document: before, selection: "before-block" });
    expect(redone?.document).toBe(after);
    expect(redone?.selection).toBe("after-block");
  });

  // A caller that may refuse a restore (e.g. because AI holds one of the blocks
  // the entry would change) must be able to inspect it before either stack moves.
  it("peeks the next restore target without consuming it", () => {
    const history = new DocumentHistoryController<TestDocument, string | null>(10);
    const before = { id: "before" };
    const after = { id: "after" };

    expect(history.peek("undo")).toBeNull();
    expect(history.peek("redo")).toBeNull();

    history.record({ document: before, selection: "before-block" });
    expect(history.peek("undo")?.document).toBe(before);
    expect(history.undoDepth).toBe(1);
    // Peeking twice keeps returning the same entry, and undo still gets it.
    expect(history.peek("undo")?.document).toBe(before);
    expect(history.undo({ document: after, selection: "after-block" })?.document).toBe(before);

    expect(history.peek("undo")).toBeNull();
    expect(history.peek("redo")?.document).toBe(after);
    expect(history.redoDepth).toBe(1);
  });

  it("carries transaction metadata through repeated undo and redo", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);
    const metadata = {
      origin: "automation",
      correlationIds: ["correlation-1", "correlation-2"],
    } as const;
    const before = { id: "before" };
    const after = { id: "after" };

    history.record({ document: before, selection: null, metadata });
    const undone = history.undo({ document: after, selection: null });
    const redone = history.redo({ document: before, selection: null });
    const undoneAgain = history.undo({ document: after, selection: null });

    expect(undone?.metadata).toBe(metadata);
    expect(redone?.metadata).toBe(metadata);
    expect(undoneAgain?.metadata).toBe(metadata);
  });

  it("clears the redo branch when a new entry is recorded", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);
    const first = { id: "first" };
    const second = { id: "second" };
    const replacement = { id: "replacement" };

    history.record({ document: first, selection: null, metadata: { origin: "user" } });
    expect(history.undo({ document: second, selection: null })?.document).toBe(first);
    expect(history.redoDepth).toBe(1);

    history.record({ document: replacement, selection: null, metadata: { origin: "user" } });

    expect(history.redoDepth).toBe(0);
    expect(history.redo({ document: replacement, selection: null })).toBeNull();
  });

  it("coalesces consecutive records with the same key into one undo event", () => {
    const history = new DocumentHistoryController<TestDocument, string | null>(10);
    const beforeTyping = { id: "before-typing" };
    const afterFirstCharacter = { id: "after-first-character" };
    const afterSecondCharacter = { id: "after-second-character" };

    history.record(
      { document: beforeTyping, selection: "paragraph" },
      { coalescingKey: "typing:1" },
    );
    history.record(
      { document: afterFirstCharacter, selection: "paragraph" },
      { coalescingKey: "typing:1" },
    );

    expect(history.undoDepth).toBe(1);
    expect(history.undo({
      document: afterSecondCharacter,
      selection: "paragraph",
    })?.document).toBe(beforeTyping);
  });

  it("starts a new undo event when the coalescing key or operation changes", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);

    history.record({ document: { id: "before-a" }, selection: null }, { coalescingKey: "typing:1" });
    history.record({ document: { id: "after-a" }, selection: null }, { coalescingKey: "typing:2" });
    history.record({ document: { id: "after-b" }, selection: null });
    history.record({ document: { id: "after-command" }, selection: null }, { coalescingKey: "typing:2" });

    expect(history.undoDepth).toBe(4);
  });

  it("always records when no key is given", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);

    history.record({ document: { id: "a" }, selection: null });
    history.record({ document: { id: "b" }, selection: null });

    expect(history.undoDepth).toBe(2);
  });

  it("records a keyed change that follows an unrelated one", () => {
    // 混在ペースト / カットが 1 エントリに畳まれる仕組みの裏返し。本文が同じキーで先に
    // record 済みなら図形側は畳まれるが、**本文が変わっていない (図形だけの操作) なら
    // 直前のキーと違うので必ず積まれる**。ここが崩れると図形だけの操作が永久に undo
    // できなくなる (`coalesce: true` を使う設計だとまさにそれが起きる)。
    const history = new DocumentHistoryController<TestDocument, null>(10);
    const beforeShapeOnlyCut = { id: "before-shape-only-cut" };

    history.record({ document: { id: "typed" }, selection: null }, { coalescingKey: "typing:1" });
    history.record({ document: beforeShapeOnlyCut, selection: null }, { coalescingKey: "mixed_clipboard_history_1" });

    expect(history.undoDepth).toBe(2);
    expect(history.undo({ document: { id: "after" }, selection: null })?.document).toBe(beforeShapeOnlyCut);
  });

  it("starts a fresh group after undo even when the caller reuses a key", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);
    const before = { id: "before" };
    const after = { id: "after" };
    const replacement = { id: "replacement" };

    history.record({ document: before, selection: null }, { coalescingKey: "typing:1" });
    expect(history.undo({ document: after, selection: null })?.document).toBe(before);

    history.record({ document: before, selection: null }, { coalescingKey: "typing:1" });

    expect(history.undoDepth).toBe(1);
    expect(history.redoDepth).toBe(0);
    expect(history.undo({ document: replacement, selection: null })?.document).toBe(before);
  });

  it("keeps only the newest entries within its configured bound", () => {
    const history = new DocumentHistoryController<TestDocument, null>(2);
    const first = { id: "first" };
    const second = { id: "second" };
    const third = { id: "third" };
    const current = { id: "current" };

    history.record({ document: first, selection: null });
    history.record({ document: second, selection: null });
    history.record({ document: third, selection: null });

    expect(history.undoDepth).toBe(2);
    expect(history.undo({ document: current, selection: null })?.document).toBe(third);
    expect(history.undo({ document: third, selection: null })?.document).toBe(second);
    expect(history.undo({ document: second, selection: null })).toBeNull();
  });

  it("clears both stacks", () => {
    const history = new DocumentHistoryController<TestDocument, null>(10);
    history.record({ document: { id: "before" }, selection: null });
    history.undo({ document: { id: "after" }, selection: null });

    history.clear();

    expect(history.undoDepth).toBe(0);
    expect(history.redoDepth).toBe(0);
  });

  it("rejects an invalid history bound", () => {
    expect(() => new DocumentHistoryController<TestDocument, null>(0)).toThrow(RangeError);
    expect(() => new DocumentHistoryController<TestDocument, null>(1.5)).toThrow(RangeError);
  });
});
