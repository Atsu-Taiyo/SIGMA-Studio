import { describe, expect, it } from "vitest";
import type { LayoutSectionNode } from "@/features/document";
import { migrateLegacyLayoutColumns } from "./legacy-layout-columns";

function section(): LayoutSectionNode {
  return { type: "layoutSection", id: "legacy", layout: { columnCount: 2 }, children: ["a", "b", "c", "d"].map(id => ({ type: "paragraph", id, children: [] })) };
}

describe("legacy multicol import", () => {
  it("establishes explicit ownership once without changing the source", () => {
    const source = section();
    const migrated = migrateLegacyLayoutColumns(source);
    expect(migrated.layout.columnStartIds).toEqual(["a", "c"]);
    expect(source.layout.columnStartIds).toBeUndefined();
    expect(migrateLegacyLayoutColumns(migrated)).toBe(migrated);
  });
  it("carries a legacy manual boundary into independent ownership", () => {
    const source = section();
    source.children[1].pagination = { break: true };
    expect(migrateLegacyLayoutColumns(source).layout.columnStartIds).toEqual(["a", "b"]);
  });
  it("never redistributes existing ownership, including a stale start and a manual break", () => {
    const source = section();
    source.layout.columnStartIds = ["a", "deleted"];
    source.children[1].pagination = { break: true };
    expect(migrateLegacyLayoutColumns(source)).toBe(source);
  });
});
