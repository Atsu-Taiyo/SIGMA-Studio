import { afterEach, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { registerCollaborationIpc } from "./ipc";
import type { CollaborationSessions } from "./sessions";
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it("allows cleanup cancellation without configuration, while sign-in still fails", async () => {
  registerCollaborationIpc({ auth: null } as unknown as CollaborationSessions);
  const handler = (name: string) => {
    const callback = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === `collaboration:${name}`)![1];
    const frame = {};
    return () => callback({ senderFrame: frame, sender: { mainFrame: frame } } as Parameters<typeof callback>[0]);
  };
  expect(handler("cancel-sign-in")).not.toThrow();
  await expect(handler("sign-in-google")()).rejects.toThrow("COLLABORATION_NOT_CONFIGURED");
});
