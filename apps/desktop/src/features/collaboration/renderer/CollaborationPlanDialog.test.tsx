// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "@/lib/desktop-bridge";
import type { SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import { CollaborationAccountControl } from "./CollaborationAccountControl";
import { CollaborationPlanDialog } from "./CollaborationPlanDialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const click = async (element: Element) => {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
function button(name: string) {
  const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
  expect(found).toBeTruthy();
  return found!;
}

describe("plan paywall", () => {
  const features = (label: string) => Array.from(document.querySelectorAll(`[aria-label="${label}"] li`)).map((item) => item.textContent);
  it("compares the free plan with Pro in USD only", () => {
    act(() => root.render(<CollaborationPlanDialog plan="free" onClose={vi.fn()} />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sigma Studio のプラン");
    const [free, pro] = Array.from(dialog.querySelectorAll("section"));
    expect(free.querySelector("h3")?.textContent).toBe("無料");
    expect(free.textContent).toContain("$0");
    expect(pro.querySelector("h3")?.textContent).toBe("Pro");
    expect(pro.textContent).toContain("$9");
    expect(pro.textContent).toContain("USD / 月");
    expect(pro.textContent).toContain("1人あたり");
    expect(dialog.textContent).not.toMatch(/円|¥|￥|JPY/);
    expect(features("無料で使える機能：")).toEqual([
      "教材の作成・編集と端末への保存",
      "同時に1教材を共有（所有者以外は閲覧者を含め1人まで）",
      "招待された共有への参加",
      "編集者・閲覧者の権限設定",
    ]);
    expect(features("無料プランの全機能に加えて：")).toEqual([
      "教材ごとに閲覧者を含め15人まで招待（所有者を除く）",
      "共同編集できる教材が無制限",
      "ワークスペースやフォルダごとの共有",
      "細かい役割設定",
    ]);
    expect(button("現在のプラン").disabled).toBe(true);
    // Each plan mark is the display \sum with more particles for Pro.
    expect([free, pro].map((card) => card.querySelectorAll('svg[viewBox="0 0 72 48"] path').length)).toEqual([1, 1]);
    expect([free, pro].map((card) => card.querySelectorAll('svg[viewBox="0 0 72 48"] circle').length)).toEqual([3, 10]);
  });

  it("keeps checkout disabled until a purchase handler exists", async () => {
    act(() => root.render(<CollaborationPlanDialog plan="trial" onClose={vi.fn()} />));
    expect(button("Proにアップグレード").disabled).toBe(true);
    expect(document.body.textContent).toContain("お支払い手続きは準備中です。");
    expect(document.body.textContent).toContain("Proを試用中です。");
    expect(Array.from(document.querySelectorAll("button")).some((item) => item.textContent === "現在のプラン")).toBe(false);

    const onUpgrade = vi.fn();
    act(() => root.render(<CollaborationPlanDialog plan="free" onClose={vi.fn()} onUpgrade={onUpgrade} />));
    await click(button("Proにアップグレード"));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("お支払い手続きは準備中です。");
  });

  it("confirms an active Pro plan without an upgrade action", async () => {
    const onClose = vi.fn();
    act(() => root.render(<CollaborationPlanDialog plan="pro" onClose={onClose} />));
    expect(document.body.textContent).toContain("Proプランを利用中です");
    expect(Array.from(document.querySelectorAll("button")).some((item) => item.textContent === "Proにアップグレード")).toBe(false);
    await click(button("閉じる"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("account menu plan entry", () => {
  const info = { configured: true, user: { actorId: "owner", email: "owner@example.test", displayName: "Owner" }, sessions: [], restrictedFileIds: [] };
  function mockCatalog(status: SharedCatalogStatus) {
    const catalog = { lockedDocumentCount: vi.fn(async () => 0), onChange: vi.fn(() => vi.fn()), recoverLocked: vi.fn(async () => ({saved:0,failed:0})), status: vi.fn(async () => status), refresh: vi.fn(async () => status) };
    vi.spyOn(bridgeModule, "getDesktopBridge").mockReturnValue({
      sharedCatalog: catalog,
      collaboration: { signOut: vi.fn(), signInWithGoogle: vi.fn() },
    } as unknown as ReturnType<typeof bridgeModule.getDesktopBridge>);
    return catalog;
  }

  it("shows recovery only when the account actually has locked documents", async () => {
    const catalog = mockCatalog({ state: "ready", actorId: "owner", revision: 1 });
    act(() => root.render(<CollaborationAccountControl info={info} refresh={vi.fn(async () => {})} />));
    await click(button("Owner のアカウント")); await settle();
    expect(document.body.textContent).not.toContain("ロックされた教材の最新データを端末に保存");
    await click(button("Owner のアカウント"));
    catalog.lockedDocumentCount.mockResolvedValue(1);
    await click(button("Owner のアカウント")); await settle();
    expect(document.body.textContent).toContain("ロックされた教材の最新データを端末に保存");
    await click(button("Owner のアカウント"));
    catalog.lockedDocumentCount.mockRejectedValue(new Error("offline"));
    await click(button("Owner のアカウント")); await settle();
    expect(document.body.textContent).not.toContain("ロックされた教材の最新データを端末に保存");
  });

  it("opens the paywall from the free plan label", async () => {
    mockCatalog({ state: "ready", actorId: "owner", revision: 1, capabilities: { canStartDocumentShare: true, documentShareSource: "free", hierarchySharingEnabled: true, canStartHierarchyShare: false, hierarchyShareSource: "none" } });
    act(() => root.render(<CollaborationAccountControl info={info} refresh={vi.fn(async () => {})} />));
    await click(button("Owner のアカウント"));
    await settle();
    expect(document.body.textContent).toContain("無料プラン");
    await click(button("Proにアップグレード"));
    expect(document.querySelector('[aria-label="Owner のアカウント"][role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("$9");
    expect(document.body.textContent).toContain("チームで共同編集するなら、Proプランがおすすめです。");
  });

  it("refreshes missing capabilities and hides plans on servers without hierarchy sharing", async () => {
    const catalog = mockCatalog({ state: "ready", actorId: "owner", revision: 1 });
    catalog.refresh.mockResolvedValue({ state: "ready", actorId: "owner", revision: 1, capabilities: { canStartDocumentShare: true, documentShareSource: "free", hierarchySharingEnabled: false, canStartHierarchyShare: false, hierarchyShareSource: "none" } });
    act(() => root.render(<CollaborationAccountControl info={info} refresh={vi.fn(async () => {})} />));
    await click(button("Owner のアカウント"));
    await settle();
    expect(catalog.refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("ログアウト");
    expect(document.body.textContent).not.toContain("無料プラン");
    expect(document.body.textContent).not.toContain("Proにアップグレード");
  });
});
