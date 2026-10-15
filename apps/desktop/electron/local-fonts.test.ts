import { describe, expect, it, vi } from "vitest";

const trusted = vi.hoisted(() => ({ value: true }));
vi.mock("./trusted-ipc", () => ({ isTrustedMainSender: () => trusted.value }));

import { LocalFontService } from "./local-fonts";

const row = (family: string, extra: Record<string, unknown> = {}) => ({
  family, fullName: `${family} Regular`, postscriptName: `${family.replace(/\s/g, "")}-Regular`, style: "Regular", ...extra,
});

function fakeContents(rows: unknown, options: { throws?: boolean; destroyed?: boolean } = {}) {
  const handlers: { check?: (...args: unknown[]) => boolean; request?: (...args: unknown[]) => void } = {};
  const session = {
    setPermissionCheckHandler: vi.fn((handler) => { handlers.check = handler; }),
    setPermissionRequestHandler: vi.fn((handler) => { handlers.request = handler; }),
  };
  const executeJavaScript = vi.fn(async () => { if (options.throws) throw new Error("denied"); return rows; });
  return { contents: { isDestroyed: () => Boolean(options.destroyed), mainFrame: {}, session, executeJavaScript } as never, session, executeJavaScript, handlers };
}

describe("LocalFontService", () => {
  it("returns only the names, styles and PostScript names of the installed faces", async () => {
    const { contents, executeJavaScript } = fakeContents([row("Example Mincho", { blob: "must not leak", bytes: [1, 2, 3] }), row("Example Gothic")]);
    const faces = await new LocalFontService().list(contents);
    expect(faces).toEqual([row("Example Mincho"), row("Example Gothic")]);
    // The page code reads names only; it never asks for the font data.
    const script = String((executeJavaScript.mock.calls[0] as unknown[])[0]);
    expect(script).toContain("queryLocalFonts()");
    expect(script).not.toMatch(/blob\(|arrayBuffer\(/);
    expect((executeJavaScript.mock.calls[0] as unknown[])[1]).toBe(true);
  });

  it.each([
    ["an empty list", []],
    ["no support in this runtime", null],
    ["a non-list", "fonts"],
    ["a row without a family", [{ fullName: "x", postscriptName: "x", style: "x" }]],
    ["a control character", [row("Bad\u0007Name")]],
    ["an over-long name", [row("a".repeat(257))]],
    ["too many rows", Array.from({ length: 8193 }, (_, index) => row(`Family ${index}`))],
  ])("reports null for %s, so the menu stays as it was", async (_name, rows) => {
    expect(await new LocalFontService().list(fakeContents(rows).contents)).toBeNull();
  });

  it("reports null when the page throws, and never throws itself", async () => {
    expect(await new LocalFontService().list(fakeContents([row("A")], { throws: true }).contents)).toBeNull();
  });

  it("refuses an untrusted or destroyed window without reading anything", async () => {
    const service = new LocalFontService();
    const { contents, executeJavaScript } = fakeContents([row("A")]);
    trusted.value = false;
    expect(await service.list(contents)).toBeNull();
    trusted.value = true;
    expect(await new LocalFontService().list(fakeContents([row("A")], { destroyed: true }).contents)).toBeNull();
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("shares one read between overlapping requests and caches a result for a moment", async () => {
    let now = 1_000;
    const service = new LocalFontService(() => now);
    const { contents, executeJavaScript } = fakeContents([row("A")]);
    const [first, second] = await Promise.all([service.list(contents), service.list(contents)]);
    expect(first).toEqual(second);
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    now += 500;
    await service.list(contents);
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    now += 5_000;
    await service.list(contents);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("allows the local-fonts permission to the trusted main frame only and leaves other permissions as Electron's default (allowed)", async () => {
    const { contents, session, handlers } = fakeContents([row("A")]);
    const service = new LocalFontService();
    await service.list(contents);
    await service.list(contents);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    const check = handlers.check as (sender: unknown, permission: string, origin: string, details?: unknown) => boolean;
    expect(check(contents, "local-fonts", "file:///", { isMainFrame: true })).toBe(true);
    expect(check(contents, "local-fonts", "file:///", { isMainFrame: false })).toBe(false);
    trusted.value = false;
    expect(check(contents, "local-fonts", "file:///", { isMainFrame: true })).toBe(false);
    trusted.value = true;
    expect(check(contents, "clipboard-sanitized-write", "file:///", {})).toBe(true);
    const request = handlers.request as (sender: unknown, permission: string, callback: (allowed: boolean) => void, details?: unknown) => void;
    const answers: boolean[] = [];
    request(contents, "local-fonts", (allowed) => answers.push(allowed), { isMainFrame: true });
    request(contents, "local-fonts", (allowed) => answers.push(allowed), { isMainFrame: false });
    request(contents, "notifications", (allowed) => answers.push(allowed), {});
    expect(answers).toEqual([true, false, true]);
  });
});
