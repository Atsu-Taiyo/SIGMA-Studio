import { describe, expect, it, vi } from "vitest";

import { restorePreviousInputSource, switchToAsciiInputSource } from "./input-source";

describe("switchToAsciiInputSource", () => {
  it("switches to an English input source on macOS", async () => {
    const execFile = vi.fn((
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "{\"inputSourceId\":\"com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese\",\"language\":\"ja\"}\n", "");
    });

    const result = await switchToAsciiInputSource({
      execFile,
      platform: "darwin",
      timeoutMs: 250,
    });

    expect(result).toMatchObject({ ok: true, platform: "darwin", restoreToken: expect.any(String) });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe("/usr/bin/osascript");
    expect(execFile.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-l", "JavaScript"]));
    expect(execFile.mock.calls[0]?.[1].join("\n")).toContain("TISSelectInputSource");
    expect(execFile.mock.calls[0]?.[2]).toEqual({ timeout: 250 });

    if (!result.ok || !result.restoreToken) {
      throw new Error("restore token missing");
    }
    await expect(restorePreviousInputSource(result.restoreToken, {
      execFile,
      timeoutMs: 260,
    })).resolves.toEqual({ ok: true, platform: "darwin", restored: true });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[0]).toBe("/usr/bin/osascript");
    expect(execFile.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-l", "JavaScript", "ja"]));
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("TISCopyInputSourceForLanguage");
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("currentInputSourceId !== expectedCurrentInputSourceId");
    expect(execFile.mock.calls[1]?.[2]).toEqual({ timeout: 260 });
  });

  it("does not restore macOS input source when the user changed it during math editing", async () => {
    const execFile = vi.fn()
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "{\"asciiInputSourceId\":\"com.apple.keylayout.ABC\",\"inputSourceId\":\"com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese\",\"language\":\"ja\"}\n", "");
      })
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "{\"restored\":false}\n", "");
      });

    const result = await switchToAsciiInputSource({
      execFile,
      platform: "darwin",
    });
    if (!result.ok || !result.restoreToken) {
      throw new Error("restore token missing");
    }

    await expect(restorePreviousInputSource(result.restoreToken, { execFile })).resolves.toEqual({
      ok: true,
      platform: "darwin",
      restored: false,
    });
    expect(execFile.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "ja",
      "com.apple.keylayout.ABC",
    ]));
  });

  it("turns off the foreground window IME on Windows", async () => {
    const execFile = vi.fn((
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "{\"imeOpen\":true}\n", "");
    });

    const result = await switchToAsciiInputSource({
      execFile,
      platform: "win32",
      timeoutMs: 300,
    });

    expect(result).toMatchObject({ ok: true, platform: "win32", restoreToken: expect.any(String) });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(execFile.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    expect(execFile.mock.calls[0]?.[1].join("\n")).toContain("ImmSetOpenStatus");
    expect(execFile.mock.calls[0]?.[2]).toEqual({ timeout: 300 });

    if (!result.ok || !result.restoreToken) {
      throw new Error("restore token missing");
    }
    await expect(restorePreviousInputSource(result.restoreToken, {
      execFile,
      timeoutMs: 310,
    })).resolves.toEqual({ ok: true, platform: "win32", restored: true });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[0]).toBe("powershell.exe");
    expect(execFile.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command", "true"]));
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("Boolean]::Parse");
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("$currentOpen -ne $false");
    expect(execFile.mock.calls[1]?.[2]).toEqual({ timeout: 310 });
  });

  it("does not restore Windows IME state when the user reopened IME during math editing", async () => {
    const execFile = vi.fn()
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "{\"imeOpen\":false}\n", "");
      })
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "{\"restored\":false}\n", "");
      });

    const result = await switchToAsciiInputSource({
      execFile,
      platform: "win32",
    });
    if (!result.ok || !result.restoreToken) {
      throw new Error("restore token missing");
    }

    await expect(restorePreviousInputSource(result.restoreToken, { execFile })).resolves.toEqual({
      ok: true,
      platform: "win32",
      restored: false,
    });
  });

  it("returns a skipped result on unsupported platforms", async () => {
    const execFile = vi.fn();

    await expect(switchToAsciiInputSource({
      execFile,
      platform: "linux",
    })).resolves.toMatchObject({
      ok: false,
      platform: "linux",
      skipped: true,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports macOS switch failures without throwing", async () => {
    const execFile = vi.fn((
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error("osascript failed"), "", "input source error");
    });

    await expect(switchToAsciiInputSource({
      execFile,
      platform: "darwin",
    })).resolves.toEqual({
      ok: false,
      platform: "darwin",
      error: "input source error",
    });
  });
});
