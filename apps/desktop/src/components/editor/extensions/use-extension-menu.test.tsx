// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionBridge, ExtensionMenuGroup } from "@/lib/extension-contracts";

import { useExtensionMenu } from "./use-extension-menu";

let root: Root;
let container: HTMLDivElement;
let latest: ExtensionMenuGroup[];

const sample: ExtensionMenuGroup[] = [{
  extensionId: "sample-tool", name: "サンプル",
  sections: [{ entries: [{ type: "button", id: "import-sample", label: "取り込む" }] }],
}];

function Probe({ enabled }: { enabled: boolean }) {
  const groups = useExtensionMenu(enabled);
  useLayoutEffect(() => { latest = groups; });
  return null;
}

function install(overrides: Partial<ExtensionBridge> = {}) {
  let listener: ((groups: ExtensionMenuGroup[]) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge: ExtensionBridge = {
    menu: vi.fn(async () => sample),
    run: vi.fn(),
    onMenuChange: vi.fn((next) => { listener = next; return unsubscribe; }),
    ...overrides,
  };
  (window as Window & { sigmaExtensions?: ExtensionBridge }).sigmaExtensions = bridge;
  return { bridge, unsubscribe, push: (groups: ExtensionMenuGroup[]) => listener?.(groups) };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as Window & { sigmaExtensions?: unknown }).sigmaExtensions;
});

describe("useExtensionMenu", () => {
  it("is empty without a bridge or while disabled, and never asks the host", async () => {
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toEqual([]);
    const { bridge } = install();
    await act(async () => root.render(<Probe enabled={false} />));
    expect(latest).toEqual([]);
    expect(bridge.menu).not.toHaveBeenCalled();
  });

  it("loads the menu, follows the host's changes, refreshes on focus and unsubscribes", async () => {
    const { bridge, push, unsubscribe } = install();
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toEqual(sample);
    await act(async () => push([]));
    expect(latest).toEqual([]);
    await act(async () => push(sample));
    expect(latest).toEqual(sample);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(bridge.menu).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Probe enabled={false} />));
    expect(latest).toEqual([]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("normalizes whatever the host sends and treats a failing host as no extensions", async () => {
    const { push } = install({ menu: vi.fn(async () => [{ extensionId: "Bad Id" }] as never) });
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toEqual([]);
    await act(async () => push([{ extensionId: "ok-tool", name: "OK", sections: [{ entries: [{ type: "button", id: "a", label: "x", action: { type: "x" } }] }] }] as never));
    expect(JSON.stringify(latest)).not.toContain("action");
    install({ menu: vi.fn(async () => { throw new Error("down"); }) });
    await act(async () => root.render(<Probe enabled={false} />));
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toEqual([]);
  });
});
