// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { AiModelMenuContents } from "./ai-model-menu-contents";

const t = createTranslator("ja", "ai");
const onSelectModel = vi.fn();
const onSelectEffort = vi.fn();
function Menu({ supported = true }: { supported?: boolean }) {
  const [modelFlyout, setModelFlyout] = useState<"model" | "effort" | null>(null);
  const [open, setOpen] = useState(true);
  return open ? <div className="ai-chat-model-menu">
    <AiModelMenuContents t={t} provider="claude" selectedProviderLabel="Claude"
      selectedModel="first" selectedModelLabel="First" reasoningEffort="low"
      selectedReasoningEffortLabel="Low" reasoningEffortSupported={supported}
      reasoningEfforts={["low", "high"]} modelOptions={[{ id: "first", label: "First", description: "First model details" }, { id: "second", label: "Second" }]}
      modelCatalogLoading={false} modelCatalogError={null} modelFlyout={modelFlyout}
      setModelFlyout={setModelFlyout} setModelMenuOpen={setOpen}
      onSelectModel={onSelectModel} onSelectEffort={onSelectEffort} />
  </div> : null;
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("shared model menu", () => {
  it("opens the model submenu by keyboard, delegates selection, and closes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Menu />));
      const trigger = container.querySelector("button")!;
      await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      const choices = container.querySelectorAll<HTMLButtonElement>('[data-kind="model"] button');
      expect(choices).toHaveLength(2);
      expect(choices[0].title).toBe("First model details");
      expect(choices[0].getAttribute("aria-checked")).toBe("true");
      await act(async () => choices[1].click());
      expect(onSelectModel).toHaveBeenCalledWith({ id: "second", label: "Second" });
      expect(container.querySelector(".ai-chat-model-menu")).toBeNull();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });

  it("keeps unsupported reasoning effort unavailable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Menu supported={false} />));
      const trigger = container.querySelectorAll<HTMLButtonElement>("button")[1];
      expect(trigger.disabled).toBe(true);
      await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(container.querySelector('[data-kind="effort"]')).toBeNull();
      expect(onSelectEffort).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });
});
