import { ipcMain } from "electron";
import { z } from "zod";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { CollaborationSessions } from "./sessions";
import type { SharedApproval } from "../../src/features/collaboration/model/approval";
import {
  MAX_PRESENCE_MESSAGE_BYTES,
  MAX_PRESENCE_PREVIEW_SHAPES,
  MAX_PRESENCE_SHAPE_IDS,
} from "../../src/features/collaboration/model/presence";

const fileId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const uuid = z.string().uuid();
const presenceId = z.string().min(1).max(200);
export function registerCollaborationIpc(
  sessions: CollaborationSessions,
  catalog?: import("./catalog").DesktopSharedCatalog,
): void {
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`collaboration:${name}`, (event, ...args: unknown[]) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw new Error("MAIN_FRAME_REQUIRED");
      return fn(...args);
    });
  };
  handle("info", async () => { await catalog?.status(); return sessions.info(); });
  handle("sign-in-google", async () => {
    if (!sessions.auth) throw new Error("COLLABORATION_NOT_CONFIGURED");
    await sessions.auth.signInWithGoogle();
    await catalog?.refresh();
    await catalog?.recoverPending();
  });
  handle("cancel-sign-in", () => {
    sessions.auth?.cancelSignIn();
  });
  handle("sign-out", async () => { const pending = sessions.signOut(); await catalog?.status(); await pending; });
  handle("start", async (id, document) => {
    const file = fileId.parse(id);
    const result = await sessions.start(file, parseSigmaDocument(document));
    if (catalog) { await sessions.flush(file, true); await catalog.refresh(); }
    return result;
  });
  handle("join", async token => {
    const value = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(token);
    if (!catalog) return sessions.join(value);
    const result = await catalog.join(value);
    if (!result.fileId) throw new Error("TARGET_KIND_REQUIRED");
    return { fileId: result.fileId };
  });
  handle("update", (id, update, operationId, kind, epoch) =>
    sessions.update(
      fileId.parse(id),
      z.string().max(3_000_000).parse(update),
      uuid.parse(operationId),
      z.enum(["manual", "undo", "redo"]).parse(kind),
      z.number().int().positive().parse(epoch),
    ),
  );
  handle("flush", (id, online) =>
    sessions.flush(fileId.parse(id), z.boolean().optional().parse(online)),
  );
  handle("approve", (id, input) => {
    const value = z
      .object({
        operationId: uuid,
        preconditions: z
          .array(
            z.object({ id: z.string().max(200), hash: z.string().length(64) }),
          )
          .max(10_000),
        changes: z
          .array(
            z.object({
              id: z.string().max(200),
              value: z.record(z.string(), z.unknown()).nullable(),
            }),
          )
          .max(1000),
      })
      .parse(input);
    return sessions.approve(fileId.parse(id), value as SharedApproval);
  });
  handle("members", (id) => sessions.action(fileId.parse(id), "members"));
  handle("invite", (id, role) =>
    sessions.action(fileId.parse(id), "invitations", {
      role: z.enum(["editor", "viewer"]).parse(role),
    }),
  );
  handle("change-member", (id, userId, role) =>
    sessions.action(fileId.parse(id), "members", {
      userId: uuid.parse(userId),
      role: z.enum(["editor", "viewer"]).nullable().parse(role),
    }),
  );
  handle("revoke-invitation", (id, tokenHash) =>
    sessions.action(fileId.parse(id), "invitations/revoke", {
      tokenHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(tokenHash),
    }),
  );
  handle("backups", (id) => sessions.action(fileId.parse(id), "backups"));
  handle("backup", (id) => sessions.backup(fileId.parse(id)));
  handle("restore", (id, backupId) =>
    sessions.restore(fileId.parse(id), uuid.parse(backupId)),
  );
  handle("reload", (id) => sessions.reload(fileId.parse(id)));
  handle("visible-files", (ids) => sessions.visibleFiles(z.array(fileId).max(3).parse(ids)));
  handle("view", (id) => sessions.view(fileId.nullable().parse(id)));
  handle("presence", (id, state) =>
    sessions.presence(
      fileId.parse(id),
      z
        .object({
          pageId: fileId.optional(),
          blockId: fileId.optional(),
          selection: z
            .object({
              anchor: z.string().max(2048),
              head: z.string().max(2048),
              anchorBlockId: presenceId,
              headBlockId: presenceId,
            })
            .optional(),
          overlay: z
            .object({
              selectedShapeIds: z.array(presenceId).max(MAX_PRESENCE_SHAPE_IDS),
              preview: z.object({
                kind: z.enum(["move", "resize", "rotate", "crop"]),
                shapes: z.array(z.object({
                  id: presenceId,
                  x: z.number().finite(),
                  y: z.number().finite(),
                  w: z.number().finite().nonnegative(),
                  h: z.number().finite().nonnegative(),
                  rotation: z.number().finite().optional(),
                  pivot: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
                })).max(MAX_PRESENCE_PREVIEW_SHAPES),
              }).optional(),
            })
            .optional(),
        })
        .nullable()
        .refine(
          (value) => new TextEncoder().encode(JSON.stringify({ type: "awareness", state: value })).byteLength <= MAX_PRESENCE_MESSAGE_BYTES,
          "PRESENCE_PAYLOAD_LIMIT",
        )
        .parse(state),
    ),
  );
  handle("end", (id, action) =>
    sessions.end(
      fileId.parse(id),
      z.enum(["stop", "delete", "leave"]).parse(action),
    ),
  );
  handle("copy", (id) => sessions.copy(fileId.parse(id)));
  handle("asset", (id, assetId, source) =>
    sessions.asset(
      fileId.parse(id),
      fileId.parse(assetId),
      z.string().max(28_000_000).optional().parse(source),
    ),
  );
}
