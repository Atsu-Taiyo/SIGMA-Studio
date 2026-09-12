import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  reasonOpen: true,
  refs: [] as Array<{ current: unknown }>,
  stateCall: 0,
  setReasonOpen: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useCallback: <Value,>(value: Value) => value,
    useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
    useId: () => "dismiss-reason-popover",
    useRef: () => hooks.refs.shift(),
    useState: <Value,>(initialValue: Value) => {
      const call = hooks.stateCall++;
      return call === 0
        ? [hooks.reasonOpen, hooks.setReasonOpen]
        : [initialValue, vi.fn()];
    },
  };
});

// この spec はコンポーネントを**関数として直接呼び**、react の hook を差し替えて
// ポップオーバーの開閉ロジックだけを見る。`useT` は `useSyncExternalStore` を使うので、
// 実物のままだとレンダラの外で dispatcher が null になって落ちる。翻訳自体はこの
// spec の関心ではないので、日本語の解決器を返すだけのものへ差し替える。
vi.mock("@/lib/i18n/react", async () => {
  const { createTranslator } = await vi.importActual<typeof import("@/lib/i18n")>("@/lib/i18n");
  return { useT: (namespace: string) => createTranslator("ja", namespace as "ai") };
});

import { AiProposalActions } from "./AiProposalActions";

describe("AiProposalActions dismiss reason popover", () => {
  const listeners = new Map<string, (event: never) => void>();
  const trigger = {
    contains: vi.fn(() => false),
    focus: vi.fn(),
  };
  const popover = {
    contains: vi.fn(() => false),
  };

  beforeEach(() => {
    hooks.effects = [];
    hooks.reasonOpen = true;
    hooks.refs = [{ current: trigger }, { current: popover }];
    hooks.stateCall = 0;
    hooks.setReasonOpen.mockReset();
    trigger.contains.mockReset().mockReturnValue(false);
    trigger.focus.mockReset();
    popover.contains.mockReset().mockReturnValue(false);
    listeners.clear();
    vi.stubGlobal("document", {
      addEventListener: vi.fn((type: string, listener: (event: never) => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    });
  });

  function mountOpenPopover() {
    AiProposalActions({ applying: false, dismissReasonPlaceholder: "理由" });
    const cleanup = hooks.effects[0]?.();
    return typeof cleanup === "function" ? cleanup : () => {};
  }

  it("closes on Escape and restores focus to the dismiss trigger", () => {
    const cleanup = mountOpenPopover();
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    listeners.get("keydown")?.(event as never);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(hooks.setReasonOpen).toHaveBeenCalledWith(false);
    expect(trigger.focus).toHaveBeenCalledOnce();
    cleanup();
  });

  it("closes on an outside pointer interaction without stealing its focus", () => {
    const cleanup = mountOpenPopover();

    listeners.get("pointerdown")?.({ target: {} } as never);

    expect(hooks.setReasonOpen).toHaveBeenCalledWith(false);
    expect(trigger.focus).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps the popover open for interactions inside it", () => {
    popover.contains.mockReturnValue(true);
    const cleanup = mountOpenPopover();

    listeners.get("pointerdown")?.({ target: {} } as never);

    expect(hooks.setReasonOpen).not.toHaveBeenCalled();
    cleanup();
  });
});
