import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addToPocket,
  clearPocket,
  dismissPocketNotice,
  dismissPocketRemoval,
  getPocketPhase,
  getPocketState,
  removeFromPocket,
  resetPocketForTests,
  setPocketExpanded,
  showPocketNotice,
  subscribePocket,
  togglePocketExpanded,
  undoPocketRemoval,
} from "./pocket-store";

function textClip(text: string): Record<string, string> {
  return { "text/plain": text };
}

function addText(text: string): string {
  const outcome = addToPocket(textClip(text));
  if (!outcome.ok) throw new Error(`could not add: ${outcome.reason}`);
  return outcome.item.id;
}

describe("pocket store", () => {
  beforeEach(() => resetPocketForTests());
  afterEach(() => resetPocketForTests());

  it("is hidden while empty, collapsed to a handle when closed with items, and expanded when open", () => {
    expect(getPocketPhase(getPocketState())).toBe("hidden");

    addText("一つ目");
    // 入れると並びが開く (入れたものが見える)。
    expect(getPocketPhase(getPocketState())).toBe("expanded");

    setPocketExpanded(false);
    expect(getPocketPhase(getPocketState())).toBe("collapsed");

    removeFromPocket(getPocketState().items.map((item) => item.id));
    expect(getPocketPhase(getPocketState())).toBe("hidden");
  });

  it("opens an empty pocket on request, so a shortcut with nothing selected still shows something", () => {
    togglePocketExpanded();
    expect(getPocketPhase(getPocketState())).toBe("expanded");
    expect(getPocketState().items).toEqual([]);

    togglePocketExpanded();
    expect(getPocketPhase(getPocketState())).toBe("hidden");
  });

  it("marks the item just added so the strip can scroll to it, and clears any pending undo", () => {
    const first = addText("一つ目");
    removeFromPocket([first]);
    expect(getPocketState().removal).not.toBeNull();

    const second = addText("二つ目");
    expect(getPocketState().justAdded?.id).toBe(second);
    expect(getPocketState().removal).toBeNull();
  });

  it("gives every add its own token, so the same card can be highlighted again", () => {
    addText("一つ目");
    const first = getPocketState().justAdded?.token;
    addText("二つ目");

    expect(getPocketState().justAdded?.token).not.toBe(first);
  });

  it("does not add what it was refused, and says why through a notice that opens the pocket", () => {
    const outcome = addToPocket({});
    expect(outcome).toEqual({ ok: false, reason: "empty" });
    expect(getPocketState().items).toEqual([]);

    showPocketNotice("nothing");
    expect(getPocketState().notice?.kind).toBe("nothing");
    expect(getPocketPhase(getPocketState())).toBe("expanded");

    const token = getPocketState().notice?.token;
    dismissPocketNotice(token === undefined ? undefined : token + 1);
    expect(getPocketState().notice).not.toBeNull();
    dismissPocketNotice(token);
    expect(getPocketState().notice).toBeNull();
  });

  it("clears a stale notice when something is added", () => {
    showPocketNotice("nothing");
    addText("入った");

    expect(getPocketState().notice).toBeNull();
  });

  it("undoes the last removal, whether one card or all of them", () => {
    const ids = [addText("一"), addText("二"), addText("三")];

    removeFromPocket([ids[1]]);
    expect(getPocketState().items.map((item) => item.id)).toEqual([ids[0], ids[2]]);
    undoPocketRemoval();
    expect(getPocketState().items.map((item) => item.id)).toEqual(ids);

    clearPocket();
    expect(getPocketState().items).toEqual([]);
    undoPocketRemoval();
    expect(getPocketState().items.map((item) => item.id)).toEqual(ids);
  });

  it("ignores an undo with nothing to undo, and a dismissal for an older removal", () => {
    const ids = [addText("一"), addText("二")];
    const before = getPocketState();
    undoPocketRemoval();
    expect(getPocketState()).toBe(before);

    removeFromPocket([ids[0]]);
    const stale = (getPocketState().removal?.token ?? 0) - 1;
    dismissPocketRemoval(stale);
    expect(getPocketState().removal).not.toBeNull();
    dismissPocketRemoval(getPocketState().removal?.token);
    expect(getPocketState().removal).toBeNull();
    // 外した項目は、見えなくなった「元に戻す」を押せなくなっても戻らない。
    expect(getPocketState().items.map((item) => item.id)).toEqual([ids[1]]);
  });

  it("keeps the same state object when an operation changes nothing", () => {
    addText("一つ目");
    const before = getPocketState();

    removeFromPocket(["missing"]);
    setPocketExpanded(true);
    dismissPocketNotice();
    dismissPocketRemoval();

    expect(getPocketState()).toBe(before);
  });

  it("notifies subscribers only when the state changes, and stops after unsubscribing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePocket(listener);

    addText("一つ目");
    expect(listener).toHaveBeenCalledTimes(1);
    setPocketExpanded(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    addText("二つ目");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
