import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import type { MaterialItem } from "@/types/material";

import { filterSlashCommandCandidates, getSlashCommandCandidateName } from "./slash-command-model";

const japanese = createTranslator("ja", "editor");
const english = createTranslator("en", "editor");

function material(id: string, source: "user" | "official" = "user"): MaterialItem {
  return {
    version: 1, id, name: id, source,
    content: { blocks: [], overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  };
}

describe("slash command candidates", () => {
  it("ranks the named quote command before a box matched through its alias", () => {
    const candidates = filterSlashCommandCandidates([], "引用", true, japanese, undefined, false, ["insert.quote"]);

    expect(candidates[0]).toMatchObject({ kind: "block", block: { id: "insert.quote" } });
    expect(candidates.some((candidate) => candidate.kind === "box")).toBe(true);
    expect(getSlashCommandCandidateName(candidates[0])).toBe("/引用");
  });

  it("resolves each locale afresh while keeping the command identity stable", () => {
    const ja = filterSlashCommandCandidates([], "", false, japanese, undefined, false, ["insert.quote"]);
    const en = filterSlashCommandCandidates([], "", false, english, undefined, false, ["insert.quote"]);

    expect(ja[0]).toMatchObject({ kind: "block", block: { id: "insert.quote", commandName: "引用" } });
    expect(en[0]).toMatchObject({ kind: "block", block: { id: "insert.quote", commandName: "quote" } });
    expect(filterSlashCommandCandidates([], "ｑｕｏｔｅ", false, english, undefined, false, ["insert.quote"]))
      .toEqual(en);
  });

  it("offers only the box styles and block kinds allowed by the current surface", () => {
    const candidates = filterSlashCommandCandidates([], "", true, english, ["itembox"], false, ["insert.divider"]);

    expect(candidates).toMatchObject([
      { kind: "block", block: { id: "insert.divider" } },
      { kind: "box", box: { id: "itembox" } },
    ]);
    expect(filterSlashCommandCandidates([], "", false, english, ["itembox"])).toEqual([]);
  });

  it("keeps user materials first, preserving their order and the eight-material limit", () => {
    const userMaterials = Array.from({ length: 9 }, (_, index) => material(`user-${index}`));
    const candidates = filterSlashCommandCandidates([
      material("official", "official"), ...userMaterials,
    ], "", false, english);

    expect(candidates).toEqual(userMaterials.slice(0, 8).map((item) => ({ kind: "material", material: item })));
  });

  it("limits the combined list after commands, leaving the remaining slots for materials", () => {
    const materials = Array.from({ length: 8 }, (_, index) => material(`user-${index}`));
    const candidates = filterSlashCommandCandidates(
      materials, "", true, english, ["itembox"], true,
      ["insert.divider", "insert.codeBlock", "insert.quote"], true,
    );

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "problem", "heading", "heading", "heading", "block", "block", "block", "box",
      "material", "material", "material", "material",
    ]);
    expect(candidates.slice(4, 7)).toMatchObject([
      { block: { id: "insert.quote" } },
      { block: { id: "insert.codeBlock" } },
      { block: { id: "insert.divider" } },
    ]);
    expect(candidates.at(-1)).toEqual({ kind: "material", material: materials[3] });
  });
});
