// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "@/lib/desktop-bridge";
import type { SharedTargetRef } from "../model/catalog";
import { parseShareLink } from "../model/share-link";
import { SelectionLinkButton } from "./SelectionLinkButton";
import { copySelectionLink } from "./copy-selection-link";

let root: Root, container: HTMLDivElement;
const target = { kind: "document", catalogNodeId: "12345678-1234-4234-8234-123456789012" } as SharedTargetRef;
const anchor = { type: "textRange" as const, start: { blockId: "p", offset: 2 }, end: { blockId: "p", offset: 8 }, quote: '<script> & "選択"' };
const write = vi.fn(), writeText = vi.fn(), details = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); write.mockResolvedValue(undefined); writeText.mockResolvedValue(undefined);
  vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ write, writeText } as unknown as Clipboard);
  vi.spyOn(bridgeModule, "getDesktopBridge").mockReturnValue({ sharedCatalog: { details } } as unknown as ReturnType<typeof bridgeModule.getDesktopBridge>);
  details.mockResolvedValue({ target, sharing: { state: "active", capabilities: { read: true } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(() => root.render(<SelectionLinkButton target={target} anchor={anchor} title="教材" />));
const click = async () => { await act(async () => container.querySelector("button")!.click()); };

describe("selection link clipboard", () => {
  it("copies the complete URL and escaped HTML with the selected label", async () => {
    render(); await click();
    const data = write.mock.calls[0][0][0].data as Record<string, Blob>;
    const url = await data["text/plain"].text();
    expect(parseShareLink(url)).toEqual({ target, location: { ...anchor, quote: "" } });
    const html = await data["text/html"].text();
    const pasted = document.createElement("div"); pasted.innerHTML = html;
    expect(pasted.querySelector("a")?.href).toBe(url);
    expect(pasted.querySelector("a")?.textContent).toBe(anchor.quote);
    expect(pasted.querySelector("script")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
  it.each([{ state: "ended", capabilities: { read: true } }, { state: "active", capabilities: { read: false } }])("rechecks sharing before copying: %s", async sharing => {
    details.mockResolvedValue({ target, sharing }); render(); await click();
    expect(write).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
    details.mockResolvedValue({ target, sharing: { state: "active", capabilities: { read: true } } });
    await click(); expect(write).toHaveBeenCalledOnce();
  });
  it("falls back to the complete plain URL when rich clipboard is unavailable", async () => {
    write.mockRejectedValue(new Error("Unsupported"));
    await copySelectionLink("sigma-studio://share/document/x", "選択箇所");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("sigma-studio://share/document/x");
  });
});
