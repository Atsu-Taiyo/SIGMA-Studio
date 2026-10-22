import { describe, expect, it, vi } from "vitest";

import { BrowserLocalFonts } from "./browser-local-fonts";

const face = { family: "Example", fullName: "Example Regular", postscriptName: "Example-Regular", style: "Regular" };
function permission(state: PermissionState) {
  return Object.assign(new EventTarget(), { state }) as PermissionStatus;
}
function setup(state: PermissionState = "prompt") {
  const access = permission(state);
  const queryLocalFonts = vi.fn(async () => [face]);
  const query = vi.fn(async () => access);
  const fonts = new BrowserLocalFonts({ queryLocalFonts, permissions: { query } });
  return { fonts, access, queryLocalFonts, query };
}

describe("browser OS fonts", () => {
  it("does not prompt on startup, and invokes enumeration synchronously on an explicit request", async () => {
    const { fonts, queryLocalFonts } = setup();
    await fonts.refresh();
    expect(queryLocalFonts).not.toHaveBeenCalled();
    const pending = fonts.request();
    expect(queryLocalFonts).toHaveBeenCalledOnce();
    await pending;
    expect(fonts.getSnapshot()).toEqual({ status: "granted", systemFonts: [face] });
  });

  it("restores a previous permission and projects names only, without reading font bytes", async () => {
    const { fonts, queryLocalFonts } = setup("granted");
    const blob = vi.fn();
    const fontWithBlob = { ...face, blob };
    queryLocalFonts.mockResolvedValue([fontWithBlob]);
    await fonts.refresh();
    expect(fonts.getSnapshot().systemFonts).toEqual([face]);
    expect(blob).not.toHaveBeenCalled();
  });

  it("clears revoked names and ignores an enumeration that completes after revocation", async () => {
    const { fonts, access, queryLocalFonts } = setup("granted");
    const changed = vi.fn();
    const unsubscribe = fonts.subscribe(changed);
    await fonts.refresh();
    let resolve!: (value: typeof face[]) => void;
    queryLocalFonts.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = fonts.request();
    Object.assign(access, { state: "denied" });
    access.dispatchEvent(new Event("change"));
    resolve([face]);
    await pending;
    expect(fonts.getSnapshot()).toEqual({ status: "denied", systemFonts: null });
    unsubscribe();
    const calls = changed.mock.calls.length;
    access.dispatchEvent(new Event("change"));
    expect(changed).toHaveBeenCalledTimes(calls);
  });

  it("handles denial and lets the user retry without removing the fixed font menu", async () => {
    const { fonts, queryLocalFonts } = setup();
    queryLocalFonts.mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"));
    await fonts.request();
    expect(fonts.getSnapshot()).toEqual({ status: "denied", systemFonts: null });
    await fonts.request();
    expect(fonts.getSnapshot().status).toBe("granted");
  });

  it("keeps denial visible when Chromium returns an empty list instead of rejecting", async () => {
    const { fonts, queryLocalFonts } = setup("denied");
    await fonts.refresh();
    queryLocalFonts.mockResolvedValueOnce([]);
    await fonts.request();
    expect(fonts.getSnapshot()).toEqual({ status: "denied", systemFonts: null });
  });

  it("asks for a click again when the host requires activation even with a previous permission", async () => {
    const { fonts, queryLocalFonts } = setup("granted");
    queryLocalFonts.mockRejectedValueOnce(new DOMException("Activation required", "SecurityError"));
    await fonts.refresh();
    expect(fonts.getSnapshot()).toEqual({ status: "prompt", systemFonts: null });
    await fonts.request();
    expect(fonts.getSnapshot().status).toBe("granted");
  });

  it("handles unsupported environments, empty results and malformed font names", async () => {
    const unsupported = new BrowserLocalFonts({});
    await unsupported.request();
    expect(unsupported.getSnapshot()).toEqual({ status: "unsupported", systemFonts: null });
    const { fonts, queryLocalFonts } = setup();
    queryLocalFonts.mockResolvedValueOnce([]);
    await fonts.request();
    expect(fonts.getSnapshot()).toEqual({ status: "empty", systemFonts: null });
    queryLocalFonts.mockResolvedValueOnce([{ ...face, family: "bad\nname" }]);
    await fonts.request();
    expect(fonts.getSnapshot()).toEqual({ status: "error", systemFonts: null });
  });
});
