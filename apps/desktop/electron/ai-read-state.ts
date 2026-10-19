import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeOverlaySnapshot, type OverlayShape, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { collectBlocksById, type EditableBlock } from "@/lib/document-tree";
import { atomicRename } from "./atomic-rename";
import { acquireFileLock } from "./file-lock";

/**
 * What the AI saw of a document during one run: the blocks and overlay shapes the MCP's read tools
 * returned to it, as they were when it read them (issue #249, MISS R24).
 *
 * A write tool runs on the current document. When the human changed a unit after the AI read it, the
 * AI's write (often a whole replacement written from what it read) is merged as "read → written" onto
 * the current unit instead of being refused or overwriting the human's edit: the units it read are the
 * base of that merge. The record is per run and per document; the latest read of a unit wins.
 *
 * Only the ids a read tool's result shows in full are recorded (an object with an `id`, a `type` and
 * content: `children`, `props`, `prompt` or `tex`; outline items alone are not). Their value is taken
 * from the document the tool loaded, never from the result (which may be summarized).
 */
export type ReadUnit =
  | { kind: "block"; value: EditableBlock }
  | { kind: "shape"; value: OverlayShape };

interface ObservedDocument {
  userData: string;
  fileId: string;
  document: SigmaDocument;
}

const scope = new AsyncLocalStorage<{ runId: string; documents: ObservedDocument[] }>();

/** The read state files of all runs live here (removed after `READ_STATE_TTL_MS`). */
export const READ_STATE_DIR_NAME = "ai-read-state";
/** A run's reads are only needed while it runs: older records are swept when a new one is written. */
const READ_STATE_TTL_MS = 24 * 60 * 60 * 1000;
/** A record larger than this is not extended (the write then falls back as if the unit was not read). */
const MAX_READ_STATE_BYTES = 16 * 1024 * 1024;

function readStateFile(userData: string, fileId: string, runId: string): string {
  const digest = createHash("sha256").update(`${fileId}\0${runId}`).digest("hex");
  return path.join(userData, READ_STATE_DIR_NAME, `${digest}.json`);
}

/** Called by the MCP store whenever a tool loads a document (local or shared). */
export function observeDocumentRead(userData: string, fileId: string, document: SigmaDocument): void {
  scope.getStore()?.documents.push({ userData, fileId, document });
}

/**
 * Runs a tool and, when it is a read-only tool of a run, records the units its result showed from the
 * documents it loaded. A failed record never fails the tool.
 */
export async function withDocumentReadScope<T>(
  runId: string | undefined,
  readOnly: boolean,
  callback: () => Promise<T>,
): Promise<T> {
  if (!runId || !readOnly) {
    return callback();
  }
  const context = { runId, documents: [] as ObservedDocument[] };
  return scope.run(context, async () => {
    const result = await callback();
    if (context.documents.length === 0) {
      return result;
    }
    const ids = collectShownIds(result);
    for (const observed of context.documents) {
      try {
        await recordReadUnits(observed, runId, unitsOf(observed.document, ids));
      } catch {
        // The record only lets a later write merge instead of asking the AI to re-read.
      }
    }
    return result;
  });
}

/** The units this run read of the document, by id (empty when none were recorded). */
export async function readRunReadState(
  userData: string,
  fileId: string,
  runId: string | undefined,
): Promise<Map<string, ReadUnit>> {
  if (!runId) {
    return new Map();
  }
  return new Map(Object.entries(await readRecord(readStateFile(userData, fileId, runId))));
}

/** Removes read records older than `READ_STATE_TTL_MS` (runs end within it). */
export async function sweepReadStates(userData: string, now = Date.now()): Promise<void> {
  const directory = path.join(userData, READ_STATE_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry);
    try {
      const stat = await fs.stat(file);
      if (now - stat.mtimeMs > READ_STATE_TTL_MS) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Another process removed it.
    }
  }));
}

function unitsOf(document: SigmaDocument, ids: ReadonlySet<string>): Record<string, ReadUnit> {
  const units: Record<string, ReadUnit> = {};
  if (ids.size === 0) {
    return units;
  }
  for (const [id, block] of collectBlocksById(document.content as SigmaBlock[])) {
    if (ids.has(id)) {
      units[id] = { kind: "block", value: structuredClone(block as EditableBlock) };
    }
  }
  for (const shape of normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes) {
    if (ids.has(shape.id) && !units[shape.id]) {
      units[shape.id] = { kind: "shape", value: structuredClone(shape) };
    }
  }
  return units;
}

async function recordReadUnits(observed: ObservedDocument, runId: string, units: Record<string, ReadUnit>): Promise<void> {
  if (Object.keys(units).length === 0) {
    return;
  }
  const file = readStateFile(observed.userData, observed.fileId, runId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = await acquireFileLock(`${file}.lock`, { op: "ai-read-state" });
  try {
    const next = { ...(await readRecord(file)), ...units };
    const bytes = JSON.stringify(next);
    if (bytes.length > MAX_READ_STATE_BYTES) {
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600 });
    await atomicRename(temporary, file);
  } finally {
    await lock.release();
  }
  void sweepReadStates(observed.userData);
}

async function readRecord(file: string): Promise<Record<string, ReadUnit>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([id, unit]) => (
      Boolean(unit)
      && typeof unit === "object"
      && ((unit as ReadUnit).kind === "block" || (unit as ReadUnit).kind === "shape")
      && typeof (unit as ReadUnit).value === "object"
      && (unit as ReadUnit).value !== null
      && ((unit as ReadUnit).value as { id?: unknown }).id === id
    ))) as Record<string, ReadUnit>;
  } catch {
    return {};
  }
}

/** Ids of the blocks and shapes a tool result shows in full (see the module comment). */
function collectShownIds(result: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 40 || !value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      typeof object.id === "string"
      && typeof object.type === "string"
      && ("children" in object || "props" in object || "prompt" in object || "tex" in object)
    ) {
      ids.add(object.id);
    }
    if (object.type === "text" && typeof object.text === "string") {
      try {
        visit(JSON.parse(object.text), depth + 1);
      } catch {
        // Ordinary prose.
      }
    }
    Object.values(object).forEach((child) => visit(child, depth + 1));
  };
  visit(result);
  return ids;
}
