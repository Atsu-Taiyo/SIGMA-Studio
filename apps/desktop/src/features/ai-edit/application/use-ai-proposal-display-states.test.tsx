// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAiProposalDisplayState } from "../model/proposal-display-state";
import { useAiProposalDisplayStates } from "./use-ai-proposal-display-states";

type Hook = ReturnType<typeof useAiProposalDisplayStates>;

let container: HTMLDivElement;
let root: Root;
const sink: { current: Hook | null } = { current: null };

function Harness({ live, outputRef }: { live: ReadonlyMap<string, readonly string[]>; outputRef: { current: Hook | null } }) {
  const hook = useAiProposalDisplayStates(live);
  useLayoutEffect(() => {
    outputRef.current = hook;
  });
  return null;
}

async function render(live: ReadonlyMap<string, readonly string[]>) {
  await act(async () => root.render(<Harness live={live} outputRef={sink} />));
}

function latestHook(): Hook {
  if (!sink.current) {
    throw new Error("hook not rendered");
  }
  return sink.current;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useAiProposalDisplayStates", () => {
  const CARD = "ai-proposal:p1:room:room-1";

  it("keeps an apply failure that lands after a follow-up turn added a proposal to the same card", async () => {
    await render(new Map([[CARD, ["proposal-1"]]]));
    const [, updateAtClick] = latestHook();
    // 適用を押した後、結果が返る前に同じ部屋の追加ターンで提案が増えた。
    await render(new Map([[CARD, ["proposal-1", "proposal-2"]]]));
    await act(async () => updateAtClick(CARD, ["proposal-1"], { applyError: "対象が更新されました" }));

    expect(readAiProposalDisplayState(latestHook()[0], CARD, ["proposal-1", "proposal-2"]).applyError).toBe("対象が更新されました");
  });

  it("still resets a hidden card when a follow-up turn adds a proposal", async () => {
    await render(new Map([[CARD, ["proposal-1"]]]));
    await act(async () => latestHook()[1](CARD, ["proposal-1"], { contentHidden: true }));
    expect(readAiProposalDisplayState(latestHook()[0], CARD, ["proposal-1"]).contentHidden).toBe(true);

    await render(new Map([[CARD, ["proposal-1", "proposal-2"]]]));
    expect(readAiProposalDisplayState(latestHook()[0], CARD, ["proposal-1", "proposal-2"]).contentHidden).toBe(false);
  });

  it("keeps the dismiss reason being typed", async () => {
    await render(new Map([[CARD, ["proposal-1"]]]));
    await act(async () => latestHook()[1](CARD, ["proposal-1"], { dismissReasonOpen: true, dismissReason: "数式が違う" }));

    expect(readAiProposalDisplayState(latestHook()[0], CARD, ["proposal-1"])).toMatchObject({
      dismissReasonOpen: true,
      dismissReason: "数式が違う",
    });
  });
});
