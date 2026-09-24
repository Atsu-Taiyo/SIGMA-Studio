import { ipcMain } from "electron";
import { z } from "zod";
import type { SharedTargetRef } from "@/features/collaboration/model/catalog";
import type { LibrarySharingTarget } from "@/lib/runtime/shared-catalog";
import type { LocalSigmaDocStore } from "../local-sigma-doc-store";
import type { DesktopSharedCatalog } from "./catalog";
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const localTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: id }),
  z.object({ kind: z.literal("folder"), workspaceId: id, folderId: id }),
  z.object({ kind: z.literal("document"), fileId: id }),
]);
const sharedTarget = z.object({ kind: z.enum(["workspace", "folder", "document"]), catalogNodeId: z.string().uuid(), sharedDocumentId: z.string().uuid().optional() });
const role = z.enum(["admin", "editor", "viewer"]);
export function registerCatalogIpc(catalog: DesktopSharedCatalog, local: LocalSigmaDocStore): void {
  const handle = (name: string, run: (...args: unknown[]) => unknown) => ipcMain.handle(`shared-catalog:${name}`, (event, ...args: unknown[]) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("MAIN_FRAME_REQUIRED");
    return run(...args);
  });
  handle("billing", action => catalog.billing(z.enum(["checkout", "portal"]).parse(action)));
  handle("recover-locked", () => catalog.recoverLocked());
  handle("status", () => catalog.status());
  handle("refresh", () => catalog.refresh());
  handle("visible", visible => catalog.setVisible(z.boolean().parse(visible)));
  handle("start", target => catalog.start(localTarget.parse(target)));
  handle("details", target => catalog.details(z.discriminatedUnion("source", [z.object({ source: z.literal("local"), local: localTarget }), z.object({ source: z.literal("shared"), shared: sharedTarget })]).parse(target) as LibrarySharingTarget));
  handle("join", token => catalog.join(z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(token)));
  handle("invite", (target, value) => catalog.invite(sharedTarget.parse(target) as SharedTargetRef, role.parse(value)));
  handle("change-member", (target, userId, value) => catalog.changeMember(sharedTarget.parse(target) as SharedTargetRef, z.string().uuid().parse(userId), role.nullable().parse(value)));
  handle("revoke-invitation", (target, hash) => catalog.revokeInvitation(sharedTarget.parse(target) as SharedTargetRef, z.string().regex(/^[a-f0-9]{64}$/).parse(hash)));
  handle("end", (target, action) => catalog.end(sharedTarget.parse(target) as SharedTargetRef, z.enum(["stop", "delete", "leave"]).parse(action)));
  handle("rename-document", async (workspaceId, fileId, name) => {
    const workspace = id.parse(workspaceId), file = id.parse(fileId), title = z.string().trim().min(1).max(240).parse(name);
    const result = await catalog.renameDocument(workspace, file, title);
    if (result) return result;
    const loaded = await local.loadDocumentWithRecovery(file);
    if (!loaded.ok) return { state: "error", error: loaded.error };
    const saved = await local.saveDocument(file, { ...loaded.document, metadata: { ...loaded.document.metadata, title } }, { expectedRevision: loaded.revision });
    return saved.ok ? local.getWorkspaceOverview(workspace) : { state: "error", error: saved.error };
  });
}
