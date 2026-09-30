// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaCommentThread } from "@/features/document";

import { useRequestedCommentThread } from "./use-requested-comment-thread";

type Props = Parameters<typeof useRequestedCommentThread>[0];

const thread = (id: string): SigmaCommentThread => ({
  id,
  anchor: { type: "document" },
  messages: [{ id: `m-${id}`, body: [{ type: "text", text: "x" }], createdAt: "2026-09-01T00:00:00.000Z" }],
  createdAt: "2026-09-01T00:00:00.000Z",
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/?fileId=file-1&commentThreadId=t1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

function Probe(props: Props) {
  useRequestedCommentThread(props);
  return null;
}

const render = (props: Props) => act(() => root.render(<Probe {...props} />));
const ready: Props = { ready: true, activeFileId: "file-1", comments: [thread("t1")], select: () => undefined };

describe("useRequestedCommentThread", () => {
  it("selects the requested thread once and removes the parameter", () => {
    const select = vi.fn();
    render({ ...ready, select });
    expect(select).toHaveBeenCalledExactlyOnceWith("t1");
    expect(window.location.search).toBe("?fileId=file-1");
    render({ ...ready, select, comments: [thread("t1"), thread("t2")] });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("waits for the workspace, the requested material and the thread itself", () => {
    const select = vi.fn();
    render({ ...ready, select, ready: false });
    render({ ...ready, select, activeFileId: "other-file" });
    render({ ...ready, select, comments: [thread("t2")] });
    render({ ...ready, select, comments: undefined });
    expect(select).not.toHaveBeenCalled();
    expect(window.location.search).toContain("commentThreadId=t1");

    render({ ...ready, select, comments: [thread("t2"), thread("t1")] });
    expect(select).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("gives up on a thread that never appears and stops watching for it", () => {
    const select = vi.fn();
    render({ ...ready, select, comments: [] });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(window.location.search).toBe("?fileId=file-1");
    render({ ...ready, select, comments: [thread("t1")] });
    expect(select).not.toHaveBeenCalled();
  });

  it("does nothing when the URL names no thread", () => {
    window.history.replaceState({}, "", "/?fileId=file-1");
    const select = vi.fn();
    render({ ...ready, select });
    expect(select).not.toHaveBeenCalled();
  });
});
