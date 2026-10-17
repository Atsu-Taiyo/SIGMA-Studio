// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DocumentSessionHost } from "@/features/document-session/contracts";
import { createBlankDocument } from "@/lib/blank-document";
import { SharedDocument } from "../model/shared-document";
import { toBase64 } from "../model/protocol";
import type { ObjectValue } from "../model/value";
import type { CollaborationBridge, SessionInfo } from "../model/bridge";
import { DesktopEditor } from "./DesktopEditor";

let host: DocumentSessionHost;
let bridge: CollaborationBridge;
vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: () => ({ collaboration: bridge }) }));
vi.mock("@/components/editor/EditorShell", () => ({ EditorShell: (props: { sessionHost: DocumentSessionHost }) => { host = props.sessionHost; return null; } }));
vi.mock("@/components/editor/editor-shell/editor-host", () => ({ EditorHostProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/editor/editor-shell/desktop-editor-host", () => ({ DESKTOP_EDITOR_HOST: {} }));
vi.mock("./SelectionLinkButton", () => ({ SelectionLinkButton: () => null }));
vi.mock("./SharingControls", () => ({ SharingControls: () => null }));
vi.mock("./CollaborationAccountControl", () => ({ CollaborationAccountControl: () => null }));

function snapshot(fileId: string): SessionInfo {
  const document = createBlankDocument();
  const shared = new SharedDocument();
  shared.initialize(JSON.parse(JSON.stringify(document)) as ObjectValue, { sharedDocumentId: fileId, epoch: 1 });
  const state = toBase64(shared.snapshot());
  shared.destroy();
  return { binding: { protocol: 1, epoch: 1, sharedDocumentId: fileId, docId: document.docId, localFileId: fileId }, state, role: "editor", status: "saved", actorId: "actor", assets: {} };
}

it("attaches B after reset while viewing A still waits for the network", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const a = snapshot("file-a");
  const b = snapshot("file-b");
  let snapshots = [a];
  let receive!: Parameters<CollaborationBridge["onEvent"]>[0];
  let finishView!: () => void;
  const viewing = new Promise<void>((resolve) => { finishView = resolve; });
  bridge = {
    info: vi.fn(async () => ({ configured: true, user: null, sessions: snapshots, restrictedFileIds: snapshots.map((s) => s.binding.localFileId) })),
    view: vi.fn(async (fileId) => { if (fileId === "file-a") await viewing; }),
    presence: vi.fn(async () => {}), visibleFiles: vi.fn(async () => {}),
    onEvent: vi.fn((listener) => { receive = listener; return () => {}; }),
  } as unknown as CollaborationBridge;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<DesktopEditor />));
    // This call is deliberately not awaited: A is still synchronizing.
    void host.setActiveFile!("file-a");
    await act(async () => receive({ type: "reset", fileId: "file-a" }));
    expect(bridge.view).toHaveBeenCalledWith("file-a");
    snapshots = [a, b];
    await act(async () => receive({ type: "reset", fileId: "file-b" }));
    await host.attachSession!("file-b", true);
    expect(host.get("file-b")).toBeDefined();
  } finally {
    await act(async () => { finishView(); });
    await act(async () => root.unmount());
  }
});
