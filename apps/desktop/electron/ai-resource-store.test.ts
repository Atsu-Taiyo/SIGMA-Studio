import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAppLocale } from "@/lib/i18n";

import {
  GLOBAL_INSTRUCTIONS_ID,
  LocalAiResourceStore,
  OFFICIAL_GRAPH_SKILL_ID,
  OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
} from "./ai-resource-store";

const IMAGE_SKILL_V1 = "---\nname: sigma-image-material-reconstruction\ndescription: image v1\n---\n\n# Image v1\n";
const IMAGE_SKILL_V2 = "---\nname: sigma-image-material-reconstruction\ndescription: image v2\n---\n\n# Image v2\n";
const GRAPH_SKILL_V1 = "---\nname: sigma-graph-editing\ndescription: graph v1\n---\n\n# Graph v1\n";
const HAND_EDITED_IMAGE_SKILL = "---\nname: sigma-image-material-reconstruction\ndescription: hand edited\n---\n\n# Hand edited\n";

function nonOfficialResourceIds(resources: Array<{ id: string; origin?: string }>): string[] {
  return resources.filter((resource) => resource.origin !== "official").map((resource) => resource.id);
}

describe("LocalAiResourceStore", () => {
  let userDataDir: string;
  let store: LocalAiResourceStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-resources-"));
    store = new LocalAiResourceStore(userDataDir);
  });

  afterEach(async () => {
    setAppLocale("ja");
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("creates the global instruction entry with an EMPTY user-editable seed and no projection", async () => {
    await store.syncToRuntimeTargets();

    const tree = await store.getTree();
    expect(nonOfficialResourceIds(tree.resources)).toEqual([GLOBAL_INSTRUCTIONS_ID]);
    expect(tree.resources.find((resource) => resource.id === GLOBAL_INSTRUCTIONS_ID)?.workspaceId).toBeUndefined();
    // ユーザー編集欄は空でseed(内部デフォルト文をユーザーに見せない)。基盤ルールは
    // 組み込みプロンプト(mcp-edit-prompt.ts側)で届くため、空の間は投影ファイルも作られない。
    await expect(fs.readFile(path.join(userDataDir, "data", "ai-agent-config", "instructions", "global.md"), "utf8"))
      .resolves.toBe("");
    await expect(fs.access(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(userDataDir, "data", "claude-agent-home", "CLAUDE.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(userDataDir, "data", "antigravity-agent-workspace", "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seeds both official skills as managed resources on a fresh install", async () => {
    const tree = await store.getTree();
    const officialSkills = tree.resources.filter((resource) => resource.origin === "official");

    expect(officialSkills).toEqual([
      expect.objectContaining({
        id: OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
        origin: "official",
        officialState: "managed",
      }),
      expect.objectContaining({
        id: OFFICIAL_GRAPH_SKILL_ID,
        origin: "official",
        officialState: "managed",
      }),
    ]);
    await Promise.all(officialSkills.map(async (resource) => {
      const file = await store.readFile(resource.id);
      expect(file.content.length).toBeGreaterThan(0);
    }));
  });

  it("keeps canonical manifest and prompt metadata stable across UI locale changes", async () => {
    setAppLocale("en");
    const englishTree = await store.getTree();
    const englishContext = await store.buildRunContext("codex", [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]);
    setAppLocale("ja");
    const japaneseTree = await store.getTree();
    const japaneseContext = await store.buildRunContext("codex", [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]);

    const selectCanonical = (resources: typeof englishTree.resources) => resources
      .filter((resource) => resource.id === GLOBAL_INSTRUCTIONS_ID || resource.id === OFFICIAL_IMAGE_MATERIAL_SKILL_ID)
      .map(({ id, title, description, tags, bundledTitle, bundledDescription }) => ({
        id, title, description, tags, bundledTitle, bundledDescription,
      }));
    expect(selectCanonical(englishTree.resources)).toEqual(selectCanonical(japaneseTree.resources));
    expect(englishContext).toEqual(japaneseContext);
    expect(englishContext.explicit[0]?.title).toBe("画像からSigma Studio教材を作成");
  });

  it("updates a managed official SKILL.md when its bundled content changes", async () => {
    const initialStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    const initial = await initialStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    const updatedStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V2,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    const updated = await updatedStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    expect(updated.content).toBe(IMAGE_SKILL_V2);
    expect(updated.resource.officialState).toBe("managed");
    expect(updated.resource.bundledHash).not.toBe(initial.resource.bundledHash);
  });

  it("preserves a user-edited official title across later reads and bundle updates", async () => {
    const initialStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
      officialSkillMetadataOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: {
          title: "公式タイトル v1",
          description: "公式説明 v1",
        },
      },
    });
    const initial = await initialStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);
    await initialStore.saveFile({
      resourceId: OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
      content: initial.content,
      patch: {
        title: "自分用の画像教材スキル",
        description: "自分用の説明",
      },
    });

    const reread = await initialStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);
    expect(reread.resource.title).toBe("自分用の画像教材スキル");
    expect(reread.resource.description).toBe("自分用の説明");

    const updatedStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V2,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
      officialSkillMetadataOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: {
          title: "公式タイトル v2",
          description: "公式説明 v2",
        },
      },
    });
    const updated = await updatedStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    expect(updated.resource.title).toBe("自分用の画像教材スキル");
    expect(updated.resource.description).toBe("自分用の説明");
    expect(updated.resource.bundledTitle).toBe("公式タイトル v1");
    expect(updated.resource.bundledDescription).toBe("公式説明 v1");
  });

  it("propagates a new bundled title while the official title is unchanged", async () => {
    const initialStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
      officialSkillMetadataOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: {
          title: "公式タイトル v1",
          description: "公式説明 v1",
        },
      },
    });
    const initial = await initialStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);
    expect(initial.resource.title).toBe("公式タイトル v1");
    expect(initial.resource.description).toBe("公式説明 v1");

    const updatedStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
      officialSkillMetadataOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: {
          title: "公式タイトル v2",
          description: "公式説明 v2",
        },
      },
    });
    const updated = await updatedStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    expect(updated.resource.title).toBe("公式タイトル v2");
    expect(updated.resource.description).toBe("公式説明 v2");
    expect(updated.resource.bundledTitle).toBe("公式タイトル v2");
    expect(updated.resource.bundledDescription).toBe("公式説明 v2");
  });

  it("serializes concurrent first reads while seeding official skills", async () => {
    const results = await Promise.all([
      store.getTree(),
      store.getTree(),
      store.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID),
      store.readFile(OFFICIAL_GRAPH_SKILL_ID),
    ]);

    expect(results[0].resources.filter((resource) => resource.origin === "official")).toHaveLength(2);
    expect(results[1].resources.filter((resource) => resource.origin === "official")).toHaveLength(2);
    const rawManifest = await fs.readFile(path.join(store.getSourceRoot(), "manifest.json"), "utf8");
    const parsedManifest = JSON.parse(rawManifest) as { resources: unknown[] };
    expect(parsedManifest.resources).toHaveLength(3);
  });

  it("preserves a hand-edited official SKILL.md and marks it as modified", async () => {
    const initialStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    const initial = await initialStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);
    await fs.writeFile(
      path.join(initialStore.getSourceRoot(), initial.resource.sourcePath),
      HAND_EDITED_IMAGE_SKILL,
      "utf8",
    );

    const updatedStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V2,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    const updated = await updatedStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    expect(updated.content).toBe(HAND_EDITED_IMAGE_SKILL);
    expect(updated.resource.officialState).toBe("modified");
    expect(updated.resource.bundledHash).toBe(initial.resource.bundledHash);
  });

  it("preserves enabled=false on an official skill across a bundle update", async () => {
    const initialStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V1,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    await initialStore.getTree();
    await initialStore.setResourceEnabled(OFFICIAL_IMAGE_MATERIAL_SKILL_ID, false);

    const updatedStore = new LocalAiResourceStore(userDataDir, {
      officialSkillContentOverrides: {
        [OFFICIAL_IMAGE_MATERIAL_SKILL_ID]: IMAGE_SKILL_V2,
        [OFFICIAL_GRAPH_SKILL_ID]: GRAPH_SKILL_V1,
      },
    });
    const updated = await updatedStore.readFile(OFFICIAL_IMAGE_MATERIAL_SKILL_ID);

    expect(updated.resource.enabled).toBe(false);
    expect(updated.resource.officialState).toBe("managed");
    expect(updated.content).toBe(IMAGE_SKILL_V2);
  });

  it("loads a legacy manifest without origin, bundledHash, or officialState fields", async () => {
    const sourceRoot = path.join(userDataDir, "data", "ai-agent-config");
    const legacySkillPath = path.join(sourceRoot, "skills", "legacy-skill", "SKILL.md");
    await fs.mkdir(path.dirname(legacySkillPath), { recursive: true });
    await fs.writeFile(legacySkillPath, "---\nname: legacy-skill\n---\n", "utf8");
    await fs.writeFile(path.join(sourceRoot, "manifest.json"), JSON.stringify({
      version: 1,
      resources: [{
        id: "skill-legacy-skill",
        kind: "skill",
        title: "legacy-skill",
        sourcePath: "skills/legacy-skill/SKILL.md",
        enabled: true,
        providers: ["codex", "claude"],
        loadMode: "auto",
        description: "legacy",
        tags: [],
        updatedAt: "legacy",
      }],
    }, null, 2), "utf8");

    const tree = await store.getTree();
    const legacy = tree.resources.find((resource) => resource.id === "skill-legacy-skill");

    expect(legacy).toMatchObject({ id: "skill-legacy-skill", title: "legacy-skill" });
    expect(legacy?.origin).toBeUndefined();
    expect(legacy?.bundledHash).toBeUndefined();
    expect(legacy?.officialState).toBeUndefined();
    expect(tree.resources.filter((resource) => resource.origin === "official").map((resource) => resource.id)).toEqual([
      OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
      OFFICIAL_GRAPH_SKILL_ID,
    ]);
  });

  it("rejects deleting official skills", async () => {
    await store.getTree();

    for (const resourceId of [OFFICIAL_IMAGE_MATERIAL_SKILL_ID, OFFICIAL_GRAPH_SKILL_ID]) {
      await expect(store.deleteResource(resourceId)).rejects.toThrow("公式スキルは削除できません");
      await expect(store.readFile(resourceId)).resolves.toMatchObject({
        resource: expect.objectContaining({ id: resourceId, origin: "official" }),
      });
    }
  });

  it("projects user-written global instructions and removes them again when disabled", async () => {
    await store.saveInstruction({ content: "# My Instructions\n" });
    await expect(fs.readFile(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("My Instructions");
    await expect(fs.readFile(path.join(userDataDir, "data", "claude-agent-home", "CLAUDE.md"), "utf8"))
      .resolves.toContain("My Instructions");
    await expect(fs.readFile(path.join(userDataDir, "data", "antigravity-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("My Instructions");

    await store.saveFile({
      resourceId: GLOBAL_INSTRUCTIONS_ID,
      content: "# Disabled\n",
      patch: { enabled: false },
    });

    await expect(fs.access(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(userDataDir, "data", "antigravity-agent-workspace", "AGENTS.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a skill and projects it to all three provider skill directories", async () => {
    const created = await store.createSkill({ name: "geometry-helper" });

    expect(created.resource.sourcePath).toBe("skills/geometry-helper/SKILL.md");
    expect(created.resource.providers).toEqual(["codex", "claude", "antigravity"]);
    expect(created.resource.description).toBe("geometry-helper");
    expect(created.resource.workspaceId).toBeUndefined();
    await store.syncToRuntimeTargets();
    await expect(fs.readFile(path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "geometry-helper", "SKILL.md"), "utf8"))
      .resolves.toContain("name: geometry-helper");
    await expect(fs.readFile(path.join(userDataDir, "data", "claude-agent-home", ".claude", "skills", "geometry-helper", "SKILL.md"), "utf8"))
      .resolves.toContain("name: geometry-helper");
    await expect(fs.readFile(path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "skills", "geometry-helper", "SKILL.md"), "utf8"))
      .resolves.toContain('description: "geometry-helper"');
  });

  it("auto-generates a unique name when createSkill is called without one", async () => {
    const first = await store.createSkill({});
    const second = await store.createSkill({});

    expect(first.resource.id).toBe("skill-skill");
    expect(second.resource.id).toBe("skill-skill-2");
  });

  it("preserves antigravity mcp_config.json while syncing AGENTS.md and skills", async () => {
    const mcpConfigPath = path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "mcp_config.json");
    await fs.mkdir(path.dirname(mcpConfigPath), { recursive: true });
    await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");

    await store.saveInstruction({ content: "# Shared instructions\n" });
    await store.createSkill({ name: "geometry-helper" });
    await store.syncToRuntimeTargets();

    await expect(fs.readFile(mcpConfigPath, "utf8")).resolves.toContain("mcpServers");
    await expect(fs.readFile(path.join(userDataDir, "data", "antigravity-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("Shared instructions");
  });

  it("builds the same always/explicit run context for all providers", async () => {
    // グローバル指示は空でseedされる(空の間はalwaysに乗らない)ため、内容を入れてから確認する。
    await store.saveInstruction({ content: "常に丁寧語で。" });
    const created = await store.createSkill({ name: "graph-helper" });

    for (const provider of ["codex", "claude", "antigravity"] as const) {
      const context = await store.buildRunContext(provider, [created.resource.id]);
      expect(context.always.map((item) => item.id)).toContain(GLOBAL_INSTRUCTIONS_ID);
      const explicitItem = context.explicit.find((item) => item.id === created.resource.id);
      expect(explicitItem?.content).toBeDefined();
    }
  });

  it("keeps the empty-seeded global instruction out of the run context", async () => {
    const context = await store.buildRunContext("codex", []);

    expect(context.always.some((item) => item.id === GLOBAL_INSTRUCTIONS_ID)).toBe(false);
  });

  it("does not auto-inject a skill's body just because it wasn't explicitly selected", async () => {
    // auto読み込み(instruction文言とのキーワード一致)は廃止した。ネイティブskill探索
    // (runtime projection)に委ねるため、明示選択されないskillはexplicit/alwaysどちらにも乗らない。
    await store.createSkill({ name: "graph-helper" });

    const context = await store.buildRunContext("codex", []);

    expect(context.explicit).toEqual([]);
    expect(context.always).toEqual([]);
  });

  it("scopes buildRunContext's always instructions to global plus the matching workspaceId only", async () => {
    await store.saveInstruction({ workspaceId: "ws_a", content: "ws a instructions" });
    await store.saveInstruction({ content: "global instructions" });

    const wsAContext = await store.buildRunContext("codex", [], "ws_a");
    expect(wsAContext.always.map((item) => item.id)).toContain("workspace-instructions:ws_a");
    expect(wsAContext.always.map((item) => item.id)).toContain(GLOBAL_INSTRUCTIONS_ID);

    const globalOnlyContext = await store.buildRunContext("codex", [], null);
    expect(globalOnlyContext.always.map((item) => item.id)).not.toContain("workspace-instructions:ws_a");
    expect(globalOnlyContext.always.map((item) => item.id)).toContain(GLOBAL_INSTRUCTIONS_ID);
  });

  it("performs a full write on the first sync (no prior manifest) and reports the change", async () => {
    const changed = await store.syncToRuntimeTargets();

    expect(changed).toBe(true);
    await expect(fs.access(path.join(userDataDir, "data", "ai-agent-config", ".sync-manifest.json")))
      .resolves.toBeUndefined();
  });

  it("skips rewriting a provider's runtime targets when nothing changed since the last sync", async () => {
    await store.saveInstruction({ content: "# base\n" });
    const agentsPath = path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md");
    const before = await fs.stat(agentsPath);
    // Sleep past filesystem mtime resolution so a rewrite (if it happened)
    // would be observable as a changed mtime.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await store.syncToRuntimeTargets();

    const after = await fs.stat(agentsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("projects an updated global instruction into both providers' runtime targets", async () => {
    await store.syncToRuntimeTargets();
    const claudePath = path.join(userDataDir, "data", "claude-agent-home", "CLAUDE.md");
    const codexPath = path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md");

    await store.saveFile({ resourceId: GLOBAL_INSTRUCTIONS_ID, content: "# Updated Instructions\n" });

    await expect(fs.readFile(claudePath, "utf8")).resolves.toContain("Updated Instructions");
    await expect(fs.readFile(codexPath, "utf8")).resolves.toContain("Updated Instructions");
  });

  it("only syncs the providers passed in options.providers", async () => {
    await store.saveFile({ resourceId: GLOBAL_INSTRUCTIONS_ID, content: "# v1\n" });
    // Hand-edit the source file without going through saveFile, so the
    // resource's manifest entry doesn't change but the on-disk content does.
    await fs.writeFile(path.join(userDataDir, "data", "ai-agent-config", "instructions", "global.md"), "# v2\n", "utf8");

    await store.syncToRuntimeTargets({ providers: ["codex"] });

    await expect(fs.readFile(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("v2");
    await expect(fs.readFile(path.join(userDataDir, "data", "claude-agent-home", "CLAUDE.md"), "utf8"))
      .resolves.toContain("v1");
  });

  it("detects a hand-edited source file (bypassing saveFile) via content hash, not just resource metadata", async () => {
    await store.syncToRuntimeTargets();
    await fs.writeFile(
      path.join(userDataDir, "data", "ai-agent-config", "instructions", "global.md"),
      "# Hand-edited directly on disk\n",
      "utf8",
    );

    await store.syncToRuntimeTargets();

    await expect(fs.readFile(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("Hand-edited directly on disk");
  });

  it("detects resource removal and cleans up the stale runtime target on the next sync", async () => {
    await store.createSkill({ name: "temp-skill" });
    await store.syncToRuntimeTargets();
    await expect(
      fs.access(path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "temp-skill", "SKILL.md")),
    ).resolves.toBeUndefined();

    await store.deleteResource("skill-temp-skill");

    await expect(
      fs.access(path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "temp-skill", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops projecting a disabled skill's runtime files on sync", async () => {
    const created = await store.createSkill({ name: "toggle-skill" });
    await store.syncToRuntimeTargets();
    await expect(fs.access(path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "toggle-skill", "SKILL.md")))
      .resolves.toBeUndefined();

    await store.setResourceEnabled(created.resource.id, false);

    await expect(fs.access(path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "toggle-skill", "SKILL.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops legacy hook/doc kinds and the retired codex-agents/claude-instructions ids on load", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push(
      { id: "hook-old", kind: "hook", title: "old hook", sourcePath: "hooks/old.md", enabled: true, providers: ["codex"], loadMode: "always", description: "", tags: [], updatedAt: "now" },
      { id: "doc-old", kind: "doc", title: "old doc", sourcePath: "docs/old.md", enabled: true, providers: ["codex"], loadMode: "manual", description: "", tags: [], updatedAt: "now" },
      { id: "codex-agents", kind: "instruction", title: "old codex", sourcePath: "instructions/AGENTS.md", enabled: true, providers: ["codex"], loadMode: "always", description: "", tags: [], updatedAt: "now" },
      { id: "claude-instructions", kind: "instruction", title: "old claude", sourcePath: "instructions/CLAUDE.md", enabled: true, providers: ["claude"], loadMode: "always", description: "", tags: [], updatedAt: "now" },
    );
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();

    expect(nonOfficialResourceIds(tree.resources)).toEqual([GLOBAL_INSTRUCTIONS_ID]);
  });

  it("restores the global instruction after upgrading a manifest that only has the retired ids", async () => {
    // 既存インストールのアップグレード直後を再現: manifest.json は存在するが、
    // 中身は旧ID(codex-agents/claude-instructions)だけで global-instructions が無い。
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({
      version: 1,
      resources: [
        { id: "codex-agents", kind: "instruction", title: "Codex / AGENTS.md", sourcePath: "instructions/AGENTS.md", enabled: true, providers: ["codex"], loadMode: "always", description: "", tags: [], updatedAt: "now" },
        { id: "claude-instructions", kind: "instruction", title: "Claude / CLAUDE.md", sourcePath: "instructions/CLAUDE.md", enabled: true, providers: ["claude"], loadMode: "always", description: "", tags: [], updatedAt: "now" },
      ],
    }, null, 2), "utf8");

    const tree = await store.getTree();
    expect(nonOfficialResourceIds(tree.resources)).toEqual([GLOBAL_INSTRUCTIONS_ID]);

    // 保存も成功する(以前は「AIリソースが見つかりません。」でthrowしていた回帰)。
    const saved = await store.saveInstruction({ workspaceId: null, content: "restored instructions" });
    expect(saved.resource.id).toBe(GLOBAL_INSTRUCTIONS_ID);
    await expect(fs.readFile(path.join(userDataDir, "data", "codex-agent-workspace", "AGENTS.md"), "utf8"))
      .resolves.toContain("restored instructions");
  });

  it("normalizeEntry preserves a skill's workspaceId (workspace-scoped skills are supported)", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push({
      id: "skill-ws-skill",
      kind: "skill",
      title: "ws-skill",
      sourcePath: "skills/workspaces/ws_1/ws-skill/SKILL.md",
      enabled: true,
      providers: ["codex", "claude", "antigravity"],
      loadMode: "auto",
      description: "",
      tags: [],
      workspaceId: "ws_1",
      updatedAt: "now",
    });
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();

    const skill = tree.resources.find((r) => r.id === "skill-ws-skill");
    expect(skill?.workspaceId).toBe("ws_1");
  });

  it("migrates the legacy shared Codex+Claude provider set to the unified three-provider interface", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push({
      id: "skill-legacy-shared",
      kind: "skill",
      title: "legacy-shared",
      sourcePath: "skills/legacy-shared/SKILL.md",
      enabled: true,
      providers: ["codex", "claude"],
      loadMode: "auto",
      description: "",
      tags: [],
      updatedAt: "now",
    });
    await fs.mkdir(path.join(userDataDir, "data", "ai-agent-config", "skills", "legacy-shared"), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "data", "ai-agent-config", "skills", "legacy-shared", "SKILL.md"),
      "---\nname: legacy-shared\ndescription: legacy\n---\n",
      "utf8",
    );
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();
    const migrated = tree.resources.find((resource) => resource.id === "skill-legacy-shared");
    expect(migrated?.providers).toEqual(["codex", "claude", "antigravity"]);
    expect(migrated?.description).toBe("legacy");
    const persisted = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    expect(persisted.resources.find((resource) => resource.id === "skill-legacy-shared")?.description).toBe("legacy");

    await store.syncToRuntimeTargets({ providers: ["antigravity"], workspaceIds: [null] });
    await expect(fs.readFile(
      path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "skills", "legacy-shared", "SKILL.md"),
      "utf8",
    )).resolves.toContain("name: legacy-shared");
  });

  it("preserves an intentional single-provider legacy skill restriction", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push({
      id: "skill-codex-only",
      kind: "skill",
      title: "codex-only",
      sourcePath: "skills/codex-only/SKILL.md",
      enabled: true,
      providers: ["codex"],
      loadMode: "auto",
      description: "Codex固有ツールを使う",
      tags: [],
      updatedAt: "now",
    });
    await fs.mkdir(path.join(userDataDir, "data", "ai-agent-config", "skills", "codex-only"), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "data", "ai-agent-config", "skills", "codex-only", "SKILL.md"),
      '---\nname: codex-only\ndescription: "Codex固有ツールを使う"\n---\n',
      "utf8",
    );
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();
    expect(tree.resources.find((resource) => resource.id === "skill-codex-only")?.providers).toEqual(["codex"]);

    await store.syncToRuntimeTargets({ providers: ["codex", "antigravity"], workspaceIds: [null] });
    await expect(fs.readFile(
      path.join(userDataDir, "data", "codex-agent-workspace", ".agents", "skills", "codex-only", "SKILL.md"),
      "utf8",
    )).resolves.toContain("name: codex-only");
    await expect(fs.access(
      path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "skills", "codex-only", "SKILL.md"),
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a legacy skill with an empty description before native projection", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push({
      id: "skill-empty-description",
      kind: "skill",
      title: "empty-description",
      sourcePath: "skills/empty-description/SKILL.md",
      enabled: true,
      providers: ["codex", "claude"],
      loadMode: "auto",
      description: "",
      tags: [],
      updatedAt: "now",
    });
    const sourcePath = path.join(userDataDir, "data", "ai-agent-config", "skills", "empty-description", "SKILL.md");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, '---\nname: empty-description\ndescription: ""\n---\n\nbody\n', "utf8");
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();
    expect(tree.resources.find((resource) => resource.id === "skill-empty-description")?.description)
      .toBe("empty-description");

    await store.syncToRuntimeTargets({ providers: ["antigravity"], workspaceIds: [null] });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain('description: "empty-description"');
    await expect(fs.readFile(
      path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "skills", "empty-description", "SKILL.md"),
      "utf8",
    )).resolves.toContain('description: "empty-description"');
  });

  it("preserves a valid folded block-scalar description during migration and projection", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    legacy.resources.push({
      id: "skill-folded-description",
      kind: "skill",
      title: "folded-description",
      sourcePath: "skills/folded-description/SKILL.md",
      enabled: true,
      providers: ["codex", "claude"],
      loadMode: "auto",
      description: "",
      tags: [],
      updatedAt: "now",
    });
    const sourcePath = path.join(userDataDir, "data", "ai-agent-config", "skills", "folded-description", "SKILL.md");
    const source = [
      "---",
      "name: folded-description",
      "description: >-",
      "  Generates graphs when the user asks",
      "  for coordinate-plane teaching material.",
      "---",
      "",
      "body",
    ].join("\n");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, source, "utf8");
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();
    expect(tree.resources.find((resource) => resource.id === "skill-folded-description")?.description)
      .toBe("Generates graphs when the user asks for coordinate-plane teaching material.");

    await store.syncToRuntimeTargets({ providers: ["antigravity"], workspaceIds: [null] });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readFile(
      path.join(userDataDir, "data", "antigravity-agent-workspace", ".agents", "skills", "folded-description", "SKILL.md"),
      "utf8",
    )).resolves.toBe(source);
  });

  it("createSkill with a workspaceId scopes the skill and projects it only into that workspace's agent-workspaces directories", async () => {
    const created = await store.createSkill({ name: "ws-only-skill", workspaceId: "ws_a" });

    expect(created.resource.sourcePath).toBe("skills/workspaces/ws_a/ws-only-skill/SKILL.md");
    expect(created.resource.workspaceId).toBe("ws_a");

    await store.syncToRuntimeTargets({ workspaceIds: [null, "ws_a", "ws_b"] });

    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_a", "claude", ".claude", "skills", "ws-only-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("name: ws-only-skill");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_a", "codex", ".agents", "skills", "ws-only-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("name: ws-only-skill");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_a", "antigravity", ".agents", "skills", "ws-only-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("name: ws-only-skill");

    // フォールバック(workspaceId未解決)と別ワークスペースには決して投影されない。
    await expect(fs.access(path.join(userDataDir, "data", "claude-agent-home", ".claude", "skills", "ws-only-skill")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(userDataDir, "data", "agent-workspaces", "ws_b", "claude", ".claude", "skills", "ws-only-skill")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("projects a global skill and global instruction into a workspace's agent-workspaces directory (union projection)", async () => {
    await store.saveInstruction({ content: "常に丁寧語で。" });
    await store.createSkill({ name: "global-union-skill" });

    await store.syncToRuntimeTargets({ workspaceIds: ["ws_union"] });

    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_union", "claude", "CLAUDE.md"), "utf8"))
      .resolves.toContain("常に丁寧語で。");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_union", "codex", "AGENTS.md"), "utf8"))
      .resolves.toContain("常に丁寧語で。");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_union", "antigravity", "AGENTS.md"), "utf8"))
      .resolves.toContain("常に丁寧語で。");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_union", "claude", ".claude", "skills", "global-union-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("name: global-union-skill");
    await expect(fs.readFile(path.join(userDataDir, "data", "agent-workspaces", "ws_union", "antigravity", ".agents", "skills", "global-union-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("name: global-union-skill");
  });

  it("enforces cross-scope-unique skill names (a workspace skill can't reuse a global skill's name)", async () => {
    await store.createSkill({ name: "shared-skill-name" });

    const wsSkill = await store.createSkill({ name: "shared-skill-name", workspaceId: "ws_x" });

    expect(wsSkill.resource.id).not.toBe("skill-shared-skill-name");
    expect(wsSkill.resource.title).toBe("shared-skill-name-2");
    expect(wsSkill.resource.sourcePath).toBe("skills/workspaces/ws_x/shared-skill-name-2/SKILL.md");
  });

  it("syncs each workspace fingerprint independently: an unrelated workspace's sync stays a no-op", async () => {
    await store.createSkill({ name: "fingerprint-skill", workspaceId: "ws_fp" });
    await store.syncToRuntimeTargets({ workspaceIds: [null, "ws_fp"] });
    const skillPath = path.join(userDataDir, "data", "agent-workspaces", "ws_fp", "codex", ".agents", "skills", "fingerprint-skill", "SKILL.md");
    const before = await fs.stat(skillPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 別ワークスペース宛のsyncを走らせても、ws_fp向けターゲットは再書き込みされない。
    await store.syncToRuntimeTargets({ workspaceIds: ["ws_unrelated"] });
    await store.syncToRuntimeTargets({ workspaceIds: [null, "ws_fp"] });

    const after = await fs.stat(skillPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("getAgentWorkspaceDir resolves the fallback root when workspaceId is null and the per-workspace directory otherwise", async () => {
    expect(store.getAgentWorkspaceDir("claude", null)).toBe(path.join(userDataDir, "data", "claude-agent-home"));
    expect(store.getAgentWorkspaceDir("codex", "ws_dir")).toBe(path.join(userDataDir, "data", "agent-workspaces", "ws_dir", "codex"));
    expect(store.getAgentWorkspaceDir("antigravity", "ws_dir")).toBe(path.join(userDataDir, "data", "agent-workspaces", "ws_dir", "antigravity"));
  });

  it("saveManagedResource creates a global skill (MCP is global-only)", async () => {
    const saved = await store.saveManagedResource({ kind: "skill", name: "shared-name", body: "global body" });

    expect(saved.resource.workspaceId).toBeUndefined();
    expect(saved.resource.id).toBe("skill-shared-name");
    expect(saved.resource.description).toBe("shared-name");
    expect(saved.content).toContain('description: "shared-name"');
    expect(saved.content).toContain("global body");
  });

  it("saveManagedResource rejects a name already taken by a workspace skill instead of silently touching it", async () => {
    await store.createSkill({ name: "ws-owned", workspaceId: "ws_1" });

    await expect(store.saveManagedResource({ kind: "skill", name: "ws-owned", body: "x" }))
      .rejects.toThrow("ワークスペーススキル");
  });

  it("deleteManagedResourceByName rejects a workspace skill (MCP is global-only)", async () => {
    await store.createSkill({ name: "ws-keep", workspaceId: "ws_1" });

    await expect(store.deleteManagedResourceByName("skill", "ws-keep")).rejects.toThrow("ワークスペーススキル");
    const tree = await store.getTree();
    expect(tree.resources.some((resource) => resource.id === "skill-ws-keep")).toBe(true);
  });

  it("saveManagedResource rejects workspace instruction ids", async () => {
    await store.saveInstruction({ workspaceId: "ws_1", content: "ws instructions" });

    await expect(store.saveManagedResource({ kind: "instruction", name: "workspace-instructions:ws_1", body: "x" }))
      .rejects.toThrow();
  });

  it("reports runtimeChanged only when runtime projections actually change", async () => {
    // skillの作成は3プロバイダ全てへ投影ファイルを書く → true。
    const globalSkill = await store.createSkill({ name: "rt-global" });
    expect(globalSkill.runtimeChanged).toBe(true);

    // ワークスペース指示の保存は投影ファイルに触れない(プロンプト注入のみ) → false。
    const wsInstruction = await store.saveInstruction({ workspaceId: "ws_1", content: "ws" });
    expect(wsInstruction.runtimeChanged).toBe(false);

    // 内容が変わらない保存も false。
    const globalFile = await store.readFile(globalSkill.resource.id);
    const noopSave = await store.saveFile({ resourceId: globalSkill.resource.id, content: globalFile.content });
    expect(noopSave.runtimeChanged).toBe(false);

    // skillの無効化は投影の削除を伴う → true。
    const toggled = await store.setResourceEnabled(globalSkill.resource.id, false);
    expect(toggled.runtimeChanged).toBe(true);
  });

  it("parses an old manifest that predates the workspaceId field", async () => {
    await store.syncToRuntimeTargets();
    const manifestPath = path.join(userDataDir, "data", "ai-agent-config", "manifest.json");
    const legacy = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { resources: Array<Record<string, unknown>> };
    for (const resource of legacy.resources) {
      delete resource.workspaceId;
      delete resource.scope;
    }
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), "utf8");

    const tree = await store.getTree();

    expect(tree.resources.length).toBeGreaterThan(0);
    expect(tree.resources.every((resource) => resource.workspaceId === undefined)).toBe(true);
  });

  it("saveInstruction creates a workspace instruction lazily on first save and updates it after that", async () => {
    const created = await store.saveInstruction({ workspaceId: "ws_1", content: "first" });
    expect(created.resource.id).toBe("workspace-instructions:ws_1");
    expect(created.resource.workspaceId).toBe("ws_1");
    expect(created.content).toBe("first");

    const updated = await store.saveInstruction({ workspaceId: "ws_1", content: "second" });
    expect(updated.resource.id).toBe(created.resource.id);
    expect(updated.content).toBe("second");

    const tree = await store.getTree();
    expect(tree.resources.filter((r) => r.id === "workspace-instructions:ws_1")).toHaveLength(1);
  });

  it("saveInstruction with no workspaceId updates the always-existing global instruction", async () => {
    const saved = await store.saveInstruction({ content: "new global instructions" });

    expect(saved.resource.id).toBe(GLOBAL_INSTRUCTIONS_ID);
    expect(saved.content).toBe("new global instructions");
  });

  it("saveManagedResource creates then updates a skill by name (MCP save_ai_resource path)", async () => {
    const createdSkill = await store.saveManagedResource({ kind: "skill", name: "mcp-skill", body: "# first\n" });
    expect(createdSkill.resource.kind).toBe("skill");
    expect(createdSkill.resource.providers).toEqual(["codex", "claude", "antigravity"]);
    expect(createdSkill.content).toContain("first");

    const updatedSkill = await store.saveManagedResource({ kind: "skill", name: "mcp-skill", body: "# second\n", enabled: false });
    expect(updatedSkill.resource.id).toBe(createdSkill.resource.id);
    expect(updatedSkill.resource.enabled).toBe(false);
    expect(updatedSkill.content).toContain("second");
  });

  it("saveManagedResource rejects an instruction name that isn't the existing global-instructions default", async () => {
    await expect(store.saveManagedResource({ kind: "instruction", name: "not-a-real-instruction", body: "x" }))
      .rejects.toThrow();
  });

  it("saveManagedResource updates the global instruction by its fixed id", async () => {
    const updated = await store.saveManagedResource({ kind: "instruction", name: GLOBAL_INSTRUCTIONS_ID, body: "updated global" });

    expect(updated.resource.id).toBe(GLOBAL_INSTRUCTIONS_ID);
    expect(updated.content).toBe("updated global");
  });

  it("deleteManagedResourceByName removes a skill by name and rejects instruction deletion", async () => {
    await store.saveManagedResource({ kind: "skill", name: "to-delete", body: "x" });

    await store.deleteManagedResourceByName("skill", "to-delete");

    const tree = await store.getTree();
    expect(tree.resources.some((resource) => resource.id === "skill-to-delete")).toBe(false);
    await expect(store.deleteManagedResourceByName("instruction", GLOBAL_INSTRUCTIONS_ID)).rejects.toThrow();
  });

  it("deleteManagedResourceByName fails for a name that doesn't exist", async () => {
    await expect(store.deleteManagedResourceByName("skill", "no-such-skill")).rejects.toThrow("AIリソースが見つかりません。");
  });
});
