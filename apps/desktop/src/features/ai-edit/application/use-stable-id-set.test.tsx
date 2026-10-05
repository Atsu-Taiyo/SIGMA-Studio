// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStableIdSet } from "./use-stable-id-set";

let container: HTMLDivElement;
let root: Root;
const seen: ReadonlySet<string>[] = [];

function Harness({ ids, sinkRef }: { ids: Iterable<string>; sinkRef: { current: ReadonlySet<string>[] } }) {
  const set = useStableIdSet(ids);
  useLayoutEffect(() => {
    sinkRef.current.push(set);
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seen.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useStableIdSet", () => {
  it("returns the same set while the ids are the same, whatever order or container they come in", async () => {
    const sinkRef = { current: seen };
    await act(async () => root.render(<Harness ids={new Set(["b", "a"])} sinkRef={sinkRef} />));
    await act(async () => root.render(<Harness ids={["a", "b"]} sinkRef={sinkRef} />));
    await act(async () => root.render(<Harness ids={new Set(["a", "b", "c"])} sinkRef={sinkRef} />));
    await act(async () => root.render(<Harness ids={[]} sinkRef={sinkRef} />));
    await act(async () => root.render(<Harness ids={new Set()} sinkRef={sinkRef} />));

    expect(seen[1]).toBe(seen[0]);
    expect([...seen[0]].sort()).toEqual(["a", "b"]);
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen[4]).toBe(seen[3]);
    expect(seen[3].size).toBe(0);
  });
});
