import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } from "electron";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";

import { LocalAiEditChatRoomStore } from "./ai-edit-chat-room-store";
import { LocalAiEditRunContextStore, sweepOrphanPerRunContextFiles } from "./ai-edit-run-context";
import { LocalAiEditRunLogStore } from "./ai-edit-run-log-store";
import {
  computePageContextCaptureRect,
  computePreviewBadgeLayout,
  createAiRenderBridgeServer,
  DEFAULT_MAX_LONG_SIDE_PX,
  LocalAiRenderBridgeStore,
  resolvePageContextCapturePage,
  type RenderPageContextRequest,
  type RenderPageContextResult,
  type RenderRect,
  type RenderSvgRequest,
  type RenderSvgResult,
} from "./ai-render-bridge";
import { LocalAiResourceStore } from "./ai-resource-store";
import { AppUpdateController } from "./app-updater";
import { CodexAppServerClient } from "./codex-app-server-client";
import { buildCodexAgentConfigToml, type CodexAgentConfigInput } from "./codex-mcp-config";
import { ClaudeStreamClient } from "./claude-stream-client";
import { buildClaudeMcpConfig } from "./claude-mcp-config";
import { GeminiHeadlessClient } from "./gemini-headless-client";
import {
  buildGeminiWorkspaceSettings,
  cleanupStaleAgentWorkspaceGeminiAttachments,
  cleanupStaleGeminiAttachments,
  writeGeminiWorkspaceSettings,
} from "./gemini-settings-config";
import {
  desktopSettingsPath,
  isAiWebSearchEnabled,
  readDesktopSettingsSync,
  resolveDesktopPromptLocale,
} from "./desktop-settings";
import { AUTO_APPLY_DEFER_MS, shouldDeferAutoApply } from "./auto-apply-defer";
import { LocalSigmaDocStore, type LocalStoreChangeEvent } from "./local-sigma-doc-store";
import { LocalMaterialStore } from "./local-material-store";
import { LocalTemplateStore } from "./local-template-store";
import {
  LocalMcpEditProposalStore,
  shouldAutoApplyProposal,
  type LocalMcpEditProposalChangeEvent,
} from "./local-sigma-doc-proposal-store";
import { registerAppIpc } from "./ipc/app";
import { registerShellIpc } from "./ipc/shell";
import { registerSettingsIpc } from "./ipc/settings";
import { assertUsableCliBinPath } from "./cli-spawn";
import { registerCodexIpc } from "./ipc/codex";
import { registerAiEditIpc } from "./ipc/ai-edit";
import { registerAiResourcesIpc } from "./ipc/ai-resources";
import { registerFileIpc } from "./ipc/file";
import { registerMaterialsIpc } from "./ipc/materials";
import { registerStorageIpc } from "./ipc/storage";
import { createProposalApprovalCoordinator } from "./proposal-approval";
import { registerWorkspacePreviewIpc } from "./ipc/workspace-preview";
import { createWindowCloseHandshake, type WindowCloseHandshake } from "./window-close-handshake";
import {
  getPageMetrics,
  PAGE_GAP_PX,
  type SigmaDocument,
} from "@/features/document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createCurrentLocaleTranslator, setAppLocale } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

const APP_NAME = "Sigma Studio";
const DIST_RENDERER_DIR = path.join(__dirname, "..", "out");
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.png");
const RELEASE_PAGE_URL = "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
app.setName(APP_NAME);
loadElectronEnvFiles();
const USER_DATA_PATH = resolveUserDataPath();
let mainWindow: BrowserWindow | null = null;
let activeWindowCloseHandshake: WindowCloseHandshake | null = null;
let allowMainWindowClose = false;
let quitAfterMainWindowClose = false;
let installUpdateAfterMainWindowClose = false;
let stopLocalStoreWatch: (() => void) | null = null;
let stopLocalProposalWatch: (() => void) | null = null;
let stopAiResourceWatch: (() => void) | null = null;
let stopAiSettingsWatch: (() => void) | null = null;
const localSigmaDocStore = new LocalSigmaDocStore(USER_DATA_PATH);
const localMaterialStore = new LocalMaterialStore(USER_DATA_PATH);
const localTemplateStore = new LocalTemplateStore(USER_DATA_PATH);
const localMcpProposalStore = new LocalMcpEditProposalStore(USER_DATA_PATH);
const localAiEditRunLogStore = new LocalAiEditRunLogStore(USER_DATA_PATH);
const localAiEditChatRoomStore = new LocalAiEditChatRoomStore(USER_DATA_PATH);
const localAiResourceStore = new LocalAiResourceStore(USER_DATA_PATH);
const SIGMA_STUDIO_DATA_PATH = localSigmaDocStore.getDataDir();
const appUpdateController = new AppUpdateController({ releaseUrl: RELEASE_PAGE_URL });
const desktopSettings = readDesktopSettingsSync(SIGMA_STUDIO_DATA_PATH);
/**
 * 設定ファイルに残っている bin パスも起動時に検証する。IPC 側だけ塞ぐと、**このパッチより前の
 * ビルドで書き込まれた値** (まさにこの WI が塞ごうとしている XSS→RCE の成果物) が更新後も
 * 毎回 spawn され続ける。読めない値は「未設定」に倒して自動検出へ戻す。
 */
function usablePersistedBin(bin: string | undefined): string | undefined {
  const trimmed = bin?.trim();
  if (!trimmed) {
    return undefined;
  }
  return assertUsableCliBinPath(trimmed, process.platform).ok ? trimmed : undefined;
}
const localAiEditRunContextStore = new LocalAiEditRunContextStore(USER_DATA_PATH, "claude");
const localChatgptRunContextStore = new LocalAiEditRunContextStore(USER_DATA_PATH, "chatgpt");
const localGeminiRunContextStore = new LocalAiEditRunContextStore(USER_DATA_PATH, "antigravity");
const localAiRenderBridgeStore = new LocalAiRenderBridgeStore(USER_DATA_PATH);
// webSearchEnabled 以外は起動後不変の Codex config 入力。設定変更時に
// codexAppServerClient.setWebSearchEnabled() が buildConfigToml 経由で config.toml を
// 再生成できるよう、構築時の入力を1か所にまとめておく。
const startupPromptLocale = resolveDesktopPromptLocale(SIGMA_STUDIO_DATA_PATH, app.getLocale());
setAppLocale(startupPromptLocale);

