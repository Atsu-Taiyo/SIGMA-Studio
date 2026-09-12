import { describe, expect, it, vi } from "vitest";

import { SpaceAfterDragSession, type SpaceAfterDragGesture } from "./space-after-drag-session";

const commit = { blockId: "body", px: 24, deltaPx: 24, bottomBefore: 100 };

function gesture(stop = vi.fn()): SpaceAfterDragGesture {
  return {
    target: { blockId: "body", bottom: 100, left: 0, insideProblemArea: false, spaceAfterPx: 0 },
    startClientY: 100, startPx: 0, px: 0, clientY: 100, zoomFactor: 1, frame: null, stop,
  };
}

describe("space-after drag ownership and deferred measurement", () => {
  it("freezes through the gesture and committed-paint wait, then releases exactly one queued recompute", () => {
    const session = new SpaceAfterDragSession();
    const drag = gesture();
    session.start(drag);
    expect(session.isDragging).toBe(true);
    expect(session.requestRecompute(false)).toBe(false);
    expect(session.release(drag)).toBe(true);
    expect(drag.stop).toHaveBeenCalledOnce();
    session.beginCommit(commit);
    expect(session.isDragging).toBe(false);
    expect(session.isFrozen).toBe(true);
    expect(session.requestRecompute(false)).toBe(false);
    session.finishCommit();
    expect(session.isFrozen).toBe(false);
    expect(session.resumeRecompute()).toBe(true);
    expect(session.resumeRecompute()).toBe(false);
  });

  it("discards a gesture before stopping its listeners and ignores a late pointerup", () => {
    const session = new SpaceAfterDragSession();
    const drag = gesture(vi.fn(() => {
      expect(session.isDragging).toBe(false);
      expect(session.pendingCommit).toBeNull();
    }));
    session.start(drag);
    session.cancel();
    expect(session.release(drag)).toBe(false);
    expect(drag.stop).toHaveBeenCalledOnce();
    expect(session.resumeRecompute()).toBe(false);
  });

  it("stops a lost prior gesture before starting its replacement and rejects old callbacks", () => {
    const session = new SpaceAfterDragSession();
    const old = gesture(vi.fn(() => { expect(session.isDragging).toBe(true); }));
    session.start(old);
    session.resetForStart();
    expect(old.stop).toHaveBeenCalledOnce();
    expect(session.isDragging).toBe(false);
    const next = gesture();
    session.start(next);
    expect(session.release(old)).toBe(false);
    expect(session.isDragging).toBe(true);
    expect(next.stop).not.toHaveBeenCalled();
    expect(session.release(next)).toBe(true);
  });

  it.each(["cancel", "restart"])("invalidates an old paint wait on %s without matching by block ID", (action) => {
    const session = new SpaceAfterDragSession();
    session.beginCommit(commit);
    if (action === "cancel") session.cancel();
    else session.resetForStart();
    expect(session.ownsCommit(commit)).toBe(false);
    const replacement = { ...commit };
    session.beginCommit(replacement);
    expect(session.ownsCommit(commit)).toBe(false);
    expect(session.ownsCommit(replacement)).toBe(true);
  });

  it("preserves a typing baseline request across drag, commit and later observer requests", () => {
    const session = new SpaceAfterDragSession();
    const drag = gesture();
    session.start(drag);
    expect(session.requestRecompute(true)).toBe(false);
    session.release(drag);
    session.beginCommit(commit);
    expect(session.requestRecompute(false)).toBe(false);
    session.finishCommit();
    expect(session.resumeRecompute(true)).toBe(true);
    expect(session.requestRecompute(false)).toBe(true);
    expect(session.consumeBaselineRefresh(true)).toBe(true);
    expect(session.requestRecompute(false)).toBe(true);
    expect(session.consumeBaselineRefresh(true)).toBe(false);
  });

  it("retains queued typing measurement after cancellation, but consumes it when measurement is stale", () => {
    const session = new SpaceAfterDragSession();
    session.start(gesture());
    session.requestRecompute(true);
    session.cancel();
    expect(session.resumeRecompute()).toBe(true);
    session.requestRecompute(false);
    expect(session.consumeBaselineRefresh(false)).toBe(false);
    session.requestRecompute(false);
    expect(session.consumeBaselineRefresh(true)).toBe(false);
  });

  it("refreshes the baseline for a successful typing measurement once, including coalesced requests", () => {
    const session = new SpaceAfterDragSession();
    expect(session.requestRecompute(true)).toBe(true);
    expect(session.requestRecompute(false)).toBe(true);
    expect(session.requestRecompute(true)).toBe(true);
    expect(session.consumeBaselineRefresh(true)).toBe(true);
    expect(session.consumeBaselineRefresh(true)).toBe(false);
  });

  it("forces a recompute for committed spacing even if no observer requested one", () => {
    const session = new SpaceAfterDragSession();
    session.beginCommit(commit);
    session.finishCommit();
    expect(session.resumeRecompute()).toBe(false);
    expect(session.resumeRecompute(true)).toBe(true);
    expect(session.requestRecompute(false)).toBe(true);
    expect(session.consumeBaselineRefresh(true)).toBe(false);
  });
});
