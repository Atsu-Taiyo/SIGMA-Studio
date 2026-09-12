import { describe, expect, it } from "vitest";

import { pickContiguousSelectedSiblingIds } from "./block-ops";

describe("pickContiguousSelectedSiblingIds", () => {
  it("returns three consecutively selected siblings in DOM order", () => {
    expect(pickContiguousSelectedSiblingIds(
      ["first", "second", "third", "fourth"],
      ["third", "first", "second"],
      "second",
    )).toEqual(["first", "second", "third"]);
  });

  it("returns only the contiguous run containing the anchor for a sparse selection", () => {
    expect(pickContiguousSelectedSiblingIds(
      ["first", "second", "third", "fourth", "fifth"],
      ["first", "third", "fourth"],
      "third",
    )).toEqual(["third", "fourth"]);
  });

  it("falls back to the anchor when the anchor is not selected", () => {
    expect(pickContiguousSelectedSiblingIds(
      ["first", "second", "third"],
      ["first", "third"],
      "second",
    )).toEqual(["second"]);
  });

  it("falls back to the anchor when it is outside the sibling list", () => {
    expect(pickContiguousSelectedSiblingIds(
      ["first", "second", "third"],
      ["outside"],
      "outside",
    )).toEqual(["outside"]);
  });

  it("returns a single selected sibling", () => {
    expect(pickContiguousSelectedSiblingIds(
      ["first", "second", "third"],
      ["second"],
      "second",
    )).toEqual(["second"]);
  });
});
