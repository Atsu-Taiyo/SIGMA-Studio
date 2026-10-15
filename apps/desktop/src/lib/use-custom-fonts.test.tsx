// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalFontBridge, LocalFontCatalog } from "./local-font-contracts";
import { useCustomFonts } from "./use-custom-fonts";

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useCustomFonts>;

const custom = { id: "font_1", displayName: "My Font", fileName: "f.ttf", cssFamily: '"Sigma Custom Font font_1"', importedAt: "2026-10-01T00:00:00.000Z", url: "file:///f.ttf" };
const face = { family: "Example", fullName: "Example Regular", postscriptName: "Example-Regular", style: "Regular" };

function Probe() {
  const result = useCustomFonts();
  useLayoutEffect(() => { latest = result; });
  return null;
}

function install(catalog: LocalFontCatalog | Error) {
  const list = vi.fn(async () => { if (catalog instanceof Error) throw catalog; return catalog; });
  (window as Window & { sigmaLocalFonts?: LocalFontBridge }).sigmaLocalFonts = { list };
  return list;
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
  delete (window as Window & { sigmaLocalFonts?: unknown }).sigmaLocalFonts;
  vi.restoreAllMocks();
});

describe("useCustomFonts with the local font bridge", () => {
  it("passes the PC's faces and the added fonts through", async () => {
    install({ ok: true, systemFonts: [face], fonts: [custom] });
    await act(async () => root.render(<Probe />));
    expect(latest.systemFonts).toEqual([face]);
    expect(latest.customFonts).toEqual([custom]);
  });

  it("keeps the PC's fonts unknown (null) when the host could not read them, and still loads the added fonts", async () => {
    install({ ok: true, systemFonts: null, fonts: [custom] });
    await act(async () => root.render(<Probe />));
    expect(latest.systemFonts).toBeNull();
    expect(latest.customFonts).toEqual([custom]);
  });

  it("refreshes on window focus", async () => {
    const list = install({ ok: true, systemFonts: [face], fonts: [] });
    await act(async () => root.render(<Probe />));
    list.mockResolvedValueOnce({ ok: true, systemFonts: [face, { ...face, family: "Installed Later" }], fonts: [] });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(latest.systemFonts?.map((item) => item.family)).toEqual(["Example", "Installed Later"]);
  });

  it("keeps what it had when the host fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = install({ ok: true, systemFonts: [face], fonts: [custom] });
    await act(async () => root.render(<Probe />));
    list.mockRejectedValueOnce(new Error("down"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(latest.systemFonts).toEqual([face]);
    expect(latest.customFonts).toEqual([custom]);
  });
});