const codexAgentConfigBase: Omit<CodexAgentConfigInput, "webSearchEnabled" | "uiLocale"> = {
  execPath: process.execPath,
  scriptPath: resolveMcpServerScriptPath(),
  userDataDir: USER_DATA_PATH,
  runContextFile: localChatgptRunContextStore.getRunContextFilePath(),
  renderBridgeFile: localAiRenderBridgeStore.getBridgeFilePath(),
  provider: "chatgpt",
};
const codexAppServerClient = new CodexAppServerClient({
  codexHome: path.join(SIGMA_STUDIO_DATA_PATH, "codex-agent-home"),
  codexWorkspace: path.join(SIGMA_STUDIO_DATA_PATH, "codex-agent-workspace"),
  codexBin: process.env.SIGMA_STUDIO_CODEX_BIN?.trim() || usablePersistedBin(desktopSettings.codexBin),
  configToml: buildCodexAgentConfigToml({ ...codexAgentConfigBase, uiLocale: startupPromptLocale, webSearchEnabled: isAiWebSearchEnabled(desktopSettings) }),
  webSearchEnabled: isAiWebSearchEnabled(desktopSettings),
  uiLocale: startupPromptLocale,
  buildConfigToml: (webSearchEnabled, uiLocale) => buildCodexAgentConfigToml({ ...codexAgentConfigBase, uiLocale, webSearchEnabled }),
});
const claudeStreamClient = new ClaudeStreamClient({
  claudeConfigDir: path.join(SIGMA_STUDIO_DATA_PATH, "claude-agent-home"),
  mcpConfig: buildClaudeMcpConfig({
    execPath: process.execPath,
    scriptPath: resolveMcpServerScriptPath(),
    userDataDir: USER_DATA_PATH,
    runContextFile: localAiEditRunContextStore.getRunContextFilePath(),
    renderBridgeFile: localAiRenderBridgeStore.getBridgeFilePath(),
    provider: "claude",
    // 起動時スナップショット。言語を切り替えた run は ipc 側が per-run で上書きする
    // (Codex の app-server 設定だけは起動時に焼かれるので、切り替えは次回起動から)。
    uiLocale: startupPromptLocale,
  }),
  claudeBin: process.env.SIGMA_STUDIO_CLAUDE_BIN?.trim() || usablePersistedBin(desktopSettings.claudeBin),
});
const geminiAgentWorkspaceDir = path.join(SIGMA_STUDIO_DATA_PATH, "antigravity-agent-workspace");
const geminiHeadlessClient = new GeminiHeadlessClient({
  workspaceDir: geminiAgentWorkspaceDir,
  userDataDir: USER_DATA_PATH,
  geminiBin: process.env.SIGMA_STUDIO_ANTIGRAVITY_BIN?.trim() || process.env.SIGMA_STUDIO_GEMINI_BIN?.trim() || usablePersistedBin(desktopSettings.antigravityBin),
});
// AI設定「スキル」編集画面の「AIで下書き」用、MCPツールなしの一回きりのAntigravity呼び出し
// 専用クライアント。geminiHeadlessClient と同じbin/userDataDirだが、writeGeminiWorkspaceSettings
// が書き込む mcp_config.json が存在しない別のworkspaceDirを使うことで、MCPサーバーを一切
// 解決させない (ai-skill-draft.ts参照)。
const geminiSkillDraftClient = new GeminiHeadlessClient({
  workspaceDir: path.join(SIGMA_STUDIO_DATA_PATH, "antigravity-skill-draft-workspace"),
  userDataDir: USER_DATA_PATH,
  geminiBin: process.env.SIGMA_STUDIO_ANTIGRAVITY_BIN?.trim() || process.env.SIGMA_STUDIO_GEMINI_BIN?.trim() || usablePersistedBin(desktopSettings.antigravityBin),
});
void writeGeminiWorkspaceSettings(
  geminiAgentWorkspaceDir,
  buildGeminiWorkspaceSettings({
    execPath: process.execPath,
    scriptPath: resolveMcpServerScriptPath(),
    userDataDir: USER_DATA_PATH,
    runContextFile: localGeminiRunContextStore.getRunContextFilePath(),
    renderBridgeFile: localAiRenderBridgeStore.getBridgeFilePath(),
    provider: "antigravity",
    // 起動時スナップショット。言語を切り替えた run は ipc 側が per-run で上書きする
    // (Codex の app-server 設定だけは起動時に焼かれるので、切り替えは次回起動から)。
    uiLocale: startupPromptLocale,
  }),
).catch((error) => {
  console.warn("Antigravity MCP設定の書き込みに失敗しました。", error);
});
void cleanupStaleGeminiAttachments(geminiAgentWorkspaceDir);
// ワークスペースごとのagent-workspaces/<ws>/antigravity/ にも同じ掃除を広げる(#workspace-agent-dirs)。
void cleanupStaleAgentWorkspaceGeminiAttachments(SIGMA_STUDIO_DATA_PATH);
void localAiEditRunContextStore.clear();
void localChatgptRunContextStore.clear();
void localGeminiRunContextStore.clear();
// Every provider's turns now also get their own <provider>-<runId>-scoped
// run-context file (see runEditWithRunContext below) so that concurrent runs
// of the same provider never rely solely on one shared file. Sweep any left
// behind by a previous run that crashed before cleanup.
void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "claude");
void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "chatgpt");
void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "antigravity");
void localAiRenderBridgeStore.clear();
let aiRenderBridgeServer: http.Server | null = null;
const pendingRenderDocuments = new Map<string, SigmaDocument>();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

function resolveUserDataPath(): string {
  const explicit = process.env.SIGMA_STUDIO_USER_DATA_DIR?.trim();
  const userDataPath = explicit ? path.resolve(explicit) : path.join(app.getPath("appData"), APP_NAME);
  app.setPath("userData", userDataPath);
  return userDataPath;
}

interface PrintPreviewReadyState {
  pageCount: number;
  renderedPageCount: number;
  /** Paper size the surface laid the pages out at. Zero when the surface omitted it. */
  pageWidthMm: number;
  pageHeightMm: number;
}

// MCP サーバーは build-electron.mjs が main.cjs と同じ dist-electron/ に出力する。
// 実行時 __dirname は dist-electron/ なので隣接ファイルとして解決できる (dev/packaged 共通)。
function resolveMcpServerScriptPath(): string {
  return path.join(__dirname, "sigma-doc-mcp-server.cjs");
}

function loadElectronEnvFiles(): void {
  const envFiles = [
    path.join(__dirname, "..", ".env.local"),
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env.local"),
    path.join(__dirname, "..", "..", ".env"),
    path.join(__dirname, "..", "..", "..", ".env.local"),
    path.join(__dirname, "..", "..", "..", ".env"),
  ];

  for (const filePath of envFiles) {
    loadEnvFile(filePath);
  }
}

