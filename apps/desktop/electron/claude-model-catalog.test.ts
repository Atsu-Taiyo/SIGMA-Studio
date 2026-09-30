import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildClaudeModelOptions,
  claudeVersionAtLeast,
  parseClaudeModelCatalog,
  parseClaudeVersion,
  readClaudeModelCatalog,
} from "./claude-model-catalog";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalogFile(fetchedAt: number, models: unknown[]) {
  return { version: 2, fetchedAt, catalog: { surface: "cc", config: { id: "cc", models } } };
}

const SONNET = {
  id: "claude-sonnet-5-5",
  name: "Sonnet 5.5",
  short_name: "Sonnet",
  description: "Most efficient",
  section: "main",
  thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "medium", badge: { message: "Recommended" } }, { id: "max" }] },
};

describe("parseClaudeModelCatalog", () => {
  it("reads ids, names, families, sections and effort choices from Claude Code's cache", () => {
    const parsed = parseClaudeModelCatalog(catalogFile(5, [
      SONNET,
      { id: "claude-opus-5-5", name: "Opus 5.5", short_name: "Opus", section: "main", min_claude_code_version: "2.1.280", thinking: { type: "none" } },
    ]));

    expect(parsed?.fetchedAt).toBe(5);
    expect(parsed?.models[0]).toEqual({
      id: "claude-sonnet-5-5",
      name: "Sonnet 5.5",
      family: "Sonnet",
      description: "Most efficient",
      section: "main",
      efforts: ["low", "medium", "max"],
      defaultEffort: "medium",
    });
    expect(parsed?.models[1]).toMatchObject({ family: "Opus", minClaudeCodeVersion: "2.1.280", efforts: [] });
  });

  it("returns null for shapes it does not understand instead of guessing", () => {
    expect(parseClaudeModelCatalog(null)).toBeNull();
    expect(parseClaudeModelCatalog({ catalog: { config: { models: "nope" } } })).toBeNull();
    expect(parseClaudeModelCatalog(catalogFile(1, [{ id: "", name: "" }, 3]))).toBeNull();
  });
});

describe("readClaudeModelCatalog", () => {
  it("uses the most recently fetched account cache and skips unreadable files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-model-catalog-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "old.json"), JSON.stringify(catalogFile(1, [{ ...SONNET, id: "claude-sonnet-5", name: "Sonnet 5" }])));
    writeFileSync(path.join(dir, "new.json"), JSON.stringify(catalogFile(9, [SONNET])));
    writeFileSync(path.join(dir, "broken.json"), "{not json");
    writeFileSync(path.join(dir, "ignored.txt"), "x");

    await expect(readClaudeModelCatalog(dir)).resolves.toMatchObject({ fetchedAt: 9, models: [{ id: "claude-sonnet-5-5" }] });
  });

  it("returns null when the directory does not exist", async () => {
    await expect(readClaudeModelCatalog(path.join(tmpdir(), "definitely-missing-model-catalog"))).resolves.toBeNull();
  });
});

describe("buildClaudeModelOptions", () => {
  const context = { aliases: ["sonnet", "opus"], cliVersion: "2.1.285", latestAliasDescription: "latest", olderModelDescription: "older" };
  const models = parseClaudeModelCatalog(catalogFile(1, [
    SONNET,
    { id: "claude-opus-5-5", name: "Opus 5.5", short_name: "Opus", section: "main", min_claude_code_version: "2.1.280", thinking: { type: "none" } },
    { id: "claude-fable-9", name: "Fable 9", short_name: "Fable", section: "main", min_claude_code_version: "2.2.0", thinking: { type: "none" } },
    { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", short_name: "Haiku", section: "main", thinking: { type: "none" } },
    { id: "claude-sonnet-5", name: "Sonnet 5", short_name: "Sonnet", section: "overflow", thinking: { type: "none" } },
  ]))!.models;

  it("follows the latest model through the family alias and pins everything else by full id", () => {
    const options = buildClaudeModelOptions(models, context);

    expect(options.map((option) => [option.id, option.label])).toEqual([
      ["sonnet", "Claude Sonnet 5.5"],
      ["opus", "Claude Opus 5.5"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
      ["claude-sonnet-5", "Claude Sonnet 5"],
    ]);
    expect(options.find((option) => option.id === "sonnet")?.description).toBe("latest");
    expect(options.find((option) => option.id === "claude-sonnet-5")?.description).toBe("older");
  });

  it("trusts family aliases when --help could not be read", () => {
    const options = buildClaudeModelOptions(models, { ...context, aliases: [] });
    expect(options.map((option) => option.id)).toEqual(["sonnet", "opus", "haiku", "claude-sonnet-5"]);
  });

  it("hides models the installed Claude Code is too old to run, and picks Sonnet as the default", () => {
    const options = buildClaudeModelOptions(models, { ...context, cliVersion: "2.1.100" });

    expect(options.map((option) => option.id)).not.toContain("opus");
    expect(options.map((option) => option.id)).not.toContain("claude-fable-9");
    expect(options.filter((option) => option.isDefault).map((option) => option.id)).toEqual(["sonnet"]);
  });
});

describe("version helpers", () => {
  it("compares dotted versions and treats unknown versions as satisfied", () => {
    expect(claudeVersionAtLeast("2.1.285", "2.1.280")).toBe(true);
    expect(claudeVersionAtLeast("2.1.9", "2.1.10")).toBe(false);
    expect(claudeVersionAtLeast("3.0", "2.9.9")).toBe(true);
    expect(claudeVersionAtLeast(null, "2.1.280")).toBe(true);
    expect(claudeVersionAtLeast("2.1.1", undefined)).toBe(true);
  });

  it("extracts the version from `claude --version` output", () => {
    expect(parseClaudeVersion("2.1.285 (Claude Code)\n")).toBe("2.1.285");
    expect(parseClaudeVersion("no version")).toBeNull();
  });
});
