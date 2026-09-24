import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SigmaDocument } from "@/features/document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { durableWrite } from "./journal";
import type { LocalSigmaDocStore, LibraryAuthority } from "../local-sigma-doc-store";
import type { CollaborationSessions } from "./sessions";

interface Descriptor {
  version: 1;
  port: number;
  token: string;
  pid: number;
}
/** Narrow authenticated loopback bridge. No caller-controlled URLs, paths or commands. */
export async function startSessionBridge(
  sessions: CollaborationSessions,
  local?: LocalSigmaDocStore,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer((request, response) => {
    const fail = (status: number) => {
      response.writeHead(status);
      response.end();
    };
    const supplied =
      request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const suppliedBytes = Buffer.from(supplied);
    const tokenBytes = Buffer.from(token);
    if (
      request.method !== "POST" ||
      !["/read", "/library"].includes(request.url ?? "") ||
      request.headers.origin ||
      suppliedBytes.length !== tokenBytes.length ||
      !timingSafeEqual(suppliedBytes, tokenBytes)
    ) {
      fail(403);
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > (request.url === "/library" ? 28_000_000 : 4096)) request.destroy();
    });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body) as { fileId?: string; method?: string; args?: unknown[] };
        if (request.url === "/library") {
          if (!local || !libraryMethods.includes(input.method as typeof libraryMethods[number]) || !Array.isArray(input.args)) { fail(400); return; }
          const method = input.method as typeof libraryMethods[number];
          const result = await (local[method] as (...args: unknown[]) => Promise<unknown>).apply(local, input.args);
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ result }));
          return;
        }
        if (
          typeof input.fileId !== "string" ||
          !/^file_[A-Za-z0-9-]+$/.test(input.fileId)
        ) {
          fail(400);
          return;
        }
        const document = local ? await local.loadDocument(input.fileId) : sessions.project(input.fileId);
        if (!document) {
          fail(404);
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ document, revision: 1 }));
      } catch {
        fail(400);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("BRIDGE_START_FAILED");
  const file = path.join(sessions.directory, "bridge.json");
  await durableWrite(
    file,
    JSON.stringify({
      version: 1,
      port: address.port,
      token,
      pid: process.pid,
    } satisfies Descriptor),
  );
  return async () => {
    await fs.rm(file, { force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
export async function hasSharedBinding(
  userData: string,
  fileId: string,
): Promise<boolean> {
  let source: string;
  try {
    source = await fs.readFile(
      path.join(userData, "collaboration-v1", "registry.json"),
      "utf8",
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
  const registry = JSON.parse(source) as {
    version: number;
    files: Record<string, unknown>;
  };
  if (registry.version !== 1) throw new Error("SHARED_PROTOCOL_MISMATCH");
  return Object.hasOwn(registry.files, fileId);
}
export async function readSharedDocument(
  userData: string,
  fileId: string,
): Promise<SigmaDocument | undefined> {
  if (!(await hasSharedBinding(userData, fileId))) return undefined;
  const descriptor = JSON.parse(
    await fs.readFile(
      path.join(userData, "collaboration-v1", "bridge.json"),
      "utf8",
    ),
  ) as Descriptor;
  if (
    descriptor.version !== 1 ||
    !Number.isInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(descriptor.token)
  )
    throw new Error("SESSION_BRIDGE_UNAVAILABLE");
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/read`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fileId }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("SESSION_BRIDGE_UNAVAILABLE");
  const result = (await response.json()) as { document: unknown };
  return parseSigmaDocument(result.document);
}

const libraryMethods = ["listFiles", "getWorkspaceOverview", "createFileFromDocument", "duplicateFile", "deleteFile", "renameWorkspace", "deleteWorkspace", "createFolder", "updateFolder", "deleteFolder", "moveFileToFolder", "moveFileToWorkspace"] as const;
/** MCP uses the same main authority as renderer IPC, including metadata-only lazy files. */
export function libraryBridgeAuthority(userData: string): Partial<LibraryAuthority> {
  return Object.fromEntries(libraryMethods.map(method => [method, (...args: unknown[]) => callLibraryBridge(userData, method, args)])) as Partial<LibraryAuthority>;
}
async function callLibraryBridge(userData: string, method: string, args: unknown[]): Promise<unknown> {
  const directory = path.join(userData, "collaboration-v1");
  let descriptor: Descriptor;
  try { descriptor = JSON.parse(await fs.readFile(path.join(directory, "bridge.json"), "utf8")) as Descriptor; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    if (files.some(file => file.startsWith("catalog-") || file === "registry.json")) throw new Error("SESSION_BRIDGE_UNAVAILABLE");
    return undefined;
  }
  if (descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error("SESSION_BRIDGE_UNAVAILABLE");
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/library`, { method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok) throw new Error("SESSION_BRIDGE_UNAVAILABLE");
  return ((await response.json()) as { result: unknown }).result;
}
