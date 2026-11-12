import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";
import { buildMcpEditPrompt } from "@/lib/ai/mcp-edit-prompt";
import type { AiResourceRunContext } from "./ai-resource-store";
import { LocalAuthoringStyleStore } from "./authoring-style-store";
import { LocalSigmaDocStore, type LocalDocumentSavedEvent } from "./local-sigma-doc-store";

function document(text: string): SigmaDocument {
  return { ...createBlankDocument("演習"), content: [{ id: "p1", type: "paragraph", children: [{ type: "text", text }] }] };
}

function event(before: SigmaDocument, after: SigmaDocument, revision = 2): LocalDocumentSavedEvent {
  return {
    origin: "user", previousDocument: before, document: after,
    file: { fileId: "f1", workspaceId: "ws1", folderId: null, title: "演習", docId: after.docId, revision, createdAt: "", updatedAt: "" },
  };
}

const context = (provider: AiResourceRunContext["provider"] = "codex"): AiResourceRunContext => ({ provider, always: [], explicit: [] });
const input = { workspaceId: "ws1", fileId: "f1", locale: "ja" as const, visibleFileIds: new Set(["f1"]) };

describe("automatic authoring style", () => {
  let root: string;
  let store: LocalAuthoringStyleStore;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-authoring-style-")); store = new LocalAuthoringStyleStore(root); });
  afterEach(async () => { await store.flush(); await fs.rm(root, { recursive: true, force: true }); });

  it("learns from the committed manual correction and supplies every provider on first and resumed turns after restart", async () => {
    const documents = new LocalSigmaDocStore(root, { onDocumentSaved: e => store.observe(e) });
    const workspace = await documents.initializeWorkspace({ initialDocument: document("値を求めなさい。") });
    const file = (await documents.listFiles()).find(f => f.fileId === workspace.activeFileId)!;
    const before = (await documents.loadDocument(file.fileId))!;
    const after = { ...before, content: document("値を求めよ。").content };
    expect((await documents.saveDocument(file.fileId, after, { expectedRevision: file.revision })).ok).toBe(true);
    await store.flush();
    const restarted = new LocalAuthoringStyleStore(root);
    for (const provider of ["codex", "claude", "antigravity"] as const) {
      const resources = await restarted.augmentRunContext(context(provider), { ...input, workspaceId: file.workspaceId, fileId: file.fileId, visibleFileIds: new Set([file.fileId]) });
      expect(resources.always).toHaveLength(1);
      for (const isResumedTurn of [false, true]) {
        const prompt = buildMcpEditPrompt({ provider, fileId: file.fileId, instruction: "次の問題を作って", locale: "ja", aiResources: resources, isResumedTurn });
        expect(prompt).toContain("値を求めなさい。");
        expect(prompt).toContain("値を求めよ。");
      }
    }
    expect((await documents.loadDocument(file.fileId))?.content).toEqual(after.content);
  });

  it("does not learn AI approval, backup restoration, timestamp changes or failed saves", async () => {
    const documents = new LocalSigmaDocStore(root, { onDocumentSaved: e => store.observe(e) });
    const workspace = await documents.initializeWorkspace({ initialDocument: document("元の文") });
    const file = (await documents.listFiles()).find(f => f.fileId === workspace.activeFileId)!;
    const before = (await documents.loadDocument(file.fileId))!;
    expect((await documents.saveDocument(file.fileId, { ...before, content: document("AIの文章").content }, { expectedRevision: file.revision, origin: "ai" })).ok).toBe(true);
    expect((await documents.saveDocument(file.fileId, document("失敗した編集"), { expectedRevision: file.revision })).ok).toBe(false);
    store.observe({ ...event(before, document("復元された文")), origin: "restore-backup" });
    store.observe(event(before, { ...before, updatedAt: "2026-10-25T00:00:00Z" }));
    expect((await store.augmentRunContext(context(), { ...input, workspaceId: file.workspaceId, visibleFileIds: new Set([file.fileId]) })).always).toEqual([]);
  });

  it("coalesces autosaves into one correction and removes an undone preference", async () => {
    store.observe(event(document("求めなさい。"), document("求めよ")));
    await store.flush();
    store.observe(event(document("求めよ"), document("求めよ。"), 3));
    const learned = await store.augmentRunContext(context(), input);
    const examples = JSON.parse(learned.always[0].content!.split("\n").slice(1).join("\n"));
    expect(examples).toHaveLength(1);
    expect(examples[0].before.text).toBe("求めなさい。");
    expect(examples[0].after.text).toBe("求めよ。");
    store.observe(event(document("求めよ。"), document("求めなさい。"), 4));
    expect((await store.augmentRunContext(context(), input)).always).toEqual([]);
  });

  it("retains TeX, formatting and the problem context of an added explanatory comment", async () => {
    const before = document("本文");
    before.content = [{ type: "problem", id: "problem", tags: [], lead: [], prompt: [{ type: "paragraph", id: "q", children: [{ type: "text", text: "不等式を解け。" }] }], solution: [], hints: [] }];
    const after = structuredClone(before);
    if (after.content[0].type !== "problem") throw new Error("fixture");
    after.content[0].hints = [{ type: "paragraph", id: "hint", children: [{ type: "text", text: "両辺の符号に注意。", marks: ["bold"] }, { type: "mathInline", id: "math", tex: "x \\geqq 0", display: "inline" }] }];
    store.observe(event(before, after));
    const resource = (await store.augmentRunContext(context(), { ...input, locale: "en" })).always[0];
    const examples = JSON.parse(resource.content!.split("\n").slice(1).join("\n"));
    expect(examples[0]).toMatchObject({ before: null, after: { area: "hints", context: "不等式を解け。" } });
    expect(examples[0].after.format).toContain("bold");
    expect(JSON.parse(examples[0].after.format).runs[1].tex).toBe("x \\geqq 0");
    expect(resource.title).toBe("Authoring style learned from everyday edits");
  });

  it("keeps user resources, scopes evidence to visible workspace documents, and omits oversized fragments", async () => {
    store.observe(event(document("元"), document("変更")));
    store.observe(event(document("短い文"), document("長".repeat(2000)), 3));
    const base = context();
    base.always.push({ id: "user", kind: "instruction", loadMode: "always", title: "user", description: "", tags: [], content: "ユーザーの指示" });
    expect((await store.augmentRunContext(base, { ...input, workspaceId: "ws2" })).always).toEqual(base.always);
    expect((await store.augmentRunContext(base, { ...input, visibleFileIds: new Set() })).always).toEqual(base.always);
    expect((await store.augmentRunContext(base, { ...input, workspaceId: null })).always).toEqual(base.always);
    const learned = await store.augmentRunContext(base, input);
    expect(learned.always).toHaveLength(2);
    expect(learned.always[0]).toEqual(base.always[0]);
    expect(base.always).toHaveLength(1);
    expect(learned.always[1].content).not.toContain("短い文");
  });

  it("does not turn a derived observer failure into a failed canonical save", async () => {
    const documents = new LocalSigmaDocStore(root, { onDocumentSaved: () => { throw new Error("derived failure"); } });
    const workspace = await documents.initializeWorkspace({ initialDocument: document("元の文") });
    const file = (await documents.listFiles()).find(f => f.fileId === workspace.activeFileId)!;
    const after = document("保存された文");
    const saved = await documents.saveDocument(file.fileId, after, { expectedRevision: file.revision });
    expect(saved.ok).toBe(true);
    expect((await documents.loadDocument(file.fileId))?.content).toEqual(after.content);
  });

  it("uses a user's correction of AI output, while ignoring shared synchronization", async () => {
    const documents = new LocalSigmaDocStore(root, { onDocumentSaved: e => store.observe(e) });
    const workspace = await documents.initializeWorkspace({ initialDocument: document("元の文") });
    const file = (await documents.listFiles()).find(f => f.fileId === workspace.activeFileId)!;
    await documents.saveDocument(file.fileId, document("AIの説明です。"), { expectedRevision: file.revision, origin: "ai" });
    await documents.saveDocument(file.fileId, document("ここで符号に注意する。"), { expectedRevision: file.revision + 1 });
    const learned = await store.augmentRunContext(context(), { ...input, workspaceId: file.workspaceId, fileId: file.fileId, visibleFileIds: new Set([file.fileId]) });
    expect(learned.always[0].content).toContain("AIの説明です。");
    expect(learned.always[0].content).toContain("ここで符号に注意する。");
    await documents.withLocalLibrary(() => documents.saveDocument(file.fileId, document("他の参加者の文章"), { expectedRevision: file.revision + 2 }));
    const afterSync = await store.augmentRunContext(context(), { ...input, workspaceId: file.workspaceId, visibleFileIds: new Set([file.fileId]) });
    expect(afterSync.always[0].content).not.toContain("他の参加者の文章");
  });

  it("bounds persisted and injected examples even when many documents are edited", async () => {
    for (let n = 0; n < 190; n++) {
      const edited = event(document(`変更前${n}`), document(`変更後${n}`));
      edited.file.fileId = `file${n}`;
      store.observe(edited);
    }
    await store.flush();
    const data = JSON.parse(await fs.readFile(path.join(root, "data/ai-authoring-style/examples.json"), "utf8"));
    expect(data.examples).toHaveLength(160);
    const learned = await store.augmentRunContext(context(), { ...input, fileId: "file189", visibleFileIds: new Set(data.examples.map((e: { fileId: string }) => e.fileId)) });
    const examples = JSON.parse(learned.always[0].content!.split("\n").slice(1).join("\n"));
    expect(examples).toHaveLength(8);
    expect(JSON.stringify(examples).length).toBeLessThanOrEqual(9000);
    expect(examples[0].fileId).toBe("file189");
  });

  it("keeps the AI usable with a damaged derived profile and records the failure", async () => {
    await fs.mkdir(path.join(root, "data/ai-authoring-style"), { recursive: true });
    await fs.writeFile(path.join(root, "data/ai-authoring-style/examples.json"), "{broken");
    expect((await store.augmentRunContext(context(), input)).always).toEqual([]);
    expect(await fs.readFile(path.join(root, "data/logs/ledger.log"), "utf8")).toContain("authoring-style-read-failed");
  });
});
