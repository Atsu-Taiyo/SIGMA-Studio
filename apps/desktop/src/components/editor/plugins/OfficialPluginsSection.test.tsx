// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLocale } from "@/lib/i18n/react";
import { createTranslator } from "@/lib/i18n";
import { OfficialPluginsSection } from "./OfficialPluginsSection";
import type { OfficialPluginBridge, OfficialPluginStatus } from "./plugin-ui-contract";

let container: HTMLDivElement, root: Root;
const available: OfficialPluginStatus = { available: true, requiresLogin: false, autoUpdate: true, phase: "idle",
  plugins: [{ id: "example", name: "教材変換", description: "PCで変換", latestVersion: "1.0.0", enabled: false, compatible: true }] };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja"); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (window as Window & { sigmaPlugins?: OfficialPluginBridge }).sigmaPlugins;
});
function provide(status = available) {
  const unsubscribe = vi.fn(); let listener: ((state: OfficialPluginStatus) => void) | undefined;
  const bridge: OfficialPluginBridge = { status: vi.fn(async () => status), check: vi.fn(async () => status),
    install: vi.fn(async () => ({ ...status, plugins: status.plugins.map(p => ({ ...p, installedVersion: p.latestVersion, enabled: true })) })),
    setEnabled: vi.fn(async () => status), setAutoUpdate: vi.fn(async () => status),
    onChange: value => { listener = value; return unsubscribe; } };
  (window as Window & { sigmaPlugins?: OfficialPluginBridge }).sigmaPlugins = bridge;
  return { bridge, unsubscribe, push: (next: OfficialPluginStatus) => listener?.(next) };
}
describe("official plugin settings", () => {
  it("shows unavailable without a privileged host", async () => {
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.textContent).toContain("このアプリではプラグインを利用できません。");
    expect(container.querySelector("button")).toBeNull();
  });
  it("installs through the host, observes updates, and removes its subscription", async () => {
    const { bridge, unsubscribe, push } = provide(), changed = vi.fn();
    await act(async () => root.render(<OfficialPluginsSection onFontsChanged={changed} />));
    const add = [...container.querySelectorAll("button")].find(button => button.textContent === "追加");
    expect(add).toBeDefined(); await act(async () => add?.click());
    expect(bridge.install).toHaveBeenCalledWith("example"); expect(changed).toHaveBeenCalled();
    expect(container.textContent).toContain("インストール済み：1.0.0");
    await act(async () => push({ ...available, phase: "installing" }));
    expect([...container.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    await act(async () => root.render(null)); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("requires login for downloads while allowing installed plugins to be enabled offline", async () => {
    provide({ ...available, requiresLogin: true, plugins: [{ ...available.plugins[0], installedVersion: "0.9.0", enabled: true }] });
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.textContent).toContain("ログインが必要");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "更新")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="教材変換を有効にする"]')?.disabled).toBe(false);
  });
  it("localizes host failures and keeps the installed version visible", async () => {
    provide({ ...available, error: "verification-failed", plugins: [{ ...available.plugins[0], installedVersion: "0.9.0" }] });
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("プラグインを検証できませんでした。");
    expect(container.textContent).toContain("インストール済み：0.9.0");
    expect(createTranslator("en", "settings")("plugins.title")).toBe("Official plugins");
  });
});
