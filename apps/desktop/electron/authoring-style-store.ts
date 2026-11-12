import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { inlineNodesToPlainText, type InlineNode, type SigmaBlock, type SigmaDocument } from "@/features/document";
import type { AuthoringStyleProfile } from "@/lib/ai/authoring-style";
import { AuthoringStyleMemory, atomicStyleWrite } from "./authoring-style-memory";
import { summarizeAuthoringStyle } from "./authoring-style-summary";
import type { LocalDocumentMetadata } from "./local-sigma-doc-store";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import type { AiResourceContextItem, AiResourceRunContext } from "./ai-resource-store";
import { acquireFileLock } from "./file-lock";
import { logLedgerEvent } from "./ledger-log";
import type { LocalDocumentSavedEvent } from "./local-sigma-doc-store";

const MAX_EXAMPLES = 160;
const MAX_EXAMPLE_FILE_BYTES = 2_000_000;
const MAX_FRAGMENT_LENGTH = 1800;
const MAX_PROMPT_LENGTH = 9000;
const FLUSH_DELAY_MS = 750;

interface Fragment {
  area: string;
  text: string;
  format: string;
  context: string;
}

export interface StyleExample {
  workspaceId: string;
  fileId: string;
  blockId: string;
  title: string;
  revision: number;
  before: Fragment | null;
  after: Fragment | null;
}

// IDs and timestamps are not authoring preferences. Keep actual line breaks,
// TeX and inline formatting so a notation change survives this projection.
function fragments(document: SigmaDocument): Map<string, Fragment> {
  const result = new Map<string, Fragment>();
  function add(id: string, area: string, children: InlineNode[], context: string, align?: string) {
    const text = inlineNodesToPlainText(children);
    const format = JSON.stringify({ align, runs: children.map(node => node.type === "mathInline" ? { ...node, id: undefined } : node) });
    if (text.trim()) result.set(id, { area, text: format.length <= MAX_FRAGMENT_LENGTH ? text : "", format: format.length <= MAX_FRAGMENT_LENGTH ? format : "", context });
  }
  function walk(blocks: readonly SigmaBlock[], area: string, context: string) {
    for (const block of blocks) {
      switch (block.type) {
        case "problem": {
          const prompt = block.prompt.flatMap(b => "children" in b && Array.isArray(b.children)
            ? b.children.filter((n): n is InlineNode => n.type === "text" || n.type === "mathInline") : []);
          const problemContext = inlineNodesToPlainText(prompt).slice(0, 300);
          for (const name of ["lead", "prompt", "hints", "solution"] as const) walk(block[name], name, problemContext);
          break;
        }
        case "paragraph":
        case "heading": add(block.id, area, block.children, context, block.align); break;
        case "section": add(block.id, area, [{ type: "text", text: block.title }], context, block.align); break;
        case "boxBlock":
          if (block.title) add(`${block.id}:title`, area, block.title, context);
          walk(block.blocks, area, context);
          break;
        case "quote": walk(block.blocks, area, context); break;
        case "layoutSection": walk(block.children, area, context); break;
        case "list":
          for (const item of block.items) {
            add(item.id, area, item.children, context, item.align);
            walk(item.continuations ?? [], area, context);
            walk(item.nested ?? [], area, context);
          }
          break;
      }
    }
  }
  walk(document.content, "body", "");
  const structure = JSON.stringify(document.content.slice(0, 80).map(b => b.type === "problem"
    ? { type: b.type, areas: ["lead", "prompt", "hints", "solution"].filter(key => b[key as "lead"].length > 0) }
    : { type: b.type }));
  if (structure.length <= MAX_FRAGMENT_LENGTH) result.set("$structure", { area: "structure", text: structure, format: structure, context: "" });
  return result;
}

function same(a: Fragment | null | undefined, b: Fragment | null | undefined): boolean {
  return a?.area === b?.area && a?.format === b?.format;
}

