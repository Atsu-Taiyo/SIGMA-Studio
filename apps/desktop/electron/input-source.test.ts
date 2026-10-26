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
    expect(execFile.mock.calls[0]?.[2]).toEqual({ timeout: 250, windowsHide: true });

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
    expect(execFile.mock.calls[1]?.[2]).toEqual({ timeout: 260, windowsHide: true });
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
      callback(null, _args.join("\n").includes("$targetOpen =")
        ? '{"restored":true}\n'
        : '{"imeOpen":true,"ascii":true,"windowHandle":"123456"}\n', "");
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
    const switchScript = execFile.mock.calls[0]?.[1].at(-1) ?? "";
    expect(switchScript).toContain("ImmGetDefaultIMEWnd");
    expect(switchScript).toContain("GetGUIThreadInfo");
    expect(switchScript).toContain("processId != expectedProcessId");
    expect(switchScript).toContain(`GetImeWindow($hwnd, ${process.pid})`);
    expect(switchScript).toContain("SendMessageTimeoutW");
    expect(switchScript).not.toContain("ImmGetContext");
    expect(switchScript).toContain("$ErrorActionPreference = 'Stop'");
    expect(execFile.mock.calls[0]?.[2]).toEqual({ timeout: 300, windowsHide: true });

    if (!result.ok || !result.restoreToken) {
      throw new Error("restore token missing");
    }
    await expect(restorePreviousInputSource(result.restoreToken, {
      execFile,
      timeoutMs: 310,
    })).resolves.toEqual({ ok: true, platform: "win32", restored: true });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[0]).toBe("powershell.exe");
    expect(execFile.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("$targetOpen = $true");
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("123456");
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("$hwnd.ToInt64() -ne $expectedWindow");
    expect(execFile.mock.calls[1]?.[1].join("\n")).toContain("$currentOpen -ne $false");
    expect(execFile.mock.calls[1]?.[2]).toEqual({ timeout: 310, windowsHide: true });
  });

  it("does not restore Windows IME state when the user reopened IME during math editing", async () => {
    const execFile = vi.fn()
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, '{"imeOpen":true,"ascii":true,"windowHandle":"123456"}\n', "");
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

  it.each([
    '{"imeOpen":null}',
    '{"imeOpen":true}',
    '{"imeOpen":true,"ascii":false,"windowHandle":"123456"}',
    '{"imeOpen":true,"ascii":true,"windowHandle":"0"}',
    '{"imeOpen":true,"ascii":true,"windowHandle":"invalid"}',
    "",
    "invalid JSON",
  ])("does not report an unverified Windows switch as successful: %s", async (stdout) => {
    const execFile = vi.fn((_file, _args, _options, callback) => callback(null, stdout, ""));
    await expect(switchToAsciiInputSource({ execFile, platform: "win32" })).resolves.toMatchObject({
      ok: false,
      platform: "win32",
      error: expect.any(String),
    });
  });

  it("allows Windows helper startup time and skips restore when IME was already off", async () => {
    const execFile = vi.fn((_file, _args, _options, callback) => (
      callback(null, '{"imeOpen":false,"ascii":true,"windowHandle":"123456"}', "")
    ));
    const result = await switchToAsciiInputSource({ execFile, platform: "win32" });
    expect(execFile.mock.calls[0]?.[2]).toEqual({ timeout: 5000, windowsHide: true });
    if (!result.ok || !result.restoreToken) throw new Error("restore token missing");
    await expect(restorePreviousInputSource(result.restoreToken, { execFile })).resolves.toEqual({
      ok: true, platform: "win32", restored: false,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    await expect(restorePreviousInputSource(result.restoreToken, { execFile })).resolves.toMatchObject({
      ok: false, skipped: true,
    });
  });

  it("does not treat missing Windows restore confirmation as success", async () => {
    const execFile = vi.fn()
      .mockImplementationOnce((_file, _args, _options, callback) => (
        callback(null, '{"imeOpen":true,"ascii":true,"windowHandle":"123456"}', "")
      ))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, "", ""));
    const result = await switchToAsciiInputSource({ execFile, platform: "win32" });
    if (!result.ok || !result.restoreToken) throw new Error("restore token missing");
    await expect(restorePreviousInputSource(result.restoreToken, { execFile })).resolves.toEqual({
      ok: true, platform: "win32", restored: false,
    });
  });

  it("reports Windows helper errors without throwing", async () => {
    const execFile = vi.fn((_file, _args, _options, callback) => (
      callback(new Error("PowerShell failed"), "", "IME did not switch")
    ));
    await expect(switchToAsciiInputSource({ execFile, platform: "win32" })).resolves.toEqual({
      ok: false, platform: "win32", error: "IME did not switch",
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