function loadEnvFile(filePath: string): void {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      console.warn(`Failed to read env file ${filePath}:`, error);
    }
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) {
      continue;
    }
    process.env[parsed.key] = parsed.value;
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(assignment);
  if (!match) {
    return null;
  }

  return {
    key: match[1],
    value: parseEnvValue(match[2]),
  };
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "\"" ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : inner;
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function isRendererFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
      return false;
    }

    const filePath = path.resolve(fileURLToPath(parsed));
    const rendererRoot = path.resolve(DIST_RENDERER_DIR);
    return filePath === rendererRoot || filePath.startsWith(`${rendererRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      shell.openExternal(url).catch(() => undefined);
    }
  } catch {
    // Ignore malformed navigation attempts.
  }
}

function getAppIconPath(): string | undefined {
  return existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined;
}

function applyDockIcon(): void {
  const iconPath = getAppIconPath();
  if (process.platform === "darwin" && iconPath) {
    app.dock.setIcon(iconPath);
  }
}

function createWindow() {
  allowMainWindowClose = false;
  quitAfterMainWindowClose = false;
  installUpdateAfterMainWindowClose = false;
  const iconPath = getAppIconPath();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow = win;
  activeWindowCloseHandshake = createWindowCloseHandshake({
    sendCloseRequested: () => {
      if (!win.isDestroyed()) win.webContents.send("app:close-requested");
    },
    finishClose: () => {
      allowMainWindowClose = true;
      if (installUpdateAfterMainWindowClose) appUpdateController.quitAndInstall();
      else if (quitAfterMainWindowClose) app.quit();
      else if (!win.isDestroyed()) win.close();
    },
    onCancel: () => {
      quitAfterMainWindowClose = false;
      installUpdateAfterMainWindowClose = false;
    },
    isExpectedSender: (sender) => sender === win.webContents,
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isRendererFileUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalUrl(url);
  });
  win.webContents.on("render-process-gone", () => {
    activeWindowCloseHandshake?.forceFinish();
  });

  const indexPath = path.join(DIST_RENDERER_DIR, "index.html");
  win.loadFile(indexPath).catch((err) => {
    console.error("Failed to load renderer", err);
  });
  win.on("close", (event) => {
    if (allowMainWindowClose) return;
    event.preventDefault();
    activeWindowCloseHandshake?.requestClose();
  });
  win.on("closed", () => {
    activeWindowCloseHandshake?.dispose();
    activeWindowCloseHandshake = null;
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
}

interface RenderDomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderPageContextDomMeasurement {
  anchorRect: RenderDomRect | null;
  anchorBlockFound: boolean;
  anchorPageIndex: number | null;
  pageRects: RenderDomRect[];
  pageBlockIds: string[][];
}

function renderRectsIntersect(a: RenderRect, b: RenderRect): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

// capturePage's rect is viewport-relative and can only capture pixels that
// are actually laid out within the BrowserWindow's current content bounds at
// its current scroll position (no scroll offset is applied by capturePage
// itself). We keep the window's content height fixed and bounded
// (RENDER_WINDOW_HEIGHT_PX — a viewport size, not a page-depth limit) and
// scroll the target page to the top of the viewport before measuring/
// capturing (see measureRenderPageContextDom's scrollToPageIndex), so every
// rect returned by getBoundingClientRect() is viewport-relative at y>=0
// regardless of how deep the target page is in the document. This removes
// the previous page-depth limit, where growing the window itself hit a
// height cap and silently truncated the capture for pages beyond ~page 6.
//
// Window width is derived from the document's own page metrics (not
// hardcoded to A4 portrait) so wide layouts (B4/A3 landscape) aren't
// clipped horizontally; RENDER_WINDOW_MIN_WIDTH_PX/RENDER_WINDOW_MAX_WIDTH_PX
// only bound very narrow/oversized custom page sizes.
const RENDER_WINDOW_MIN_WIDTH_PX = 1200;
const RENDER_WINDOW_MAX_WIDTH_PX = 8000;
const RENDER_WINDOW_HEIGHT_PX = 1600;

async function appendPreviewBadgeToPng(
  renderWindow: BrowserWindow,
  png: Buffer,
  badgeText: string,
): Promise<Buffer> {
  const image = nativeImage.createFromBuffer(png);
  const size = image.getSize();
  const layout = computePreviewBadgeLayout(size.width, size.height, badgeText);
  const pngBase64 = png.toString("base64");
  const canvasUnavailable = te("electron.preview.canvasUnavailable");
  const pngLoadFailed = te("electron.preview.pngLoadFailed");
  const result = await renderWindow.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const source = new Image();
      source.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = ${JSON.stringify(size.width)};
          canvas.height = ${JSON.stringify(size.height)};
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error(${JSON.stringify(canvasUnavailable)}));
            return;
          }
          context.drawImage(source, 0, 0);
          const layout = ${JSON.stringify(layout)};
          context.fillStyle = "#ffffff";
          context.strokeStyle = "#000000";
          context.lineWidth = 1;
          context.fillRect(layout.x, layout.y, layout.width, layout.height);
          context.strokeRect(layout.x + 0.5, layout.y + 0.5, Math.max(0, layout.width - 1), Math.max(0, layout.height - 1));
          context.fillStyle = "#000000";
          context.font = "700 " + layout.fontSize + "px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(
            ${JSON.stringify(badgeText)},
            layout.x + layout.width / 2,
            layout.y + layout.height / 2,
            Math.max(1, layout.width - layout.padding * 2),
          );
          resolve(canvas.toDataURL("image/png"));
        } catch (error) {
          reject(error);
        }
      };
      source.onerror = () => reject(new Error(${JSON.stringify(pngLoadFailed)}));
      source.src = "data:image/png;base64,${pngBase64}";
    })
  `, true);
  const prefix = "data:image/png;base64,";
  if (typeof result !== "string" || !result.startsWith(prefix)) {
    throw new Error(te("electron.preview.codeOverlayFailed"));
  }
  return Buffer.from(result.slice(prefix.length), "base64");
}

/** How long one rasterization may take before its offscreen window is torn down. */
const RENDER_SVG_TIMEOUT_MS = 20_000;
/**
 * Concurrent rasterizations. Each one holds a hidden window and a full-size canvas, so the cap is
 * what stops a burst of requests from pinning them all until the app is restarted.
 */
const RENDER_SVG_MAX_CONCURRENT = 2;
let renderSvgInFlight = 0;

/**
 * Rasterizes a self-contained SVG in an offscreen window.
 *
 * The picture is drawn as an `<img>` onto a canvas: Chromium is already here, and a packaged app
 * has no other rasterizer (`@resvg/resvg-js` is a devDependency). The page is a blank data URL
 * with nothing else on it, and the SVG is handed over as a base64 data URL rather than injected
 * into the document, so nothing in it is ever parsed as markup by the host page.
 */
