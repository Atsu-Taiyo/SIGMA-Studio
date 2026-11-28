// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAiUsageSnapshot, sigmaUsageFromGateway, type AiUsageSnapshot } from "@/lib/ai/ai-usage";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { resetAiPermissionModeStoreForTests } from "../application/ai-permission-mode-store";
import { resetAiUsageStoreForTests } from "../application/ai-usage-store";
import { AiPermissionPicker, AiUsageButton, AiUsageLimitNotice } from "./AiComposerStatus";

vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetAiPermissionModeStoreForTests();
  resetAiUsageStoreForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

type Bridge = NonNullable<ReturnType<typeof getDesktopBridge>>;
function installBridge(bridge: Partial<Bridge>): void {
  vi.mocked(getDesktopBridge).mockReturnValue(bridge as Bridge);
}
const button = (label: RegExp) => [...document.querySelectorAll("button")].find(item => label.test(item.getAttribute("aria-label") ?? "")) as HTMLButtonElement;
const menuItems = () => [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];

describe("the permission pill", () => {
  function settings(initial: string, save: (value: string) => Promise<{ ok: boolean }>) {
    let changed: (() => void) | undefined;
    let current = initial;
    const api = {
      get: vi.fn(async () => ({ aiPermissionMode: current })),
      setAiPermissionMode: vi.fn(save),
      onAiSettingsChanged: (handler: () => void) => { changed = handler; return () => {}; },
    };
    installBridge({ settings: api } as unknown as Partial<Bridge>);
    return { api, external: (next: string) => { current = next; changed?.(); } };
  }

  it("shows the current permission, lists the three choices with what each does, and saves a pick", async () => {
    const { api } = settings("ask", async () => ({ ok: true }));
    await act(async () => root.render(<AiPermissionPicker />));
    // 入力欄ではアイコンだけ。いまの権限は、読み上げの名前とアイコンの種類で分かる。
    expect(button(/^AIの権限: 承認を求める$/).textContent).toBe("");
    expect(button(/^AIの権限: 承認を求める$/).dataset.mode).toBe("ask");

    await act(async () => button(/^AIの権限/).click());
    const items = menuItems();
    expect(items.map(item => [item.getAttribute("aria-checked"), item.textContent])).toEqual([
      ["false", "読み取りのみ教材を読んで答えるだけ。編集案は作りません"],
      ["true", "承認を求める編集は提案になり、承認すると教材に入ります"],
      ["false", "自動で適用検証を通った提案を、確認なしで教材に入れます"],
    ]);
    await act(async () => items[0]!.click());
    expect(api.setAiPermissionMode).toHaveBeenCalledWith("readOnly");
    expect(button(/^AIの権限: 読み取りのみ$/).dataset.mode).toBe("readOnly");
    expect(button(/^AIの権限: 読み取りのみ$/).title).toBe("権限: 読み取りのみ");
    expect(menuItems()).toEqual([]);
  });

  it("goes back to the saved permission when the change cannot be stored", async () => {
    settings("ask", async () => ({ ok: false }));
    await act(async () => root.render(<AiPermissionPicker />));
    await act(async () => button(/^AIの権限/).click());
    await act(async () => menuItems()[2]!.click());
    expect(button(/^AIの権限: 承認を求める$/).title).toBe("権限を変更できませんでした。");
  });

  it("follows a change made elsewhere — the settings screen, or the AI changing its own setting", async () => {
    const { external } = settings("ask", async () => ({ ok: true }));
    await act(async () => root.render(<AiPermissionPicker />));
    await act(async () => external("auto"));
    expect(button(/^AIの権限: 自動で適用$/).dataset.mode).toBe("auto");
  });

  it("is absent where there is no settings bridge to write to", async () => {
    installBridge({});
    await act(async () => root.render(<AiPermissionPicker />));
    expect(container.innerHTML).toBe("");
  });
});

describe("the usage button", () => {
  const future = "2099-12-05T03:14:00.000Z";
  function usage(snapshot: Partial<AiUsageSnapshot>) {
    const api = {
      get: vi.fn(async () => ({ ...emptyAiUsageSnapshot(), ...snapshot })),
      refresh: vi.fn(async () => ({ ...emptyAiUsageSnapshot(), ...snapshot })),
      onChanged: vi.fn(() => () => {}),
    };
    installBridge({ aiUsage: api } as unknown as Partial<Bridge>);
    return api;
  }
  const weekly = (usedRatio: number) =>
    sigmaUsageFromGateway({ plan: "pro", included: true, weekly: { usedRatio, resetsAt: future, reached: usedRatio >= 1 } }, Date.now())!;

  it("draws the conversation's context share and opens to the context and this AI's limits", async () => {
    const api = usage({ sigma: weekly(0.42) });
    const openSettings = vi.fn();
    await act(async () => root.render(
      <AiUsageButton provider="sigma" contextUsage={{ usedTokens: 78_400, windowTokens: 1_048_576 }} onOpenUsageSettings={openSettings} />,
    ));
    const trigger = button(/^使用状況: コンテキスト 7%$/);
    expect(trigger.querySelector(".ai-chat-usage-ring-value")).not.toBeNull();
    expect(trigger.querySelector(".ai-chat-usage-badge")).toBeNull();

    await act(async () => trigger.click());
    // 開くたびに、問い合わせられる AI の値を読み直す。
    expect(api.refresh).toHaveBeenCalledWith("sigma");
    const popover = document.querySelector('[role="dialog"]')!;
    expect(popover.textContent).toContain("78.4K / 1M トークン (7%)");
    expect(popover.textContent).toContain("SIGMA AI の利用枠");
    expect(popover.textContent).toContain("1週間");
    expect(popover.textContent).toContain("42% 使用");
    expect(popover.textContent).toMatch(/にリセット/u);
    const meters = [...popover.querySelectorAll('[role="progressbar"]')].map(meter => meter.getAttribute("aria-valuenow"));
    expect(meters).toEqual(["7", "42"]);

    await act(async () => (popover.querySelector(".ai-chat-usage-settings-link") as HTMLButtonElement).click());
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("says so in words when the context is not known yet or the AI does not report it", async () => {
    usage({});
    await act(async () => root.render(<AiUsageButton provider="claude" contextUsage={null} />));
    const trigger = button(/^使用状況$/);
    expect(trigger.querySelector(".ai-chat-usage-ring-value")).toBeNull();
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("AIが次に応答すると表示されます。");
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("まだ分かりません。このAIを次に実行すると表示されます。");
    await act(async () => trigger.click());

    await act(async () => root.render(<AiUsageButton provider="antigravity" contextUsage={null} />));
    await act(async () => button(/^使用状況$/).click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("このAIはコンテキストの使用量を知らせません。");
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("このAIは利用枠を知らせません。");
  });

  it("marks the button and warns before sending once the allowance is used up", async () => {
    usage({ sigma: weekly(1) });
    await act(async () => root.render(<><AiUsageLimitNotice provider="sigma" /><AiUsageButton provider="sigma" contextUsage={null} /></>));
    expect(button(/^使用状況 · SIGMA AI: 上限に達しています$/).querySelector(".ai-chat-usage-badge")).not.toBeNull();
    const notice = document.querySelector('[role="status"]')!;
    expect(notice.textContent).toMatch(/^SIGMA AI の利用枠を使い切りました。.+ にリセットされます。$/u);

    // 使い切っていない AI を選んでいる間は、何も出さない。
    await act(async () => root.render(<AiUsageLimitNotice provider="claude" />));
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
