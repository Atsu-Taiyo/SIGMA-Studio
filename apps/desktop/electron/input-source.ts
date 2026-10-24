import { execFile as nodeExecFile } from "node:child_process";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export type DesktopInputSourceSwitchResult =
  | { ok: true; platform: NodeJS.Platform; restoreToken?: string }
  | { ok: false; error: string; platform: NodeJS.Platform; skipped?: boolean };

export type DesktopInputSourceRestoreResult =
  | { ok: true; platform: NodeJS.Platform; restored: boolean }
  | { ok: false; error: string; platform: NodeJS.Platform; skipped?: boolean };

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type MacRestoreState = {
  asciiInputSourceId?: string | null;
  inputSourceId?: string | null;
  language?: string | null;
  platform: "darwin";
};

type WindowsRestoreState = {
  imeOpen: boolean;
  windowHandle: string;
  platform: "win32";
};

type RestoreState = MacRestoreState | WindowsRestoreState;

const MACOS_ASCII_INPUT_SOURCE_SCRIPT = `
ObjC.import("Carbon");

function stringProperty(source, property) {
  const value = $.TISGetInputSourceProperty(source, property);
  if (!value) {
    return null;
  }
  return ObjC.unwrap(ObjC.castRefToObject(value));
}

const current = $.TISCopyCurrentKeyboardInputSource();
const previousInputSourceId = current ? stringProperty(current, $.kTISPropertyInputSourceID) : null;
const languagesRef = current ? $.TISGetInputSourceProperty(current, $.kTISPropertyInputSourceLanguages) : null;
const languages = languagesRef ? ObjC.deepUnwrap(ObjC.castRefToObject(languagesRef)) : [];
const previousLanguage = Array.isArray(languages) && languages.length > 0 ? languages[0] : null;

const source = $.TISCopyInputSourceForLanguage($("en"));
if (!source) {
  throw new Error("English input source was not found.");
}
const asciiInputSourceId = stringProperty(source, $.kTISPropertyInputSourceID);
const status = $.TISSelectInputSource(source);
if (status !== 0) {
  throw new Error("TISSelectInputSource failed: " + status);
}

console.log(JSON.stringify({
  asciiInputSourceId: asciiInputSourceId,
  inputSourceId: previousInputSourceId,
  language: previousLanguage
}));
`;

const MACOS_RESTORE_INPUT_SOURCE_SCRIPT = `
function run(argv) {
  ObjC.import("Carbon");
  const language = argv[0] || "en";
  const expectedCurrentInputSourceId = argv[1] || "";

  function stringProperty(source, property) {
    const value = $.TISGetInputSourceProperty(source, property);
    if (!value) {
      return null;
    }
    return ObjC.unwrap(ObjC.castRefToObject(value));
  }

  const current = $.TISCopyCurrentKeyboardInputSource();
  const currentInputSourceId = current ? stringProperty(current, $.kTISPropertyInputSourceID) : null;
  if (expectedCurrentInputSourceId && currentInputSourceId !== expectedCurrentInputSourceId) {
    console.log(JSON.stringify({ restored: false }));
    return;
  }

  const source = $.TISCopyInputSourceForLanguage($(language));
  if (!source) {
    throw new Error("Input source was not found for language: " + language);
  }
  const status = $.TISSelectInputSource(source);
  if (status !== 0) {
    throw new Error("TISSelectInputSource failed: " + status);
  }
  console.log(JSON.stringify({ restored: true }));
}
`;

// HIMC belongs to the target process. A PowerShell helper must send commands to
// that thread's IME window instead of calling ImmGetContext across processes.
// https://learn.microsoft.com/windows/win32/api/imm/nf-imm-immgetdefaultimewnd
const WINDOWS_IME_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SigmaStudioIme {
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect {
    public int left, top, right, bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct GuiThreadInfo {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public Rect rcCaret;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);

  [DllImport("imm32.dll")]
  private static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr SendMessageTimeoutW(
    IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out UIntPtr result);

  public static IntPtr GetImeWindow(IntPtr foreground, uint expectedProcessId) {
    uint processId;
    uint threadId = GetWindowThreadProcessId(foreground, out processId);
    // The helper starts asynchronously. Never change another app's IME if the
    // user switched windows while PowerShell was starting.
    if (processId != expectedProcessId) {
      throw new InvalidOperationException("Sigma Studio is no longer the foreground application.");
    }
    var info = new GuiThreadInfo();
    info.cbSize = (uint)Marshal.SizeOf(typeof(GuiThreadInfo));
    if (threadId == 0 || !GetGUIThreadInfo(threadId, ref info) || info.hwndFocus == IntPtr.Zero) {
      throw new InvalidOperationException("Focused input window was not found.");
    }
    IntPtr imeWindow = ImmGetDefaultIMEWnd(info.hwndFocus);
    if (imeWindow == IntPtr.Zero) {
      throw new InvalidOperationException("IME window was not found.");
    }
    return imeWindow;
  }

  private static ulong SendImeCommand(IntPtr imeWindow, uint command, int value) {
    UIntPtr result;
    // WM_IME_CONTROL; SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, bounded to 200ms.
    if (SendMessageTimeoutW(imeWindow, 0x0283, new UIntPtr(command), new IntPtr(value),
        0x0022, 200, out result) == IntPtr.Zero) {
      throw new InvalidOperationException("IME control request failed or timed out.");
    }
    return result.ToUInt64();
  }

  public static bool GetOpenStatus(IntPtr imeWindow) {
    return SendImeCommand(imeWindow, 0x0005, 0) != 0; // IMC_GETOPENSTATUS
  }

  public static void SetOpenStatus(IntPtr imeWindow, bool open) {
    SendImeCommand(imeWindow, 0x0006, open ? 1 : 0); // IMC_SETOPENSTATUS
    if (GetOpenStatus(imeWindow) != open) {
      throw new InvalidOperationException("IME did not switch to the requested input mode.");
    }
  }
}
"@
`;

const WINDOWS_ASCII_INPUT_SOURCE_SCRIPT = `${WINDOWS_IME_HELPER_SCRIPT}
$hwnd = [SigmaStudioIme]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  throw "Foreground window was not found."
}

