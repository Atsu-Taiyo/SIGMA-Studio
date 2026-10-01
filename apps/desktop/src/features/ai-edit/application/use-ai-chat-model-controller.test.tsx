// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopAiModelCatalog } from "@/types/desktop";
import { useAiChatModelController } from "./use-ai-chat-model-controller";

vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let controller: ReturnType<typeof useAiChatModelController>;
function Probe() {
  const current = useAiChatModelController();
  useLayoutEffect(() => { controller = current; });
  return null;
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("ignores a late provider response and persists the selected runtime model across remount", async () => {
  const old = Promise.withResolvers<DesktopAiModelCatalog>();
  const current = Promise.withResolvers<DesktopAiModelCatalog>();
  vi.mocked(getDesktopBridge).mockReturnValue({
    codex: { listModels: () => old.promise }, claude: { listModels: () => current.promise },
  } as unknown as ReturnType<typeof getDesktopBridge>);
  await act(async () => root.render(<Probe />));
  await act(async () => controller.setProvider("claude"));
  await act(async () => current.resolve({ models: [{ id: "claude-fixture", label: "Fixture", isDefault: true, supportedReasoningEfforts: [{ id: "high" }] }] }));
  expect(controller.provider).toBe("claude");
  expect(controller.claudeModel).toBe("claude-fixture");
  await act(async () => old.resolve({ models: [{ id: "stale-fixture", label: "Old", isDefault: true }] }));
  expect(controller.runtimeModelCatalogs.chatgpt).toBeUndefined();
  expect(controller.claudeModel).toBe("claude-fixture");
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(controller.provider).toBe("claude");
  expect(controller.claudeModel).toBe("claude-fixture");
});
