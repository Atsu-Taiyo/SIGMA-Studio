import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";
import {
  computeDocumentBlockHashes,
  hashSigmaNode,
} from "@/lib/sigma-doc-block-hash";
import type { LocalMcpEditProposal } from "../proposals/contracts";
import { hasSharedBinding } from "./local-bridge";
import { durableWrite } from "./journal";
import type {
  ReadPrecondition,
  SharedApproval,
} from "../../src/features/collaboration/model/approval";
import {
  PAGE_LAYOUT_TARGET,
  pageLayoutPrecondition,
} from "../../src/features/collaboration/model/approval";
import type { ObjectValue } from "../../src/features/collaboration/model/value";
import { acquireFileLock } from "../file-lock";

interface Observed {
  userData: string;
  fileId: string;
  hashes: Record<string, string>;
}
const scope = new AsyncLocalStorage<{ runId: string; documents: Observed[] }>();
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const readFile = (userData: string, fileId: string, runId: string): string =>
  path.join(
    userData,
    "collaboration-v1",
    "reads",
    `${digest(`${fileId}\0${runId}`)}.json`,
  );
async function readConditions(file: string): Promise<ReadPrecondition[]> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as ReadPrecondition[];
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  }
}
export function observeSharedRead(
  userData: string,
  fileId: string,
  document: SigmaDocument,
): void {
  scope.getStore()?.documents.push({
    userData,
    fileId,
    hashes: {
      ...computeDocumentBlockHashes(document),
      [PAGE_LAYOUT_TARGET]: hashSigmaNode(
        pageLayoutPrecondition(document as unknown as ObjectValue),
      ),
    },
  });
}
export async function withSharedReadScope<T>(
  runId: string | undefined,
  readOnly: boolean,
  callback: () => Promise<T>,
): Promise<T> {
  if (!runId || !readOnly) return callback();
  const context = { runId, documents: [] as Observed[] };
  return scope.run(context, async () => {
    const result = await callback();
    const ids = new Set<string>();
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 40 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, depth + 1));
        return;
      }
      const object = value as Record<string, unknown>;
      if (object.pageLayout && typeof object.pageLayout === "object")
        ids.add(PAGE_LAYOUT_TARGET);
      // Outline ids alone do not assert that the full paragraph was read.
      if (
        typeof object.id === "string" &&
        typeof object.type === "string" &&
        ("children" in object ||
          "props" in object ||
          "prompt" in object ||
          "tex" in object)
      )
        ids.add(object.id);
      if (object.type === "text" && typeof object.text === "string") {
        try {
          visit(JSON.parse(object.text), depth + 1);
        } catch {
          /* ordinary prose */
        }
      }
      Object.values(object).forEach((child) => visit(child, depth + 1));
    };
    visit(result);
    for (const document of context.documents) {
      const file = readFile(document.userData, document.fileId, runId);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const lock = await acquireFileLock(`${file}.lock`, {
        op: "shared-read-preconditions",
      });
      try {
        const previous = new Map(
          (await readConditions(file)).map((item) => [item.id, item]),
        );
        for (const id of ids)
          if (document.hashes[id])
            previous.set(id, { id, hash: document.hashes[id] });
        await durableWrite(file, JSON.stringify([...previous.values()]));
      } finally {
        await lock.release();
      }
    }
    return result;
  });
}
export function approvalFile(userData: string, proposalId: string): string {
  return path.join(
    userData,
    "collaboration-v1",
    "proposals",
    `${digest(proposalId)}.json`,
  );
}
export async function captureSharedProposal(
  userData: string,
  proposal: LocalMcpEditProposal,
  baseDocument?: SigmaDocument,
): Promise<void> {
  if (
    proposal.status !== "pending" ||
    !(await hasSharedBinding(userData, proposal.fileId))
  )
    return;
  const file = approvalFile(userData, proposal.proposalId);
  const draftHash = digest(JSON.stringify(proposal.draft));
  let previous: { draftHash: string; approval: SharedApproval } | undefined;
  try {
    previous = JSON.parse(await fs.readFile(file, "utf8")) as typeof previous;
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  if (previous?.draftHash === draftHash) return;
  const conditions = new Map<string, ReadPrecondition>();
  if (
    baseDocument &&
    proposal.draft.mutationOperations?.some((operation) =>
      ["updatePageLayout", "setDocumentColumns"].includes(operation.operation),
    )
  ) {
    conditions.set(PAGE_LAYOUT_TARGET, {
      id: PAGE_LAYOUT_TARGET,
      hash: hashSigmaNode(
        pageLayoutPrecondition(baseDocument as unknown as ObjectValue),
      ),
    });
  }
  if (proposal.runId)
    for (const item of await readConditions(
      readFile(userData, proposal.fileId, proposal.runId),
    ))
      conditions.set(item.id, item);
  for (const item of proposal.touchedBlocks ?? [])
    if (item.baseHash && !conditions.has(item.id))
      conditions.set(item.id, { id: item.id, hash: item.baseHash });
  for (const [id, hash] of Object.entries(
    proposal.requestSelection?.hashes ?? {},
  ))
    if (!conditions.has(id)) conditions.set(id, { id, hash });
  const approval: SharedApproval = {
    operationId: randomUUID(),
    draft: proposal.draft,
    preconditions: [...conditions.values()],
  };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await durableWrite(file, JSON.stringify({ draftHash, approval }));
}
export async function readSharedProposal(
  userData: string,
  proposalId: string,
): Promise<SharedApproval> {
  const value = JSON.parse(
    await fs.readFile(approvalFile(userData, proposalId), "utf8"),
  ) as { approval: SharedApproval };
  return value.approval;
}
