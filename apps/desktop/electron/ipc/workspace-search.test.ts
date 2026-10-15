import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

// These tests isolate handler behavior; sender authorization is tested in trusted-ipc.test.ts.
vi.mock("../trusted-ipc", async () => ({ ipcMain: (await import("electron")).ipcMain }));

import type { WorkspaceBodySearchUpdate } from "@/lib/workspace-body-search-contract";
import type { WorkspaceBodySearchService } from "../workspace-body-search";
import { registerWorkspaceSearchIpc } from "./workspace-search";

function fakeSender() {
  const listeners = new Map<string, () => void>();
  return {
    sent: [] as unknown[][],
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(...args: unknown[]) { this.sent.push(args); },
    once(name: string, listener: () => void) { listeners.set(name, listener); },
    destroy() { this.destroyed = true; listeners.get("destroyed")?.(); },
  };
}

describe("workspace-search ipc", () => {
  let opened: Array<{ emit: (update: WorkspaceBodySearchUpdate) => void; setQuery: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>;
  let released: unknown[];

  beforeEach(() => {
    mocks.handlers.clear();
    opened = [];
    released = [];
    const service = {
      open(emit: (update: WorkspaceBodySearchUpdate) => void) {
        const session = { emit, setQuery: vi.fn(async () => {}), close: vi.fn() };
        opened.push(session);
        return session;
      },
      release(session: unknown) { released.push(session); },
      close() {},
    } as unknown as WorkspaceBodySearchService;
    registerWorkspaceSearchIpc(service);
  });

  it("keeps one session per window, tags updates with the session, and closes it on close, reload and destroy", async () => {
    const query = mocks.handlers.get("workspace-search:query")!;
    const close = mocks.handlers.get("workspace-search:close")!;
    const sender = fakeSender();
    const event = { sender };

    await query(event, "search_a", 1, "三角");
    await query(event, "search_a", 2, "三角関数");
    expect(opened).toHaveLength(1);
    expect(opened[0].setQuery.mock.calls).toEqual([[1, "三角"], [2, "三角関数"]]);
    opened[0].emit({ queryId: 2, reset: true, hits: [], removed: [], pending: 3 });
    expect(sender.sent).toEqual([["workspace-search:update", { sessionId: "search_a", queryId: 2, reset: true, hits: [], removed: [], pending: 3 }]]);

    // 再読み込みした画面は新しい ID で来る。前のセッションを閉じる。
    await query(event, "search_b", 1, "微分");
    expect(released).toEqual([opened[0]]);
    await close(event, "search_a");
    expect(released).toHaveLength(1);
    await close(event, "search_b");
    expect(released).toEqual([opened[0], opened[1]]);

    await query(event, "search_c", 1, "積分");
    sender.destroy();
    expect(released).toEqual([opened[0], opened[1], opened[2]]);
    opened[2].emit({ queryId: 1, reset: true, hits: [], removed: [], pending: 0 });
    expect(sender.sent).toHaveLength(1);
  });

  it("ignores malformed requests and caps the query length", async () => {
    const query = mocks.handlers.get("workspace-search:query")!;
    const event = { sender: fakeSender() };
    await query(event, "../bad", 1, "x");
    await query(event, "search_a", 1.5, "x");
    await query(event, "search_a", 1, 42);
    expect(opened).toHaveLength(0);
    await query(event, "search_a", 1, "あ".repeat(500));
    expect(opened[0].setQuery).toHaveBeenCalledWith(1, "あ".repeat(200));
  });
});