async function renderAiSvgPng(request: RenderSvgRequest): Promise<RenderSvgResult> {
  if (renderSvgInFlight >= RENDER_SVG_MAX_CONCURRENT) {
    return { ok: false, error: te("electron.preview.renderBusy") };
  }
  renderSvgInFlight += 1;
  // The slot is released in the `finally` below, so everything that can throw — the window
  // constructor included — has to be inside the `try`. Constructing it above the `try` instead
  // would raise the count for good on a failed construction, and every later request would be
  // told the renderer is busy until the app restarts.
  let renderWindow: BrowserWindow | null = null;
  try {
    renderWindow = new BrowserWindow({
      width: 16,
      height: 16,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        images: true,
      },
    });
    renderWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await renderWindow.loadURL("data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Cbody%3E%3C/body%3E%3C/html%3E");
    const svgBase64 = Buffer.from(request.svg, "utf8").toString("base64");
    const canvasUnavailable = te("electron.preview.canvasUnavailable");
    const svgLoadFailed = te("electron.preview.svgLoadFailed");
    // The promise below only settles from the image's own events; without this race a decode that
    // never reports either way would leave the window (and its canvas) alive for the app's life.
    const result = await Promise.race([
      renderWindow.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const source = new Image();
        source.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = ${JSON.stringify(request.width)};
            canvas.height = ${JSON.stringify(request.height)};
            const context = canvas.getContext("2d");
            if (!context) {
              reject(new Error(${JSON.stringify(canvasUnavailable)}));
              return;
            }
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/png"));
          } catch (error) {
            reject(error);
          }
        };
        source.onerror = () => reject(new Error(${JSON.stringify(svgLoadFailed)}));
        source.src = "data:image/svg+xml;base64," + ${JSON.stringify(svgBase64)};
      })
    `, true),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), RENDER_SVG_TIMEOUT_MS); }),
    ]);
    const prefix = "data:image/png;base64,";
    if (typeof result !== "string" || !result.startsWith(prefix)) {
      return { ok: false, error: svgLoadFailed };
    }
    return {
      ok: true,
      pngBase64: result.slice(prefix.length),
      width: request.width,
      height: request.height,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : te("electron.preview.renderFailed") };
  } finally {
    renderSvgInFlight -= 1;
    if (renderWindow && !renderWindow.isDestroyed()) {
      renderWindow.destroy();
    }
  }
}

async function renderAiPageContextPng(request: RenderPageContextRequest): Promise<RenderPageContextResult> {
  const document = parseSigmaDocument(request.document);
  const pageMetrics = getPageMetrics(document.pageLayout);
  const pagePxSize = { width: pageMetrics.page.widthPx, height: pageMetrics.page.heightPx };
  const renderId = createRenderId();
  pendingRenderDocuments.set(renderId, document);

  const renderWindowWidthPx = Math.min(
    RENDER_WINDOW_MAX_WIDTH_PX,
    Math.max(RENDER_WINDOW_MIN_WIDTH_PX, Math.ceil(pagePxSize.width) + PAGE_GAP_PX * 2),
  );

  const renderWindow = new BrowserWindow({
    width: renderWindowWidthPx,
    height: RENDER_WINDOW_HEIGHT_PX,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  renderWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  try {
    await renderWindow.loadFile(path.join(DIST_RENDERER_DIR, "print.html"), {
      query: { renderId, profile: request.profile ?? "teacher" },
    });
    await waitForPrintPreviewReady(renderWindow);

    // First measure without scrolling: if the target page already fits
    // within the initial viewport (e.g. pageIndex 0 of a short document),
    // there is nothing to scroll and we can skip the extra round trip.
    let measurement = await measureRenderPageContextDom(renderWindow, request.targetId, null);
    let pageResolution = resolvePageContextCapturePage({
      requestedPageIndex: request.focus.pageIndex,
      pageCount: measurement.pageRects.length,
      targetId: request.targetId,
      anchorBlockFound: measurement.anchorBlockFound,
      anchorPageIndex: measurement.anchorPageIndex,
      preferTargetPage: request.focus.preferTargetPage,
    });
    if (!pageResolution.ok) {
      return { ok: false, error: pageResolution.error };
    }
    let capturePageIndex = pageResolution.pageIndex;
    let pageRectDip = measurement.pageRects[capturePageIndex];

    if (!pageRectDip || pageRectDip.y < 0 || pageRectDip.y + pageRectDip.height > RENDER_WINDOW_HEIGHT_PX) {
      measurement = await measureRenderPageContextDom(renderWindow, request.targetId, capturePageIndex);
      pageResolution = resolvePageContextCapturePage({
        requestedPageIndex: request.focus.pageIndex,
        pageCount: measurement.pageRects.length,
        targetId: request.targetId,
        anchorBlockFound: measurement.anchorBlockFound,
        anchorPageIndex: measurement.anchorPageIndex,
        preferTargetPage: request.focus.preferTargetPage,
      });
      if (!pageResolution.ok) {
        return { ok: false, error: pageResolution.error };
      }
      capturePageIndex = pageResolution.pageIndex;
      pageRectDip = measurement.pageRects[capturePageIndex];
    }

    if (!pageRectDip) {
      return { ok: false, error: te("electron.preview.pageNotFound", { page: capturePageIndex }) };
    }

    const anchorRectDip: RenderRect | null = measurement.anchorRect
      ? { x: measurement.anchorRect.x, y: measurement.anchorRect.y, w: measurement.anchorRect.width, h: measurement.anchorRect.height }
      : null;

    const pageRect = { x: pageRectDip.x, y: pageRectDip.y, w: pageRectDip.width, h: pageRectDip.height };
    if (
      request.targetId
      && (
        !anchorRectDip
        || measurement.anchorPageIndex !== capturePageIndex
        || !renderRectsIntersect(anchorRectDip, pageRect)
      )
    ) {
      return {
        ok: false,
        error: te("electron.preview.targetNotFound", { targetId: request.targetId }),
      };
    }

    const fullPageCapture = request.captureMode === "page";
    const { cropRectDip, resolvedMaxLongSidePx } = fullPageCapture
      ? {
          cropRectDip: pageRect,
          resolvedMaxLongSidePx: request.maxLongSidePx ?? DEFAULT_MAX_LONG_SIDE_PX,
        }
      : computePageContextCaptureRect({
          anchorRectDip,
          pageRectDip: pageRect,
          overlayRect: request.focus.overlayRect,
          pagePxSize,
          paddingPx: request.paddingPx,
          maxLongSidePx: request.maxLongSidePx,
        });

    const image = await renderWindow.webContents.capturePage({
      x: Math.round(cropRectDip.x),
      y: Math.round(cropRectDip.y),
      width: Math.max(1, Math.round(cropRectDip.w)),
      height: Math.max(1, Math.round(cropRectDip.h)),
    });

    const size = image.getSize();
    const longSide = Math.max(size.width, size.height);
    const resizedImage = longSide > resolvedMaxLongSidePx
      ? image.resize(size.width >= size.height
        ? { width: resolvedMaxLongSidePx }
        : { height: resolvedMaxLongSidePx })
      : image;
    const resizedPng = resizedImage.toPNG();
    const png = request.badgeText
      ? await appendPreviewBadgeToPng(renderWindow, resizedPng, request.badgeText)
      : resizedPng;
    const finalSize = resizedImage.getSize();
    const blockIds = measurement.pageBlockIds[capturePageIndex] ?? [];
    const splitBlockIds = blockIds.filter((id) => (
      measurement.pageBlockIds.some((ids, pageIndex) => pageIndex !== capturePageIndex && ids.includes(id))
    ));

    return {
      ok: true,
      pngBase64: png.toString("base64"),
      width: finalSize.width,
      height: finalSize.height,
      capture: { pageIndex: capturePageIndex, cropRect: cropRectDip },
      anchorBlockFound: anchorRectDip !== null,
      totalPages: measurement.pageRects.length,
      blockIds,
      splitBlockIds,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : te("electron.preview.renderFailed") };
  } finally {
    if (!renderWindow.isDestroyed()) {
      renderWindow.close();
    }
    pendingRenderDocuments.delete(renderId);
  }
}

async function measureRenderPageContextDom(
  renderWindow: BrowserWindow,
  targetId: string | null,
  scrollToPageIndex: number | null,
): Promise<RenderPageContextDomMeasurement> {
  // targetId is attacker-influenced (it flows from MCP tool input through the
  // render bridge request body) and must not be interpolated into the
  // querySelector string unescaped: JSON.stringify only escapes for the JS
  // string-literal context here, not for the CSS attribute-selector syntax
  // that querySelector re-parses the concatenated string as. A targetId
  // containing a literal `"` (or `]`) could otherwise break out of the
  // attribute-value quoting and inject an arbitrary selector. We pass
  // targetId in as a plain JS string (safely escaped by JSON.stringify for
  // that purpose) and build the attribute selector via CSS.escape inside the
  // page context instead of string concatenation.
  //
  // scrollToPageIndex: capturePage() only captures pixels within the
  // BrowserWindow's current viewport (no scroll offset applied). Rather than
  // growing the window's content area to cover every page down to the target
  // (unbounded as documents get deep — see RENDER_WINDOW_MAX_HEIGHT_PX), we
  // keep the window at a fixed, bounded size and scroll the target page to
  // the top of the viewport before measuring. getBoundingClientRect() is
  // viewport-relative, so after scrolling every rect (including the target
  // page's own rect) is reported relative to the new scroll position, and a
  // deep page renders identically to page 0.
  return renderWindow.webContents.executeJavaScript(`
    (function () {
      function rectOf(el) {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      function blockIdsOf(pageEl) {
        const ids = new Set();
        const attributes = [
          "data-sigma-doc-id",
          "data-block-source-id",
          "data-layout-section-source-id",
          "data-box-source-id",
          "data-problem-source-id",
        ];
        pageEl.querySelectorAll(attributes.map((name) => "[" + name + "]").join(",")).forEach((element) => {
          attributes.forEach((name) => {
            const id = element.getAttribute(name);
            if (id) ids.add(id);
          });
        });
        return Array.from(ids);
      }
      const scrollToPageIndex = ${JSON.stringify(scrollToPageIndex)};
      if (scrollToPageIndex !== null) {
        const pageEls0 = Array.from(document.querySelectorAll(".paged-surface-page"));
        const scrollTargetEl = pageEls0[scrollToPageIndex];
        if (scrollTargetEl) {
          window.scrollTo(0, scrollTargetEl.offsetTop);
        }
      }
      const targetId = ${JSON.stringify(targetId)};
      // Page windows carry a full copy of the canvas, but identifying attributes are
      // scoped to the page each element lands on, so this resolves to the right page.
      const anchorEl = targetId
        ? document.querySelector('.paged-surface-page [data-sigma-doc-id="' + CSS.escape(targetId) + '"]')
        : null;
      const pageEls = Array.from(document.querySelectorAll(".paged-surface-page"));
      const anchorPageEl = anchorEl ? anchorEl.closest(".paged-surface-page") : null;
      return {
        anchorRect: anchorEl ? rectOf(anchorEl) : null,
        anchorBlockFound: Boolean(anchorEl),
        anchorPageIndex: anchorPageEl ? pageEls.indexOf(anchorPageEl) : null,
        pageRects: pageEls.map(rectOf),
        pageBlockIds: pageEls.map(blockIdsOf),
      };
    })();
  `, true);
}