$imeWindow = [SigmaStudioIme]::GetImeWindow($hwnd, ${process.pid})
$wasOpen = [SigmaStudioIme]::GetOpenStatus($imeWindow)
if ([SigmaStudioIme]::GetForegroundWindow() -ne $hwnd) {
  throw "Foreground window changed before switching input mode."
}
if ($wasOpen) {
  [SigmaStudioIme]::SetOpenStatus($imeWindow, $false)
}
@{ imeOpen = $wasOpen; ascii = $true; windowHandle = $hwnd.ToInt64().ToString() } | ConvertTo-Json -Compress
`;

function windowsRestoreInputSourceScript(state: WindowsRestoreState): string {
  // windowHandle is validated as a decimal integer before retaining the state.
  // Embed typed values: powershell.exe -Command does not bind trailing CLI
  // arguments to $args the way -File does.
  return `${WINDOWS_IME_HELPER_SCRIPT}
$targetOpen = $${state.imeOpen}
$expectedWindow = [long]${state.windowHandle}
$hwnd = [SigmaStudioIme]::GetForegroundWindow()
if ($hwnd.ToInt64() -ne $expectedWindow) {
  @{ restored = $false } | ConvertTo-Json -Compress
  exit 0
}

$imeWindow = [SigmaStudioIme]::GetImeWindow($hwnd, ${process.pid})
$currentOpen = [SigmaStudioIme]::GetOpenStatus($imeWindow)
if ($currentOpen -ne $false) {
  @{ restored = $false } | ConvertTo-Json -Compress
  exit 0
}

