// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLocale } from "@/lib/i18n/react";
import { createTranslator } from "@/lib/i18n";
import { OfficialPluginsSection } from "./OfficialPluginsSection";
import type { OfficialPluginBridge, OfficialPluginStatus } from "./plugin-ui-contract";

let container: HTMLDivElement, root: Root;
const ja = createTranslator("ja", "settings");
const available: OfficialPluginStatus = { available: true, requiresLogin: false, autoUpdate: true, phase: "idle",
  plugins: [{ id: "example", name: "教材変換", description: "PCで変換", latestVersion: "1.0.0", enabled: false, compatible: true, authorized: true }] };
const installed: OfficialPluginStatus = { ...available, plugins: [{ ...available.plugins[0], installedVersion: "1.0.0", enabled: true }] };
const installing: OfficialPluginStatus = { ...available, phase: "installing" };
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
async function mount(status?: OfficialPluginStatus) {
  const host = provide(status);
  await act(async () => root.render(<OfficialPluginsSection />));
  return host;
}
function deferred() {
  let resolve!: (value: OfficialPluginStatus) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<OfficialPluginStatus>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
const allDisabled = () => [...container.querySelectorAll("button")].every(item => item.disabled);
const success = () => container.querySelector('[data-tone="success"]');
const errorText = () => container.querySelector('[role="alert"]')?.textContent;
const added = "教材変換の追加が完了しました。";
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
  it("hides installed plugin metadata while signed out", async () => {
    provide({ ...available, requiresLogin: true, plugins: [{ ...available.plugins[0], installedVersion: "0.9.0", enabled: true }] });
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.textContent).toContain("ログインが必要");
    expect(container.textContent).not.toContain("教材変換");
    expect(container.textContent).not.toContain("インストール済み");
  });
  it("hides names and fonts for an installed plugin after access is revoked", async () => {
    provide({...available,requiresRole:true,plugins:[{...available.plugins[0],installedVersion:"0.9.0",enabled:true,authorized:false,fonts:["Example Serif"]}]});
    await act(async()=>root.render(<OfficialPluginsSection/>));
    expect(container.textContent).toContain("管理者に確認");
    expect(container.textContent).not.toContain("付属フォント");
    expect(container.textContent).not.toContain("Example Serif");
    expect(container.textContent).not.toContain("教材変換");
  });
  it("drops a stale initial response after an access-change event", async () => {
    let resolve!: (value: OfficialPluginStatus) => void;
    const { bridge, push } = provide();
    vi.mocked(bridge.status).mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    await act(async () => root.render(<OfficialPluginsSection />));
    await act(async () => push({ ...available, requiresLogin: true, plugins: [] }));
    await act(async () => resolve(available));
    expect(container.textContent).toContain("ログインが必要");
    expect(container.textContent).not.toContain("教材変換");
  });
  it("hides plugin metadata when the host has not explicitly granted access", async () => {
    provide({ ...available, plugins: [{ ...available.plugins[0], authorized: undefined }] });
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.textContent).not.toContain("教材変換");
  });
  it("localizes host failures and keeps the installed version visible", async () => {
    provide({ ...available, error: "verification-failed", plugins: [{ ...available.plugins[0], installedVersion: "0.9.0" }] });
    await act(async () => root.render(<OfficialPluginsSection />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("プラグインを検証できませんでした。");
    expect(container.textContent).toContain("インストール済み：0.9.0");
    expect(createTranslator("en", "settings")("plugins.title")).toBe("Official plugins");
  });
  it("reports completion only after progress, the installed event, and the action return", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push(installing));
    expect(container.textContent).toContain(ja("plugins.working"));
    expect(allDisabled()).toBe(true);
    await act(async () => push(installed));
    expect(success()).toBeNull(); expect(allDisabled()).toBe(true);
    await act(async () => install.resolve(installed));
    expect(success()?.textContent).toBe(added);
    expect(success()?.getAttribute("role")).toBe("status");
    expect(success()?.getAttribute("aria-live")).toBe("polite");
    expect(success()?.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain(ja("plugins.working"));
    await act(async () => push(installed));
    expect(success()?.textContent).toBe(added);
    vi.mocked(bridge.check).mockReturnValueOnce(deferred().promise);
    await act(async () => button(ja("plugins.check"))?.click());
    expect(success()).toBeNull();
  });
  it("keeps an action failure that follows host progress", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push(installing));
    await act(async () => install.reject(new Error("download failed")));
    expect(errorText()).toBe(ja("plugins.errors.unavailable"));
    expect(success()).toBeNull();
    await act(async () => push(available));
    expect(errorText()).toBe(ja("plugins.errors.unavailable"));
    expect(success()).toBeNull();
    expect(button("追加")?.disabled).toBe(false);
  });
  it("lets a sign-out during an install win over its late success", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push({ ...available, requiresLogin: true, plugins: [] }));
    await act(async () => install.resolve(installed));
    expect(success()).toBeNull();
    expect(container.textContent).toContain("ログインが必要");
    expect(container.textContent).not.toContain("教材変換");
  });
  it("does not restore a stale result after access is lost and regained mid-install", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push({ ...available, requiresLogin: true, plugins: [] }));
    await act(async () => push(available));
    await act(async () => install.resolve(installed));
    expect(success()).toBeNull();
    expect(container.textContent).toContain(ja("plugins.notInstalled"));
    expect(container.textContent).not.toContain("インストール済み");
  });
  it("waits for the host to commit an idle status before reporting completion", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push(installing));
    await act(async () => install.resolve(installed));
    expect(success()).toBeNull(); expect(allDisabled()).toBe(true);
    await act(async () => push(installed));
    expect(success()?.textContent).toBe(added);
  });
  it("reports no completion for results that did not install, are malformed, or carry an error", async () => {
    const { bridge } = await mount();
    vi.mocked(bridge.install).mockResolvedValueOnce(available)
      .mockResolvedValueOnce({ phase: "idle" } as unknown as OfficialPluginStatus)
      .mockResolvedValueOnce({ ...installed, error: "verification-failed" });
    await act(async () => button("追加")?.click());
    expect(success()).toBeNull(); expect(errorText()).toBeUndefined();
    await act(async () => button("追加")?.click());
    expect(success()).toBeNull(); expect(errorText()).toBe(ja("plugins.errors.unavailable"));
    expect(container.textContent).toContain(ja("plugins.notInstalled"));
    await act(async () => button("追加")?.click());
    expect(success()).toBeNull(); expect(errorText()).toBe("プラグインを検証できませんでした。");
  });
  it("uses update copy when a newer version replaces the installed one", async () => {
    await mount({ ...available, plugins: [{ ...available.plugins[0], installedVersion: "0.9.0", enabled: true }] });
    await act(async () => button(ja("plugins.update"))?.click());
    expect(success()?.textContent).toBe("教材変換の更新が完了しました。");
  });
  it("confirms a check through host progress and reports available updates", async () => {
    const { bridge, push } = await mount(installed), check = deferred();
    vi.mocked(bridge.check).mockReturnValueOnce(check.promise)
      .mockResolvedValueOnce({ ...installed, plugins: [{ ...installed.plugins[0], latestVersion: "1.1.0" }] });
    await act(async () => button(ja("plugins.check"))?.click());
    await act(async () => push({ ...installed, phase: "checking" }));
    expect(container.textContent).toContain(ja("plugins.checking"));
    await act(async () => push(installed));
    await act(async () => check.resolve(installed));
    expect(success()?.textContent).toBe("確認が完了しました。");
    await act(async () => button(ja("plugins.check"))?.click());
    expect(success()?.textContent).toBe("1件の更新があります。");
  });
  it("reports loading only once the host has enabled the plugin", async () => {
    const disabled: OfficialPluginStatus = { ...installed, plugins: [{ ...installed.plugins[0], enabled: false }] };
    const { bridge } = await mount(disabled);
    vi.mocked(bridge.setEnabled).mockResolvedValueOnce(disabled).mockResolvedValueOnce(installed).mockResolvedValueOnce(disabled);
    const toggle = () => [...container.querySelectorAll<HTMLElement>('[role="switch"]')].pop();
    await act(async () => toggle()?.click());
    expect(bridge.setEnabled).toHaveBeenLastCalledWith("example", true);
    expect(success()).toBeNull();
    await act(async () => toggle()?.click());
    expect(success()?.textContent).toBe("教材変換の読み込みが完了しました。");
    await act(async () => toggle()?.click());
    expect(bridge.setEnabled).toHaveBeenLastCalledWith("example", false);
    expect(success()).toBeNull();
  });
  it("clears completion when the host reports an error or access is lost", async () => {
    const { push } = await mount(installed);
    await act(async () => button(ja("plugins.check"))?.click());
    expect(success()?.textContent).toBe("確認が完了しました。");
    await act(async () => push({ ...installed, error: "busy" }));
    expect(success()).toBeNull();
    await act(async () => button(ja("plugins.check"))?.click());
    expect(success()?.textContent).toBe("確認が完了しました。");
    await act(async () => push({ ...installed, requiresRole: true }));
    expect(success()).toBeNull();
  });
  it("does not report a stale install after only that plugin loses and regains access", async () => {
    const { bridge, push } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => push({ ...available, plugins: [{ ...available.plugins[0], authorized: false }] }));
    await act(async () => push(available));
    await act(async () => install.resolve(installed));
    expect(success()).toBeNull();
    expect(container.textContent).toContain(ja("plugins.notInstalled"));
  });
  it("does not report an incompatible installed result as ready", async () => {
    const { bridge } = await mount();
    vi.mocked(bridge.install).mockResolvedValueOnce({ ...installed, plugins: [{ ...installed.plugins[0], compatible: false }] });
    await act(async () => button("追加")?.click());
    expect(success()).toBeNull();
    expect(createTranslator("en", "settings")("plugins.addComplete", { name: "Example" })).toBe("Example has been added.");
  });
  it("ignores an action that settles after unmount", async () => {
    const { bridge, unsubscribe } = await mount(), install = deferred();
    vi.mocked(bridge.install).mockReturnValueOnce(install.promise);
    await act(async () => button("追加")?.click());
    await act(async () => root.render(null));
    await act(async () => install.resolve(installed));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });
});