function createRenderId(): string {
  return `ai_render_${crypto.randomUUID()}`;
}

async function waitForPrintPreviewReady(win: BrowserWindow): Promise<PrintPreviewReadyState> {
  const documentLoadFailed = te("electron.preview.documentLoadFailed");
  const preparationTimedOut = te("electron.preview.preparationTimedOut");
  return win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const timeoutMs = 15000;
      const stableFramesRequired = 8;
      const startedAt = Date.now();
      let lastSignature = "";
      let stableFrames = 0;
      let resolved = false;

      const finish = (value) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      const fail = (error) => {
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      };

      const waitForAssets = () => {
        const fontReady = document.fonts?.ready ?? Promise.resolve();
        const imageReady = Promise.all(Array.from(document.images).map((image) => {
          if (image.complete) {
            return Promise.resolve();
          }
          return new Promise((resolveImage) => {
            image.addEventListener("load", () => resolveImage(undefined), { once: true });
            image.addEventListener("error", () => resolveImage(undefined), { once: true });
          });
        }));
        return Promise.all([fontReady, imageReady]);
      };

      const tick = () => {
        const errorElement = document.querySelector('[data-print-load-state="error"]');
        if (errorElement) {
          fail(new Error(errorElement.textContent?.trim() || ${JSON.stringify(documentLoadFailed)}));
          return;
        }

        const stack = document.querySelector(".paged-surface");
        const renderedPageCount = document.querySelectorAll(".paged-surface-page").length;
        const pageCount = Number(stack?.getAttribute("data-paged-surface-page-count") ?? "0");
        if (stack && pageCount > 0 && renderedPageCount > 0) {
          const signature = [
            pageCount,
            renderedPageCount,
            // A late decorating pass rebuilds the windows without changing their count or
            // size, so the revision is what makes this wait for the final surface.
            stack.getAttribute("data-paged-surface-revision") ?? "",
            stack.scrollWidth,
            stack.scrollHeight,
            document.body.scrollHeight,
          ].join(":");
          if (signature === lastSignature) {
            stableFrames += 1;
          } else {
            lastSignature = signature;
            stableFrames = 0;
          }

          if (stableFrames >= stableFramesRequired) {
            // The paper size travels with the surface so the PDF is never cut to a
            // hardcoded default (docs/pdf-parity-architecture.md, invariant 6).
            const pageWidthMm = Number(stack.getAttribute("data-paged-surface-page-width-mm") ?? "0");
            const pageHeightMm = Number(stack.getAttribute("data-paged-surface-page-height-mm") ?? "0");
            waitForAssets()
              .then(() => finish({ pageCount, renderedPageCount, pageWidthMm, pageHeightMm }))
              .catch(fail);
            return;
          }
        }

        if (Date.now() - startedAt > timeoutMs) {
          fail(new Error(${JSON.stringify(preparationTimedOut)}));
          return;
        }

        window.requestAnimationFrame(tick);
      };

      window.requestAnimationFrame(tick);
    });
  `, true);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const sendMenuAction = (action: string) => () => {
    mainWindow?.webContents.send("menu:action", action);
  };

  // Edit メニューは合成 role (`{ role: "editMenu" }`) をやめて明示テンプレートに展開する。
  //
  // 直す対象は「⌘Z がネイティブメニューに取られること」ではなく、**取った先が
  // webContents.undo() だったこと**。`role: "undo"` を指定すると Electron は `click` を
  // 無視して必ず webContents.undo() を呼ぶ。それは Blink のネイティブ undo で、
  // ProseMirror が所有する contenteditable を外から書き換える (何も起きないか、
  // React の commit が DOM 例外で落ちてクラッシュ画面になる)。
  //
  // なので undo / redo は **role を使わず** label + accelerator + click の手書きにして、
  // メニューが ⌘Z / ⇧⌘Z を持ったまま、その click をレンダラの edit.undo / edit.redo へ配る。
  // キーボードから来てもメニュークリックから来ても、通る道は 1 本だけになる。
  //
  // **`registerAccelerator: false` は使わない。** electron.d.ts の当該オプションには
  // `@platform linux,win32` と明記されていて、macOS での挙動は契約上どちらでもよい。
  // 無視されれば修正が効かず、効けば cut / copy / paste から macOS のキー等価
  // (AppKit のメニューキー等価 → NSResponder の copy: / paste:) が消えてクリップボードが
  // アプリ全体で壊れる。二択のどちらも受け入れられないので、この不確実性に依存しない形にする。
  // (File > PDF Preview… の registerAccelerator: false は Windows / Linux 向けの既存指定で、
  //  こちらはメニュー click が同じコマンドへ配られるため本 WI では触らない。)
  //
  // cut / copy / paste 等は **素の role のまま**。キー等価も OS ローカライズされたラベルも
  // enable / disable も従来どおりで、今日の挙動を 1mm も変えない。その帰結として
  // ⌘⇧V (リテラル貼り付け) と ⌘A (跨ぎ全選択 / 図形全選択) の復活は本 WI の対象外にする。
  //
  // ずれと後戻りは electron/menu-accelerator-parity.test.ts が落とす。
  const editMenuItems: Electron.MenuItemConstructorOptions[] = [
    { label: "Undo", accelerator: "CmdOrCtrl+Z", click: sendMenuAction("undo") },
    { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: sendMenuAction("redo") },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    ...(isMac
      ? [
          { role: "pasteAndMatchStyle" as const },
          { role: "delete" as const },
          { role: "selectAll" as const },
          { type: "separator" as const },
          { label: "Speech", submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }] },
        ]
      : [
          // 非 macOS の既定 editMenu には pasteAndMatchStyle が無い。並びも Electron 既定のまま。
          { role: "delete" as const },
          { type: "separator" as const },
          { role: "selectAll" as const },
        ]),
  ];

  // View も同じ理由で明示テンプレートへ展開する (合成 role は検査の射程外になる)。
  // **ただし挙動は現状維持** — ⌘0 / ⌘± は今もネイティブの画面倍率が動いており、
  // レンダラの view.zoom* との一本化は別 WI。parity テストが
  // KNOWN_NATIVE_KEY_OWNERS として名前で残しているので、直したら消し忘れが落ちる。
  const viewMenuItems: Electron.MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" as const },
            { type: "separator" as const },
            { label: "Settings…", accelerator: "Cmd+,", click: sendMenuAction("open-settings") },
            { type: "separator" as const },
            { role: "services" as const },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { role: "unhide" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Document", accelerator: "CmdOrCtrl+N", click: sendMenuAction("new-document") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: sendMenuAction("open-document") },
        { type: "separator" },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: sendMenuAction("save-document") },
        { type: "separator" },
        // ⌘P はコマンドパレットへ譲った (src/lib/editor-command-bindings.ts)。
        // ネイティブメニューの accelerator は **レンダラの keydown より先に発火する**ので、
        // ここが古いままだとレンダラのパレットには永久に届かない。
        // ずれは electron/menu-accelerator-parity.test.ts が落とす。
        //
        // `registerAccelerator: false` はメニューに**表記だけ残してキー処理をしない**指定。
        // これが無いと、ユーザーがショートカット設定で PDF プレビューを付け替えても
        // メニューが ⌘⇧P を握り続け、逆に ⌘⇧P を別のコマンドに割り当てると
        // メニューが先に発火してユーザーの割り当てが黙って負ける。
        {
          label: "PDF Preview…",
          accelerator: "CmdOrCtrl+Shift+P",
          registerAccelerator: false,
          click: sendMenuAction("print-document"),
        },
        ...(isMac ? [] : [
          { type: "separator" as const },
          { label: "Settings…", accelerator: "Ctrl+,", click: sendMenuAction("open-settings") },
          { type: "separator" as const },
          { role: "quit" as const },
        ]),
      ],
    },
    {
      label: "Edit",
      submenu: editMenuItems,
    },
    {
      label: "View",
      submenu: viewMenuItems,
    },
    // windowMenu だけは展開しない。⌘M / ⌘W は **レンダラが持ってはいけない OS 側のキー**で、
    // レンダラのどのコマンドもこの 2 つを既定バインドに持たないことを parity テストが
    // 逆向きに検査している。
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates…",
          click: sendMenuAction("check-updates"),
        },
        { type: "separator" },
        {
          label: "Project Page",
          click: () => {
            shell.openExternal("https://github.com/Atsu-Taiyo/SIGMA-Studio").catch(() => undefined);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function broadcastLocalStoreChange(event: LocalStoreChangeEvent | LocalMcpEditProposalChangeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("storage:changed", event);
  }
}

// ドキュメント保存が成功するすべての経路 (renderer からの保存IPC・単体承認・一括承認・
// 自動承認・revert) の直後に呼ぶ共通フック。(1) その教材の pending 提案を、対象ブロックが
// 実際には変わっていない限り現在revisionへ自動追従(rebase)させる — 人間の無関係な編集
// だけで提案が即staleになる問題への対処。rebaseは提案ファイルしか書き換えないため、
// ここから再度ドキュメント保存が走ることはなく無限ループしない。(2) 検証済み自動承認の
// 再チェックをスケジュールする (rebaseで baseRevision===current に追いついた提案を拾う)。
async function runPostSaveHooks(fileId: string, document: SigmaDocument, revision: number): Promise<void> {
  if (await localMcpProposalStore.countPendingProposalsForFile(fileId) === 0) {
    scheduleAutoApplyCheck();
    return;
  }
  try {
    await localMcpProposalStore.autoRebaseProposalsForFile(fileId, document, revision);
  } catch (error) {
    console.warn(`保存後の編集案自動追従(rebase)に失敗しました (${fileId})。`, error);
  }
  scheduleAutoApplyCheck();
}

const { approveSingleProposal } = createProposalApprovalCoordinator({
  localSigmaDocStore,
  localMcpProposalStore,
  broadcastLocalStoreChange,
  runPostSaveHooks,
  translate: te,
});

// 検証済み自動承認 (aiAutoApplyVerifiedProposals) の直列化キュー。proposalStore.watch() は
// fs監視の debounce されたイベントを高頻度に発火しうるため、チェック自体を直列に実行して
// 同じ提案に対する承認が重複実行されないようにする (承認済みの提案は
// shouldAutoApplyProposal が status !== "pending" で弾く二重ガードもある)。
let autoApplyQueue: Promise<void> = Promise.resolve();
const autoApplyInFlight = new Set<string>();

// fileId → 直近の「renderer からの保存IPC (storage:save-document)」のタイムスタンプ。人間が
// アクティブに編集中 (自動保存が最近走った) の教材は、下の runAutoApplyCheck で自動承認を
// 一時的に見送るために使う。承認IPC・revert等、renderer保存以外の保存経路では記録しない
// (それらは人間のアクティブな編集ではないため)。
const lastRendererSaveAt = new Map<string, number>();
// fileId → 「延期中の再チェック」タイマー。人間の入力が止まった時点でも自動承認が確実に
// 行われるよう、AUTO_APPLY_DEFER_MS 経過後に scheduleAutoApplyCheck を1回予約する。
const autoApplyDeferTimers = new Map<string, NodeJS.Timeout>();

function recordRendererSave(fileId: string): void {
  lastRendererSaveAt.set(fileId, Date.now());
}

function scheduleDeferredAutoApplyRecheck(fileId: string, delayMs: number): void {
  if (autoApplyDeferTimers.has(fileId)) {
    // 既に再チェックが予約済み。次回の runAutoApplyCheck 実行時に、その時点でも延期が
    // 必要なら改めて(新しい残り時間で)予約し直される。
    return;
  }
  const timer = setTimeout(() => {
    autoApplyDeferTimers.delete(fileId);
    scheduleAutoApplyCheck();
  }, Math.max(0, delayMs));
  autoApplyDeferTimers.set(fileId, timer);
}

function scheduleAutoApplyCheck(): void {
  autoApplyQueue = autoApplyQueue.then(runAutoApplyCheck).catch((error) => {
    console.warn("検証済み編集案の自動承認チェックに失敗しました。", error);
  });
}

async function runAutoApplyCheck(): Promise<void> {
  const settings = readDesktopSettingsSync(SIGMA_STUDIO_DATA_PATH);
  if (!settings.aiAutoApplyVerifiedProposals) {
    return;
  }

  const pending = await localMcpProposalStore.listProposals({ status: "pending" });
  const eligible = pending.filter((proposal) => !autoApplyInFlight.has(proposal.proposalId));
  if (eligible.length === 0) {
    return;
  }

  const files = await localSigmaDocStore.listFiles();

  // 実行順は「保存→自動rebase→自動承認判定」: baseRevisionが古い(かつtouchedBlocksを
  // 記録している)pending提案は、対象ブロックが変わっていなければ先にrebaseで現在revisionへ
  // 追従させる。そうして初めて下のshouldAutoApplyProposalのbaseRevision===currentRevision
  // 判定を通過できる (保存経路自体はrunPostSaveHooksが既に呼んでいるはずだが、設定ONへの
  // 切り替えや提案の新規作成など保存を伴わない契機で呼ばれた場合にも同じ順序を保証する)。
  const staleFileIds = new Set(
    eligible
      .filter((proposal) => {
        const file = files.find((item) => item.fileId === proposal.fileId);
        return Boolean(file) && proposal.baseRevision !== file!.revision;
      })
      .map((proposal) => proposal.fileId),
  );
  for (const fileId of staleFileIds) {
    const file = files.find((item) => item.fileId === fileId);
    if (!file) {
      continue;
    }
    const document = await localSigmaDocStore.loadDocument(fileId);
    if (!document) {
      continue;
    }
    try {
      await localMcpProposalStore.autoRebaseProposalsForFile(fileId, document, file.revision);
    } catch (error) {
      console.warn(`検証済み編集案の自動rebaseに失敗しました (${fileId})。`, error);
    }
  }

  const refreshedPending = staleFileIds.size > 0
    ? await localMcpProposalStore.listProposals({ status: "pending" })
    : eligible;
  for (const proposal of refreshedPending) {
    if (autoApplyInFlight.has(proposal.proposalId)) {
      continue;
    }
    const file = files.find((item) => item.fileId === proposal.fileId);
    if (!file) {
      continue;
    }
    // 人間がその教材をアクティブに編集中 (直近のrenderer保存から日が浅い) なら、この教材への
    // 自動承認を今回は見送り、入力が落ち着いた頃に再チェックする。提案はpendingのまま残るため
    // 取りこぼしはない。
    const now = Date.now();
    const lastSaveAt = lastRendererSaveAt.get(proposal.fileId);
    if (shouldDeferAutoApply(lastSaveAt, now)) {
      scheduleDeferredAutoApplyRecheck(proposal.fileId, AUTO_APPLY_DEFER_MS - (now - lastSaveAt!));
      continue;
    }
    if (!shouldAutoApplyProposal({ settingEnabled: true, proposal, currentRevision: file.revision })) {
      continue;
    }
    autoApplyInFlight.add(proposal.proposalId);
    try {
      const result = await approveSingleProposal(proposal.proposalId, { autoApplied: true });
      if (!result.ok) {
        // 失敗しても提案はpendingのまま残る (approveSingleProposal は失敗時にレコードを変更しない)。
        // 次回の変更検知でまた条件を満たせば再試行される。
        console.warn(`検証済み編集案の自動承認に失敗しました (${proposal.proposalId}): ${result.error}`);
      }
    } catch (error) {
      console.warn(`検証済み編集案の自動承認中に例外が発生しました (${proposal.proposalId})。`, error);
    } finally {
      autoApplyInFlight.delete(proposal.proposalId);
    }
  }
}

function broadcastCodexStatusChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("codex:status-changed");
  }
}

function broadcastClaudeStatusChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("claude:status-changed");
  }
}

function startLocalStoreWatch(): void {
  if (stopLocalStoreWatch) {
    return;
  }

  stopLocalStoreWatch = localSigmaDocStore.watch(broadcastLocalStoreChange);
}

function startLocalProposalWatch(): void {
  if (stopLocalProposalWatch) {
    return;
  }

  stopLocalProposalWatch = localMcpProposalStore.watch((event) => {
    broadcastLocalStoreChange(event);
    if (event.type !== "mcpProposal") {
      return;
    }
    // 新規/更新された提案が検証済み自動承認の対象になりうるので、変更のたびにチェックする。
    // runAutoApplyCheck 自身が設定OFF・対象なしの場合は即returnする軽量パス。
    scheduleAutoApplyCheck();
  });
}

function hashFileContent(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function readFileHashSafe(filePath: string): string | null {
  try {
    return hashFileContent(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// MCPサーバー(sigma-doc-mcp-server-core.ts、Electron mainとは別プロセス)がsave_ai_resource /
// delete_ai_resource経由でai-agent-config/manifest.jsonを書き換えても、mainの
// localAiResourceStoreはメモリ上に状態を持たない(毎回ディスクを読み直す)ため取りこぼしはないが、
// Studioを開いたままのAI設定ダイアログ(AiSettingsDialog)は自分から再取得しない限り古い一覧のままになる。
// manifest.jsonをfs.watchし、内容ハッシュが前回と変わっていればレンダラへ通知して
// 開いているダイアログに再取得させる(bridge.aiResources.onChanged→refreshTree)。
// 書き込み元がmain自身(既存のai-resources:* IPCハンドラ経由の保存)であっても、
// ハッシュ比較で同一内容の再発火を抑えるだけで実害はない(ダイアログは保存直後に
// 自前でrefreshTree()済みなので二重通知になるだけ)。
function startAiResourceWatch(): void {
  if (stopAiResourceWatch) {
    return;
  }
  const sourceRoot = localAiResourceStore.getSourceRoot();
  const manifestPath = path.join(sourceRoot, "manifest.json");
  let lastHash = readFileHashSafe(manifestPath);
  let timer: NodeJS.Timeout | null = null;
  const check = () => {
    const hash = readFileHashSafe(manifestPath);
    if (hash === null || hash === lastHash) {
      return;
    }
    lastHash = hash;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-resources:changed");
    }
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(sourceRoot, { persistent: true }, (_event, filename) => {
      const name = filename?.toString();
      if (name && name !== "manifest.json") {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(check, 200);
    });
  } catch {
    // ai-agent-config がまだ存在しない初回起動直後は諦める
    // (localAiResourceStoreがensureDefaults()で後から作る。次回起動時watchされる)。
  }
  stopAiResourceWatch = () => {
    watcher?.close();
    if (timer) {
      clearTimeout(timer);
    }
  };
}

// settings.jsonも同様にMCPのupdate_ai_settings tool(別プロセス)からの書き換えを検知する。
// aiWebSearchEnabledは常駐中のCodex app-serverクライアントへ明示的に伝える必要があり
// (setWebSearchEnabledは値が変わらなければ内部で即returnするノーガード呼び出し安全設計)、
// aiAutoApplyVerifiedProposalsがONになった場合は既存の検証済みpending提案をすぐ拾わせる
// (手動のsettings:set-ai-*系IPCハンドラと同じ振る舞いをwatch経由でも揃える)。
function startAiSettingsWatch(): void {
  if (stopAiSettingsWatch) {
    return;
  }
  const settingsFilePath = desktopSettingsPath(SIGMA_STUDIO_DATA_PATH);
  const settingsDir = path.dirname(settingsFilePath);
  let lastHash = readFileHashSafe(settingsFilePath);
  let timer: NodeJS.Timeout | null = null;
  const check = () => {
    const hash = readFileHashSafe(settingsFilePath);
    if (hash === null || hash === lastHash) {
      return;
    }
    lastHash = hash;
    const settings = readDesktopSettingsSync(SIGMA_STUDIO_DATA_PATH);
    codexAppServerClient.setWebSearchEnabled(isAiWebSearchEnabled(settings));
    scheduleAutoApplyCheck();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-settings:changed");
    }
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(settingsDir, { persistent: true }, (_event, filename) => {
      const name = filename?.toString();
      if (name && name !== "settings.json") {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(check, 200);
    });
  } catch {
    // dataDir がまだ存在しない初回起動直後は諦める。
  }
  stopAiSettingsWatch = () => {
    watcher?.close();
    if (timer) {
      clearTimeout(timer);
    }
  };
}

function checkForUpdatesInBackground(): void {
  const phase = appUpdateController.getStatus().phase;
  if (phase === "checking" || phase === "downloading" || phase === "downloaded") {
    return;
  }

  appUpdateController.checkAndDownloadInBackground().catch(() => {});
}

function registerIpc() {
  ipcMain.handle("app:close-ack", (event) => {
    return activeWindowCloseHandshake?.acknowledge(event.sender) ?? false;
  });
  ipcMain.handle("app:close-ready", (event) => {
    return activeWindowCloseHandshake?.notifyReady(event.sender) ?? false;
  });
  ipcMain.handle("app:close-cancel", (event) => {
    return activeWindowCloseHandshake?.cancel(event.sender) ?? false;
  });
  registerAppIpc({
    getMainWindow: () => mainWindow,
    releaseUrl: RELEASE_PAGE_URL,
    dataDir: SIGMA_STUDIO_DATA_PATH,
    appUpdateController,
    quitAndInstall: () => {
      if (appUpdateController.getStatus().phase !== "downloaded") {
        return appUpdateController.quitAndInstall();
      }
      installUpdateAfterMainWindowClose = true;
      quitAfterMainWindowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      else appUpdateController.quitAndInstall();
      return { ok: true };
    },
  });

  registerShellIpc();

  registerSettingsIpc({
    dataDir: SIGMA_STUDIO_DATA_PATH,
    codexAppServerClient,
    scheduleAutoApplyCheck,
  });

  registerCodexIpc({
    dataDir: SIGMA_STUDIO_DATA_PATH,
    codexAppServerClient,
    claudeStreamClient,
    geminiHeadlessClient,
    getMainWindow: () => mainWindow,
    openExternalUrl,
  });

  registerAiEditIpc({
    userDataPath: USER_DATA_PATH,
    dataDir: SIGMA_STUDIO_DATA_PATH,
    localSigmaDocStore,
    localAiResourceStore,
    localAiEditRunLogStore,
    localAiEditChatRoomStore,
    localMcpProposalStore,
    localChatgptRunContextStore,
    localGeminiRunContextStore,
    localAiRenderBridgeStore,
    claudeStreamClient,
    codexAppServerClient,
    geminiHeadlessClient,
    resolveMcpServerScriptPath,
    pendingRenderDocuments,
  });

  registerAiResourcesIpc({
    localAiResourceStore,
    claudeStreamClient,
    codexAppServerClient,
    geminiSkillDraftClient,
  });

  registerFileIpc({
    getMainWindow: () => mainWindow,
  });

  registerMaterialsIpc({
    localMaterialStore,
    localTemplateStore,
  });

  registerStorageIpc({
    localSigmaDocStore,
    localMcpProposalStore,
    approveSingleProposal,
    broadcastLocalStoreChange,
    runPostSaveHooks,
    recordRendererSave,
  });

  registerWorkspacePreviewIpc({
    userDataPath: USER_DATA_PATH,
  });
}

app.whenReady().then(async () => {
  codexAppServerClient.on("statusChanged", broadcastCodexStatusChange);
  claudeStreamClient.on("statusChanged", broadcastClaudeStatusChange);
  registerIpc();
  buildMenu();
  applyDockIcon();
  createWindow();
  startLocalStoreWatch();
  startLocalProposalWatch();
  void localMcpProposalStore.warmIndex();
  startAiResourceWatch();
  startAiSettingsWatch();
  // Best-effort: the render bridge accelerates render_visual_edit_session PNG
  // previews, but the MCP server always has a resvg SVG-fallback path when
  // it's unavailable, so a failure here must not abort app startup.
  try {
    await startAiRenderBridgeServer();
  } catch (error) {
    console.warn("AI render bridge serverを起動できませんでした。MCPはresvgフォールバックを使用します。", error);
  }

  // Prewarm the Codex app-server subprocess shortly after the window is ready so
  // the first user edit doesn't pay spawn+initialize latency. getStatus()
  // triggers ensureStarted() when codex is available. Fire-and-forget; never throw.
  setTimeout(() => {
    codexAppServerClient.getStatus().catch(() => {});
  }, 1500);

  setTimeout(() => {
    checkForUpdatesInBackground();
  }, 5000);
  setInterval(checkForUpdatesInBackground, UPDATE_CHECK_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (mainWindow && !mainWindow.isDestroyed() && !allowMainWindowClose) {
    event.preventDefault();
    quitAfterMainWindowClose = true;
    mainWindow.close();
    return;
  }
  codexAppServerClient.dispose();
  claudeStreamClient.dispose();
  stopLocalStoreWatch?.();
  stopLocalStoreWatch = null;
  stopLocalProposalWatch?.();
  stopLocalProposalWatch = null;
  stopAiResourceWatch?.();
  stopAiResourceWatch = null;
  stopAiSettingsWatch?.();
  stopAiSettingsWatch = null;
  void localAiEditRunContextStore.clear();
  void localChatgptRunContextStore.clear();
  void localGeminiRunContextStore.clear();
  void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "claude");
  void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "chatgpt");
  void sweepOrphanPerRunContextFiles(USER_DATA_PATH, "antigravity");
  stopAiRenderBridgeServer();
});

async function startAiRenderBridgeServer(): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  const server = createAiRenderBridgeServer({
    token,
    renderPageContext: renderAiPageContextPng,
    renderSvg: renderAiSvgPng,
    parseDocument: (input) => parseSigmaDocument(input),
  });
  aiRenderBridgeServer = server;

  // Errors after listen() succeeds (e.g. an unexpected socket error) must not
  // crash the whole app: the render bridge is a best-effort accelerator and
  // the MCP server always has a resvg fallback when it's unavailable.
  server.on("error", (error) => {
    console.warn("AI render bridge serverでエラーが発生しました。", error);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(te("electron.preview.bridgePortMissing"));
  }

  await localAiRenderBridgeStore.write({
    version: 1,
    url: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
}

function stopAiRenderBridgeServer(): void {
  aiRenderBridgeServer?.close();
  aiRenderBridgeServer = null;
  void localAiRenderBridgeStore.clear();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
