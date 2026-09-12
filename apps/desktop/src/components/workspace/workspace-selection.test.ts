import { describe, expect, it } from "vitest";

import {
  computeRangeSelection,
  pruneSelectionToExistingKeys,
  resolveClickModifier,
  toggleSelectionKey,
  type WorkspaceSelectionRow,
} from "./workspace-selection";

function rows(...keys: string[]): WorkspaceSelectionRow[] {
  return keys.map((key) => ({ key }));
}

describe("resolveClickModifier", () => {
  it("resolves plain click with no modifiers", () => {
    expect(resolveClickModifier({})).toBe("plain");
  });

  it("resolves ctrlKey as toggle", () => {
    expect(resolveClickModifier({ ctrlKey: true })).toBe("toggle");
  });

  it("resolves metaKey as toggle", () => {
    expect(resolveClickModifier({ metaKey: true })).toBe("toggle");
  });

  it("resolves shiftKey as range", () => {
    expect(resolveClickModifier({ shiftKey: true })).toBe("range");
  });

  it("prioritizes shift over ctrl/meta when both are held", () => {
    expect(resolveClickModifier({ shiftKey: true, ctrlKey: true })).toBe("range");
    expect(resolveClickModifier({ shiftKey: true, metaKey: true })).toBe("range");
  });
});

describe("toggleSelectionKey", () => {
  it("adds a key that is not yet selected", () => {
    const next = toggleSelectionKey(new Set(), "file:a");
    expect(next).toEqual(new Set(["file:a"]));
  });

  it("removes a key that is already selected", () => {
    const next = toggleSelectionKey(new Set(["file:a", "file:b"]), "file:a");
    expect(next).toEqual(new Set(["file:b"]));
  });

  it("does not mutate the input set", () => {
    const original = new Set(["file:a"]);
    toggleSelectionKey(original, "file:b");
    expect(original).toEqual(new Set(["file:a"]));
  });
});

describe("computeRangeSelection", () => {
  it("selects the contiguous forward range between anchor and target", () => {
    const result = computeRangeSelection(rows("a", "b", "c", "d"), "a", "c");
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("selects the contiguous backward range between anchor and target", () => {
    const result = computeRangeSelection(rows("a", "b", "c", "d"), "c", "a");
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("returns a single-key set when anchor equals target", () => {
    const result = computeRangeSelection(rows("a", "b", "c"), "b", "b");
    expect(result).toEqual(new Set(["b"]));
  });

  it("falls back to selecting only the target when the anchor is missing", () => {
    const result = computeRangeSelection(rows("a", "b", "c"), "deleted", "b");
    expect(result).toEqual(new Set(["b"]));
  });

  it("falls back to selecting only the anchor when the target is missing", () => {
    const result = computeRangeSelection(rows("a", "b", "c"), "a", "deleted");
    expect(result).toEqual(new Set(["a"]));
  });

  it("returns an empty set when neither key is present", () => {
    const result = computeRangeSelection(rows("a", "b", "c"), "missing-1", "missing-2");
    expect(result).toEqual(new Set());
  });
});

describe("pruneSelectionToExistingKeys", () => {
  it("returns the same reference when nothing is removed", () => {
    const selected = new Set(["a", "b"]);
    const result = pruneSelectionToExistingKeys(selected, new Set(["a", "b", "c"]));
    expect(result).toBe(selected);
  });

  it("removes keys that are no longer present", () => {
    const selected = new Set(["a", "b", "c"]);
    const result = pruneSelectionToExistingKeys(selected, new Set(["a", "c"]));
    expect(result).toEqual(new Set(["a", "c"]));
  });

  it("prunes down to an empty set when nothing survives", () => {
    const selected = new Set(["a", "b"]);
    const result = pruneSelectionToExistingKeys(selected, new Set(["z"]));
    expect(result).toEqual(new Set());
  });

  it("is a no-op on an already-empty selection", () => {
    const selected = new Set<string>();
    const result = pruneSelectionToExistingKeys(selected, new Set(["a"]));
    expect(result).toBe(selected);
  });
});
