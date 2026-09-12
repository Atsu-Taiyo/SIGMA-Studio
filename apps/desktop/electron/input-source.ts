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
  options: { timeout: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type MacRestoreState = {
  asciiInputSourceId?: string | null;
  inputSourceId?: string | null;
  language?: string | null;
  platform: "darwin";
};

type WindowsRestoreState = {
  imeOpen: boolean | null;
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

const WINDOWS_ASCII_INPUT_SOURCE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SigmaStudioIme {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("imm32.dll")]
  public static extern IntPtr ImmGetContext(IntPtr hWnd);

  [DllImport("imm32.dll")]
  public static extern bool ImmGetOpenStatus(IntPtr hIMC);

  [DllImport("imm32.dll")]
  public static extern bool ImmSetOpenStatus(IntPtr hIMC, bool fOpen);

  [DllImport("imm32.dll")]
  public static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);
}
"@

$hwnd = [SigmaStudioIme]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  throw "Foreground window was not found."
}

$context = [SigmaStudioIme]::ImmGetContext($hwnd)
if ($context -eq [IntPtr]::Zero) {
  @{ imeOpen = $null } | ConvertTo-Json -Compress
  exit 0
}

$wasOpen = [SigmaStudioIme]::ImmGetOpenStatus($context)
[void][SigmaStudioIme]::ImmSetOpenStatus($context, $false)
[void][SigmaStudioIme]::ImmReleaseContext($hwnd, $context)
@{ imeOpen = $wasOpen } | ConvertTo-Json -Compress
`;

const WINDOWS_RESTORE_INPUT_SOURCE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SigmaStudioIme {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("imm32.dll")]
  public static extern IntPtr ImmGetContext(IntPtr hWnd);

  [DllImport("imm32.dll")]
  public static extern bool ImmSetOpenStatus(IntPtr hIMC, bool fOpen);

  [DllImport("imm32.dll")]
  public static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);
}
"@

$targetOpen = [System.Boolean]::Parse($args[0])
$hwnd = [SigmaStudioIme]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  throw "Foreground window was not found."
}

$context = [SigmaStudioIme]::ImmGetContext($hwnd)
if ($context -eq [IntPtr]::Zero) {
  @{ restored = $false } | ConvertTo-Json -Compress
  exit 0
}

$currentOpen = [SigmaStudioIme]::ImmGetOpenStatus($context)
if ($currentOpen -ne $false) {
  [void][SigmaStudioIme]::ImmReleaseContext($hwnd, $context)
  @{ restored = $false } | ConvertTo-Json -Compress
  exit 0
}

[void][SigmaStudioIme]::ImmSetOpenStatus($context, $targetOpen)
[void][SigmaStudioIme]::ImmReleaseContext($hwnd, $context)
@{ restored = $true } | ConvertTo-Json -Compress
`;

const DEFAULT_SWITCH_TIMEOUT_MS = 1200;

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
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
    const restoreToken = rememberRestoreState({
      imeOpen: typeof parsed?.imeOpen === "boolean" ? parsed.imeOpen : null,
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
  if (state.imeOpen === null) {
    return Promise.resolve({ ok: true, platform: "win32", restored: false });
  }

  return runInputSourceCommand({
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_RESTORE_INPUT_SOURCE_SCRIPT,
      String(state.imeOpen),
    ],
    execFile,
    file: "powershell.exe",
    platform: "win32",
    timeoutMs,
  }).then((result) => (
    result.ok
      ? { ok: true, platform: "win32" as const, restored: getRestoredFlag(result.stdout) }
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
      { timeout: timeoutMs },
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
