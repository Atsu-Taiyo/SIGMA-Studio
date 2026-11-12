import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { inlineNodesToPlainText, type InlineNode, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import type { AiResourceContextItem, AiResourceRunContext } from "./ai-resource-store";
import { logLedgerEvent } from "./ledger-log";
import type { LocalDocumentSavedEvent } from "./local-sigma-doc-store";

const MAX_EXAMPLES = 160;
const MAX_FRAGMENT_LENGTH = 1800;
const MAX_PROMPT_LENGTH = 9000;
const FLUSH_DELAY_MS = 750;

interface Fragment {
  area: string;
  text: string;
  format: string;
  context: string;
}

interface StyleExample {
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
  return result;
}

function same(a: Fragment | null | undefined, b: Fragment | null | undefined): boolean {
  return a?.area === b?.area && a?.format === b?.format;
}

/** Derived, bounded examples of manual edits. Never rewrites user skills or documents. */
export class LocalAuthoringStyleStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private pending: StyleExample[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.dataDir = path.join(userDataPath, "data");
    this.filePath = path.join(this.dataDir, "ai-authoring-style", "examples.json");
  }

  observe(event: LocalDocumentSavedEvent): void {
    // Approval (including auto-approval), restoration and shared materialization
    // provide no evidence of a manually chosen writing preference.
    if (event.origin === "ai" || event.origin === "restore-backup" || !event.previousDocument) return;
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
      this.queue = this.queue.then(async () => {
        let examples = await this.read();
        for (const edit of pending) {
          const index = examples.findIndex(e => e.workspaceId === edit.workspaceId && e.fileId === edit.fileId && e.blockId === edit.blockId);
          const previous = index < 0 ? undefined : examples[index];
          if (previous && previous.revision >= edit.revision) continue;
          if (index >= 0) examples.splice(index, 1);
          // Collapse successive autosaves, retaining the original before-state.
          const merged = previous && same(previous.after, edit.before) ? { ...edit, before: previous.before } : edit;
          if (!same(merged.before, merged.after)) examples.push(merged);
          examples = examples.slice(-MAX_EXAMPLES);
        }
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, examples }), "utf8");
          await fs.rename(temporary, this.filePath);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }).catch(error => {
        logLedgerEvent(this.dataDir, "authoring-style-write-failed", { error: String(error) });
      });
    }
    await this.queue;
  }

  async augmentRunContext(context: AiResourceRunContext, input: {
    workspaceId: string | null;
    fileId: string;
    locale: AppLocale;
    visibleFileIds: ReadonlySet<string>;
  }): Promise<AiResourceRunContext> {
    await this.flush();
    if (!input.workspaceId) return context;
    const examples = (await this.read()).filter(e => e.workspaceId === input.workspaceId && input.visibleFileIds.has(e.fileId));
    // Recent corrections in this file come first; independent examples provide
    // context, without treating repeated autosaves as repeated endorsements.
    examples.reverse();
    examples.sort((a, b) => Number(b.fileId === input.fileId) - Number(a.fileId === input.fileId));
    const seen = new Set<string>();
    const selected: StyleExample[] = [];
    let length = 2; // JSON array brackets.
    for (const example of examples) {
      const fingerprint = createHash("sha256").update(JSON.stringify([example.before, example.after])).digest("hex");
      if (seen.has(fingerprint)) continue;
      const size = JSON.stringify(example).length + (selected.length ? 1 : 0);
      if (length + size > MAX_PROMPT_LENGTH) continue;
      seen.add(fingerprint);
      selected.push(example);
      length += size;
      if (selected.length === 8) break;
    }
    if (!selected.length) return context;
    const t = createTranslator(input.locale, "prompt");
    const resource: AiResourceContextItem = {
      id: "automatic-authoring-style", kind: "skill", loadMode: "always",
      title: t("authoringStyle.title"), description: t("authoringStyle.description"), tags: [],
      content: `${t("authoringStyle.guidance")}\n${JSON.stringify(selected)}`,
    };
    return { ...context, always: [...context.always, resource] };
  }

  private async read(): Promise<StyleExample[]> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > 2_000_000) throw new Error("Authoring style data exceeds the size limit");
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.examples)) throw new Error("Invalid authoring style data");
      return data.examples.filter((e: StyleExample) => typeof e?.workspaceId === "string" && typeof e.fileId === "string"
        && typeof e.blockId === "string" && typeof e.title === "string" && Number.isSafeInteger(e.revision)
        && [e.before, e.after].every(f => f === null || (typeof f?.area === "string" && typeof f.text === "string"
          && typeof f.format === "string" && f.format.length <= MAX_FRAGMENT_LENGTH && typeof f.context === "string"))).slice(-MAX_EXAMPLES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      }
      return [];
    }
  }
}
