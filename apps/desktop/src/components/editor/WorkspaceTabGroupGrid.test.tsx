// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@/features/document";
import type { DocumentSession, DocumentSessionHost } from "@/features/document-session/contracts";
import type { DocumentMetadata } from "@/lib/storage";
import { aiWorkspaceTab, createSingleGroupWorkspaceLayout, documentWorkspaceTab } from "@/lib/workspace-tab-groups";
import { DocumentSessionContext, DocumentWritableContext, useDocumentSession, useDocumentWritable } from "./document-session-context";
import { WorkspaceTabGroupGrid } from "./WorkspaceTabGroupGrid";

const bridge = vi.hoisted(() => ({ load: vi.fn(), listeners: new Set<(event: { type: string; fileId: string }) => void>() }));
vi.mock("@/lib/storage", () => ({ loadDocumentByFileIdWithRecovery: bridge.load }));
vi.mock("@/lib/runtime", () => ({ getAppRuntime: () => ({ library: { onChange: (listener: (event: { type: string; fileId: string }) => void) => {
  bridge.listeners.add(listener); return () => bridge.listeners.delete(listener);
} } }) }));
vi.mock("@/lib/ai/ai-run-controller", () => {
  const rooms: never[] = [];
  return { aiChatRoomsStore: { subscribe: () => () => {}, getSnapshot: () => rooms } };
});
vi.mock("@/components/editor/AiEditPanel", () => ({ AiEditPanel: () => <button data-ai="true">AI</button> }));
vi.mock("@/components/editor/PageCanvasEditor", () => ({ PageCanvasEditor: ({ document, zoom, publishesSessionPresence }: { document: SigmaDocument; zoom: number; publishesSessionPresence?: boolean }) => {
  const session = useDocumentSession();
  const writable = useDocumentWritable();
  return <div className="page-canvas" data-preview="true" data-writable={String(writable)} data-zoom={zoom} data-presence={String(publishesSessionPresence)} data-asset={session?.resolveAssetSource?.("asset")}>{document.metadata.title}</div>;
} }));
const paneView = { zoom: 125, showComments: false, showResolvedComments: false, commentAuthor: { name: "guest", avatarUrl: null } };

