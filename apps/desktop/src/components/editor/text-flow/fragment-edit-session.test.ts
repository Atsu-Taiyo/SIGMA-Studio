import { describe, expect, it, vi } from "vitest";
import { FragmentEditSession } from "./fragment-edit-session";

describe("fragment edit ownership", () => {
  it("routes every continuation to one source and retains new siblings and selection", () => {
    const session = new FragmentEditSession();
    const apply = vi.fn();
    session.register({ owns: (id) => id === "source", apply });
    const edit = {
      blockId: "source",
      blocks: ["source", "new_sibling"].map((id) => ({ type: "paragraph" as const, id, children: [] })),
      activeBlockId: "new_sibling",
      context: { historyGroup: "one_input" },
    };
    expect(session.dispatch(edit)).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith(edit);
  });

  it("releases old ownership before a page-break handoff and does not guess during overlap", () => {
    const session = new FragmentEditSession();
    const first = vi.fn(), second = vi.fn();
    const release = session.register({ owns: () => true, apply: first });
    const releaseSecond = session.register({ owns: () => true, apply: second });
    const edit = { blockId: "source", blocks: [] };
    expect(session.dispatch(edit)).toBe(false);
    expect(first).not.toHaveBeenCalled();
    release();
    expect(session.dispatch(edit)).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
    expect(session.dispatch(edit)).toBe(false);
  });

  it("reads current ownership at input time and isolates documents with equal ids", () => {
    let id = "before";
    const first = new FragmentEditSession(), other = new FragmentEditSession();
    const apply = vi.fn();
    first.register({ owns: (blockId) => blockId === id, apply });
    id = "after";
    expect(first.dispatch({ blockId: "before", blocks: [] })).toBe(false);
    expect(first.dispatch({ blockId: "after", blocks: [] })).toBe(true);
    expect(other.dispatch({ blockId: "after", blocks: [] })).toBe(false);
    expect(apply).toHaveBeenCalledOnce();
  });
});