if ([SigmaStudioIme]::GetForegroundWindow() -ne $hwnd) {
  @{ restored = $false } | ConvertTo-Json -Compress
  exit 0
}
[SigmaStudioIme]::SetOpenStatus($imeWindow, $targetOpen)
@{ restored = $true } | ConvertTo-Json -Compress
`;
}

const DEFAULT_SWITCH_TIMEOUT_MS = 1200;
// Windows PowerShell cold start and Add-Type compilation can exceed 1.2s.
const WINDOWS_SWITCH_TIMEOUT_MS = 5000;

let nextRestoreToken = 1;
const restoreStates = new Map<string, RestoreState>();

export function switchToAsciiInputSource(options: {
  execFile?: ExecFileLike;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
} = {}): Promise<DesktopInputSourceSwitchResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    return Promise.resolve({
      ok: false,
      platform,
      skipped: true,
      error: te("electron.inputSource.unsupported"),
    });
  }

  const execFile = options.execFile ?? nodeExecFile;
  const timeoutMs = options.timeoutMs ?? (platform === "win32" ? WINDOWS_SWITCH_TIMEOUT_MS : DEFAULT_SWITCH_TIMEOUT_MS);
  return platform === "darwin"
    ? switchMacInputSourceToAscii({ execFile, timeoutMs })
    : switchWindowsInputSourceToAscii({ execFile, timeoutMs });
}

export function restorePreviousInputSource(
  restoreToken: string,
  options: {
    execFile?: ExecFileLike;
    timeoutMs?: number;
  } = {},
): Promise<DesktopInputSourceRestoreResult> {
  const state = restoreStates.get(restoreToken);
  if (!state) {
    return Promise.resolve({
      ok: false,
      platform: process.platform,
      skipped: true,
      error: te("electron.inputSource.restoreMissing"),
    });
  }

  restoreStates.delete(restoreToken);
  const execFile = options.execFile ?? nodeExecFile;
  const timeoutMs = options.timeoutMs ?? (state.platform === "win32" ? WINDOWS_SWITCH_TIMEOUT_MS : DEFAULT_SWITCH_TIMEOUT_MS);
  return state.platform === "darwin"
    ? restoreMacInputSource(state, { execFile, timeoutMs })
    : restoreWindowsInputSource(state, { execFile, timeoutMs });
}

function switchMacInputSourceToAscii({
  execFile,
  timeoutMs,
}: {
  execFile: ExecFileLike;
  timeoutMs: number;
}): Promise<DesktopInputSourceSwitchResult> {
  return runInputSourceCommand({
    args: ["-l", "JavaScript", "-e", MACOS_ASCII_INPUT_SOURCE_SCRIPT],
    execFile,
    file: "/usr/bin/osascript",
    platform: "darwin",
    timeoutMs,
  }).then((result) => {
    if (!result.ok) {
      return result;
    }

    const parsed = parseRestoreState(result.stdout);
    const restoreToken = rememberRestoreState({
      asciiInputSourceId: typeof parsed?.asciiInputSourceId === "string" ? parsed.asciiInputSourceId : null,
      inputSourceId: typeof parsed?.inputSourceId === "string" ? parsed.inputSourceId : null,
      language: typeof parsed?.language === "string" ? parsed.language : null,
      platform: "darwin",
    });
    return { ok: true, platform: "darwin" as const, restoreToken };
  });
}

function switchWindowsInputSourceToAscii({
  execFile,
  timeoutMs,
}: {
  execFile: ExecFileLike;
  timeoutMs: number;
}): Promise<DesktopInputSourceSwitchResult> {
  return runInputSourceCommand({
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ASCII_INPUT_SOURCE_SCRIPT],
    execFile,
    file: "powershell.exe",
    platform: "win32",
    timeoutMs,
  }).then((result) => {
    if (!result.ok) {
      return result;
    }

    const parsed = parseRestoreState(result.stdout);
    if (typeof parsed?.imeOpen !== "boolean" || parsed.ascii !== true
      || typeof parsed.windowHandle !== "string" || !/^[1-9]\d*$/.test(parsed.windowHandle)) {
      return { ok: false, platform: "win32" as const, error: te("electron.inputSource.switchFailed") };
    }
    const restoreToken = rememberRestoreState({
      imeOpen: parsed.imeOpen,
      windowHandle: parsed.windowHandle,
      platform: "win32",
    });
    return { ok: true, platform: "win32" as const, restoreToken };
  });
}

function restoreMacInputSource(
  state: MacRestoreState,
  {
    execFile,
    timeoutMs,
  }: {
    execFile: ExecFileLike;
    timeoutMs: number;
  },
): Promise<DesktopInputSourceRestoreResult> {
  if (!state.language) {
    return Promise.resolve({ ok: true, platform: "darwin", restored: false });
  }

  return runInputSourceCommand({
    args: ["-l", "JavaScript", "-e", MACOS_RESTORE_INPUT_SOURCE_SCRIPT, state.language, state.asciiInputSourceId ?? ""],
    execFile,
    file: "/usr/bin/osascript",
    platform: "darwin",
    timeoutMs,
  }).then((result) => (
    result.ok
      ? { ok: true, platform: "darwin" as const, restored: getRestoredFlag(result.stdout) }
      : result
  ));
}

function restoreWindowsInputSource(
  state: WindowsRestoreState,
  {
    execFile,
    timeoutMs,
  }: {
    execFile: ExecFileLike;
    timeoutMs: number;
  },
): Promise<DesktopInputSourceRestoreResult> {
  if (!state.imeOpen) {
    return Promise.resolve({ ok: true, platform: "win32", restored: false });
  }

  return runInputSourceCommand({
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsRestoreInputSourceScript(state),
    ],
    execFile,
    file: "powershell.exe",
    platform: "win32",
    timeoutMs,
  }).then((result) => (
    result.ok
      ? { ok: true, platform: "win32" as const, restored: parseRestoreState(result.stdout)?.restored === true }
      : result
  ));
}

function rememberRestoreState(state: RestoreState): string {
  const token = `input-source-${Date.now().toString(36)}-${(nextRestoreToken++).toString(36)}`;
  restoreStates.set(token, state);
  return token;
}

function parseRestoreState(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (!line) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getRestoredFlag(stdout: string): boolean {
  const parsed = parseRestoreState(stdout);
  return typeof parsed?.restored === "boolean" ? parsed.restored : true;
}

function runInputSourceCommand({
  args,
  execFile,
  file,
  platform,
  timeoutMs,
}: {
  args: string[];
  execFile: ExecFileLike;
  file: string;
  platform: "darwin" | "win32";
  timeoutMs: number;
}): Promise<
  | { ok: true; platform: "darwin" | "win32"; stdout: string }
  | { ok: false; error: string; platform: "darwin" | "win32" }
> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, platform, stdout });
          return;
        }

        const detail = stderr.trim() || error.message;
        resolve({
          ok: false,
          platform,
          error: detail || te("electron.inputSource.switchFailed"),
        });
      },
    );
  });
}