function signal() {
  const listeners = new Set<() => void>();
  return { listeners, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, emit: () => { for (const fn of listeners) fn(); } };
}
const doc = (title: string) => ({ metadata: { title }, content: [] }) as unknown as SigmaDocument;
function fixture(writable = true) {
  const changes = signal(); const assets = signal(); const authority = signal();
  let current = doc("initial"); let asset = "first";
  const session: DocumentSession = { writable, project: () => current, change: vi.fn(), restore: vi.fn(), flush: vi.fn(), subscribe: changes.subscribe, subscribeAssets: assets.subscribe, resolveAssetSource: () => asset };
  const host: DocumentSessionHost = { get: () => session, subscribeAuthority: authority.subscribe };
  return { session, host, changes, assets, authority, update: (title: string) => { current = doc(title); changes.emit(); }, asset: () => { asset = "second"; assets.emit(); } };
}
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  bridge.load.mockResolvedValue({ ok: true, document: doc("local") });
});
afterEach(() => { act(() => root.unmount()); container.remove(); bridge.listeners.clear(); vi.clearAllMocks(); });
async function render(host?: DocumentSessionHost, ai = false, metadata: DocumentMetadata[] = [], onFocusGroup = vi.fn(), focused = true) {
  const layout = createSingleGroupWorkspaceLayout(["target"], "target");
  if (!focused) layout.focusedGroupId = "another-group";
  const tab = ai ? aiWorkspaceTab("room", "target") : documentWorkspaceTab("target");
  layout.groups[0].tabs = [tab]; layout.groups[0].activeTabId = tab.id;
  await act(async () => root.render(
    <DocumentSessionContext.Provider value={fixture().session}><DocumentWritableContext.Provider value={true}>
      <WorkspaceTabGroupGrid layout={layout} metadata={metadata} activeFileId="other" sessionHost={host} paneView={paneView} onFocusGroup={onFocusGroup} onMoveTab={vi.fn()} onSplitTab={vi.fn()} onResizeSplit={vi.fn()}><div>active editor</div></WorkspaceTabGroupGrid>
    </DocumentWritableContext.Provider></DocumentSessionContext.Provider>,
  ));
}
it("denies detached viewer AI despite writable active document context and reacts to authority", async () => {
  const f = fixture(false); await render(f.host, true);
  expect(container.querySelector("[data-ai]")).toBeNull();
  expect(container.querySelector("[data-preview]")?.getAttribute("data-writable")).toBe("false");
  Object.defineProperty(f.session, "writable", { value: true });
  await act(async () => f.authority.emit());
  expect(container.querySelector("[data-ai]")).not.toBeNull();
});
it("denies lazy shared AI before a session is available", async () => {
  await render({ get: () => undefined }, true, [{ fileId: "target", sharing: { capabilities: { editDocument: false } } } as DocumentMetadata]);
  expect(container.querySelector("[data-ai]")).toBeNull();
  expect(container.querySelector("[data-preview]")?.getAttribute("data-writable")).toBe("false");
});
it("updates background content and resolves assets using the target session", async () => {
  const f = fixture(); await render(f.host);
  expect(container.querySelector("[data-preview]")?.textContent).toBe("initial");
  await act(async () => f.update("remote change"));
  expect(container.querySelector("[data-preview]")?.textContent).toBe("remote change");
  await act(async () => f.asset());
  expect(container.querySelector("[data-preview]")?.getAttribute("data-asset")).toBe("second");
  expect(f.session.change).not.toHaveBeenCalled();
});
it("refreshes local previews only for matching document notifications", async () => {
  await render(); bridge.load.mockResolvedValue({ ok: true, document: doc("saved change") });
  await act(async () => { for (const listener of bridge.listeners) listener({ type: "document", fileId: "other" }); });
  expect(container.querySelector("[data-preview]")?.textContent).toBe("local");
  await act(async () => { for (const listener of bridge.listeners) listener({ type: "document", fileId: "target" }); });
  expect(container.querySelector("[data-preview]")?.textContent).toBe("saved change");
});
it("releases session, asset, authority and storage subscriptions when the pane closes", async () => {
  const f = fixture(); await render(f.host);
  for (const listeners of [f.changes.listeners, f.assets.listeners, f.authority.listeners, bridge.listeners]) expect(listeners.size).toBe(1);
  await act(async () => root.render(null));
  for (const listeners of [f.changes.listeners, f.assets.listeners, f.authority.listeners, bridge.listeners]) expect(listeners.size).toBe(0);
});
it("does not replace a newer save notification with an older pending local read", async () => {
  let finishOld!: (result: { ok: boolean; document: SigmaDocument }) => void;
  bridge.load.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await render();
  bridge.load.mockResolvedValue({ ok: true, document: doc("newer save") });
  await act(async () => { for (const listener of bridge.listeners) listener({ type: "document", fileId: "target" }); });
  await act(async () => finishOld({ ok: true, document: doc("stale read") }));
  expect(container.querySelector("[data-preview]")?.textContent).toBe("newer save");
});
it("retains the mounted detached file and releases it when the pane disappears", async () => {
  const f = fixture();
  const release = vi.fn();
  f.host.retainVisibleFile = vi.fn(() => release);
  await render(f.host);
  expect(f.host.retainVisibleFile).toHaveBeenCalledWith("target");
  expect(release).not.toHaveBeenCalled();
  await act(async () => root.render(<div />));
  expect(release).toHaveBeenCalledTimes(1);
});
it("shows an unfocused document as a read-only editing surface and hands off its scroll and click point", async () => {
  const f = fixture(); const onFocusGroup = vi.fn();
  await render(f.host, false, [], onFocusGroup, false);
  const surface = container.querySelector<HTMLElement>("[data-preview]")!;
  // The same editor surface at the editor's zoom, never writable and never announcing presence.
  expect(surface.getAttribute("data-zoom")).toBe("125");
  expect(surface.getAttribute("data-writable")).toBe("false");
  expect(surface.getAttribute("data-presence")).toBe("false");
  expect(surface.getAttribute("data-asset")).toBe("first");
  const scroller = container.querySelector<HTMLElement>(".workspace-passive-editor")!;
  scroller.scrollTop = 240;
  await act(async () => surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 30, clientY: 40 })));
  expect(onFocusGroup).toHaveBeenCalledWith(expect.any(String), { scrollTop: 240, scrollLeft: 0, point: { x: 30, y: 40 } });
});