/** Derived, bounded examples of manual edits. Never rewrites user skills or documents. */
export class LocalAuthoringStyleStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly memory: AuthoringStyleMemory;
  private pending: StyleExample[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, private readonly listFiles?: () => Promise<LocalDocumentMetadata[]>) {
    this.dataDir = path.join(userDataPath, "data");
    this.filePath = path.join(this.dataDir, "ai-authoring-style", "examples.json");
    this.memory = new AuthoringStyleMemory(path.dirname(this.filePath));
  }

  observe(event: LocalDocumentSavedEvent): void {
    // Approval (including auto-approval), restoration and shared materialization
    // provide no evidence of a manually chosen writing preference.
    if (event.file.sharing || event.file.sharingPending || event.origin === "ai" || event.origin === "restore-backup" || !event.previousDocument) return;
    const before = fragments(event.previousDocument);
    const after = fragments(event.document);
    for (const blockId of new Set([...before.keys(), ...after.keys()])) {
      const oldFragment = before.get(blockId) ?? null;
      const newFragment = after.get(blockId) ?? null;
      if (oldFragment?.format === "" || newFragment?.format === "") continue;
      if (same(oldFragment, newFragment)) continue;
      this.pending.push({
        workspaceId: event.file.workspaceId, fileId: event.file.fileId,
        title: event.file.title, blockId, revision: event.file.revision,
        before: oldFragment, after: newFragment,
      });
    }
    this.pending = this.pending.slice(-MAX_EXAMPLES);
    if (!this.pending.length || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending.splice(0);
    if (pending.length) {
      this.queue = this.queue.then(() => this.withLock(async () => {
        if (!await this.memory.enabled(null)) return;
        let examples = await this.eligible(await this.read(), false);
        for (const edit of await this.eligible(pending)) {
          const index = examples.findIndex(e => e.workspaceId === edit.workspaceId && e.fileId === edit.fileId && e.blockId === edit.blockId);
          const previous = index < 0 ? undefined : examples[index];
          if (previous && previous.revision >= edit.revision) continue;
          if (index >= 0) examples.splice(index, 1);
          // Collapse successive autosaves, retaining the original before-state.
          const merged = previous && same(previous.after, edit.before) ? { ...edit, before: previous.before } : edit;
          if (!same(merged.before, merged.after)) examples.push(merged);
          examples = examples.slice(-MAX_EXAMPLES);
        }
        examples = await this.persist(examples);
        await this.updateMemories(await this.eligible(examples));
      })).catch(error => {
        logLedgerEvent(this.dataDir, "authoring-style-write-failed", { error: String(error) });
      });
    }
    await this.queue;
  }

  async augmentRunContext(context: AiResourceRunContext, input: {
    workspaceId: string | null; fileId: string; locale: AppLocale; visibleFileIds: ReadonlySet<string>;
  }): Promise<AiResourceRunContext> {
    try { return await this.buildRunContext(context, input); }
    catch (error) {
      logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      return context;
    }
  }

  private async buildRunContext(context: AiResourceRunContext, input: {
    workspaceId: string | null;
    fileId: string;
    locale: AppLocale;
    visibleFileIds: ReadonlySet<string>;
  }): Promise<AiResourceRunContext> {
    await this.flush();
    if (!input.workspaceId || !input.visibleFileIds.has(input.fileId)) return context;
    if (!await this.memory.enabled(null) || !await this.memory.enabled(input.workspaceId)) return context;
    const eligible = await this.eligible(await this.read());
    const examples = eligible.filter(e => e.workspaceId === input.workspaceId && input.visibleFileIds.has(e.fileId));
    const selected = this.selectExamples(eligible, input.fileId, input.workspaceId);
    const representedScopes = new Set(selected.map(e => e.workspaceId));
    const allScopesRepresented = eligible.every(e => representedScopes.has(e.workspaceId));
    const profiles = [await this.getProfile(null), await this.getProfile(input.workspaceId)];
    const memory = profiles.map(p => ({ scope: p.workspaceId === null ? "user" : "workspace", workspaceId: p.workspaceId, manual: this.promptText(p.userContent), learned: this.promptText(p.generatedContent), evidenceRevision: p.evidenceRevision, needsSynthesis: p.needsSynthesis && (p.workspaceId === null ? allScopesRepresented : representedScopes.has(p.workspaceId)) }));
    examples.reverse();
    examples.sort((a, b) => Number(b.fileId === input.fileId) - Number(a.fileId === input.fileId));
    const references = [...new Map(examples.map(e => [e.fileId, { fileId: e.fileId, title: e.title.slice(0, 100), ...(e.blockId !== "$structure" ? { blockId: e.blockId } : {}) }])).values()].slice(0, 8);
    while (JSON.stringify(references).length > 1400) references.pop();
    if (!selected.length && !profiles.some(p => p.userContent || p.generatedContent)) return context;
    const t = createTranslator(input.locale, "prompt");
    const resource: AiResourceContextItem = {
      id: "automatic-authoring-style", kind: "skill", loadMode: "always",
      title: t("authoringStyle.title"), description: t("authoringStyle.description"), tags: [],
      content: `${t("authoringStyle.guidance")}\n${JSON.stringify(selected)}`,
    };
    const notes: AiResourceContextItem = {
      id: "authoring-style-memory", kind: "skill", loadMode: "always",
      title: t("authoringStyle.memoryTitle"), description: "", tags: [],
      content: `${t("authoringStyle.memoryGuidance")}\n${JSON.stringify({ memory, references, evidenceCoverage: { sampledExamples: selected.length, totalExamples: eligible.length, representedWorkspaces: representedScopes.size, totalWorkspaces: new Set(eligible.map(e => e.workspaceId)).size } })}`,
    };
    while (notes.content!.length > 11_900 && references.length) {
      references.pop();
      notes.content = `${t("authoringStyle.memoryGuidance")}\n${JSON.stringify({ memory, references })}`;
    }
    return { ...context, always: [...context.always, ...(selected.length ? [resource] : []), notes] };
  }

  private selectExamples(examples: readonly StyleExample[], fileId: string, workspaceId: string): StyleExample[] {
    const recent = [...examples].reverse().sort((a, b) =>
      Number(b.fileId === fileId) - Number(a.fileId === fileId) || Number(b.workspaceId === workspaceId) - Number(a.workspaceId === workspaceId));
    // Include a representative from each scope before filling with recent edits.
    const representatives = [...new Map(recent.map(e => e.workspaceId).map(id => [id, recent.find(e => e.workspaceId === id)!])).values()];
    const selected: StyleExample[] = [];
    const seen = new Set<string>();
    let length = 2;
    for (const example of [...representatives, ...recent]) {
      const fingerprint = createHash("sha256").update(JSON.stringify([example.workspaceId, example.before, example.after])).digest("hex");
      if (seen.has(fingerprint)) continue;
      const size = JSON.stringify(example).length + (selected.length ? 1 : 0);
      if (length + size > MAX_PROMPT_LENGTH) continue;
      selected.push(example); seen.add(fingerprint); length += size;
      if (selected.length === 8) break;
    }
    return selected;
  }

  private promptText(text: string): string {
    // Bound the encoded JSON too (control characters and escaping can expand it).
    while (JSON.stringify(text).length > 2200) text = text.slice(0, Math.floor(text.length * 0.9));
    return text;
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lock = await acquireFileLock(path.join(this.dataDir, "locks", "authoring-style.lock"), { op: "authoring-style" });
    try { return await run(); } finally { await lock.release(); }
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.withLock(run));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async eligible(examples: StyleExample[], respectEnabled = true): Promise<StyleExample[]> {
    const files = this.listFiles ? new Map((await this.listFiles()).filter(f => !f.sharing && !f.sharingPending).map(f => [f.fileId, f])) : null;
    const enabled = new Map<string, boolean>();
    for (const e of examples) if (!enabled.has(e.workspaceId)) enabled.set(e.workspaceId, !respectEnabled || await this.memory.enabled(e.workspaceId));
    return examples.filter(e => enabled.get(e.workspaceId) && (!files || files.get(e.fileId)?.workspaceId === e.workspaceId));
  }

  private async persist(examples: StyleExample[]): Promise<StyleExample[]> {
    const bounded: StyleExample[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ version: 1, examples: [] }));
    for (const example of examples.slice(-MAX_EXAMPLES).reverse()) {
      const size = Buffer.byteLength(JSON.stringify(example)) + (bounded.length ? 1 : 0);
      if (bytes + size > MAX_EXAMPLE_FILE_BYTES) continue;
      bounded.unshift(example);
      bytes += size;
    }
    await atomicStyleWrite(this.filePath, JSON.stringify({ version: 1, examples: bounded }));
    return bounded;
  }

  private async updateMemories(examples: StyleExample[], extraScope?: string | null): Promise<void> {
    await this.memory.update(null, summarizeAuthoringStyle(examples), this.evidenceRevision(examples));
    const scopes = new Set(examples.map(e => e.workspaceId));
    if (extraScope && await this.memory.enabled(extraScope)) scopes.add(extraScope);
    for (const id of scopes) {
      const scoped = examples.filter(e => e.workspaceId === id);
      await this.memory.update(id, summarizeAuthoringStyle(scoped), this.evidenceRevision(scoped));
    }
  }

  async getProfile(workspaceId: string | null): Promise<AuthoringStyleProfile> {
    await this.flush();
    // Refresh against current library membership. Deleted/shared/moved evidence is not reused.
    return this.exclusive(async () => {
      const examples = await this.eligible(await this.read());
      if (await this.memory.enabled(null)) await this.updateMemories(examples, workspaceId);
      return this.memory.read(workspaceId, examples.filter(e => workspaceId === null || e.workspaceId === workspaceId).length);
    });
  }

  private evidenceRevision(examples: readonly StyleExample[]): string {
    return createHash("sha256").update(JSON.stringify(examples)).digest("hex");
  }

  async synthesize(input: { fileId: string; scope: "user" | "workspace"; summary: string; evidenceRevision: string }): Promise<void> {
    await this.flush();
    await this.exclusive(async () => {
      const file = (await this.listFiles?.())?.find(f => f.fileId === input.fileId && !f.sharing && !f.sharingPending);
      if (!file || !await this.memory.enabled(null) || !await this.memory.enabled(file.workspaceId)) throw new Error("Authoring learning unavailable");
      const workspaceId = input.scope === "user" ? null : file.workspaceId;
      const eligible = await this.eligible(await this.read());
      const examples = eligible.filter(e => workspaceId === null || e.workspaceId === workspaceId);
      if (workspaceId === null) {
        const represented = new Set(this.selectExamples(eligible, file.fileId, file.workspaceId).map(e => e.workspaceId));
        if (eligible.some(e => !represented.has(e.workspaceId))) throw new Error("Insufficient global style evidence");
      }
      if (!examples.length || this.evidenceRevision(examples) !== input.evidenceRevision) throw new Error("Style evidence changed");
      await this.memory.synthesize(workspaceId, input.summary, input.evidenceRevision);
    });
  }

  async saveProfile(input: { workspaceId: string | null; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile> {
    await this.flush();
    await this.exclusive(() => this.memory.save(input.workspaceId, input.content, input.expectedRevision));
    return this.getProfile(input.workspaceId);
  }

  async setEnabled(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile> {
    await this.flush();
    await this.exclusive(() => this.memory.setEnabled(workspaceId, enabled));
    return this.getProfile(workspaceId);
  }

  async reset(workspaceId: string | null): Promise<AuthoringStyleProfile> {
    await this.flush();
    await this.exclusive(async () => {
      const examples = await this.read();
      await this.persist(examples.filter(e => workspaceId !== null && e.workspaceId !== workspaceId));
      if (workspaceId === null) await this.memory.resetAllGenerated();
      else await this.memory.resetGenerated(workspaceId);
    });
    return this.getProfile(workspaceId);
  }

  private async read(): Promise<StyleExample[]> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_EXAMPLE_FILE_BYTES) throw new Error("Authoring style data exceeds the size limit");
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.examples)) throw new Error("Invalid authoring style data");
      return data.examples.filter((e: StyleExample) => typeof e?.workspaceId === "string" && typeof e.fileId === "string"
        && typeof e.blockId === "string" && e.blockId.length <= 256 && typeof e.title === "string" && e.title.length <= 1000 && Number.isSafeInteger(e.revision)
        && [e.before, e.after].every(f => f === null || (typeof f?.area === "string" && typeof f.text === "string" && f.text.length <= MAX_FRAGMENT_LENGTH
          && typeof f.format === "string" && f.format.length <= MAX_FRAGMENT_LENGTH && typeof f.context === "string" && f.context.length <= 300))).slice(-MAX_EXAMPLES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      }
      return [];
    }
  }
}
