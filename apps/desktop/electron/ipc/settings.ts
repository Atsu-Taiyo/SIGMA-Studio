import { ipcMain } from "../trusted-ipc";
import { createCurrentLocaleTranslator, setAppLocale } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

import type { CodexAppServerClient } from "../codex-app-server-client";
import { normalizeAiSubagentSettings, resolveAiSubagentPolicy } from "@/lib/ai/subagent-settings";
import {
  isAiWebSearchEnabled,
  normalizeDesktopCommandShortcuts,
  normalizeDesktopCustomCommands,
  normalizeUiLocale,
  parseDesktopCommandSettingsPayload,
  readDesktopSettingsSync,
  resolveAiSubagentSettings,
  transactDesktopSettings,
  writeDesktopSettings,
} from "../desktop-settings";

export interface RegisterSettingsIpcDeps {
  dataDir: string;
  codexAppServerClient: CodexAppServerClient;
  scheduleAutoApplyCheck: () => void;
}

export function registerSettingsIpc(deps: RegisterSettingsIpcDeps): void {
  const { dataDir, codexAppServerClient, scheduleAutoApplyCheck } = deps;

  ipcMain.handle("settings:get", async () => {
    const settings = readDesktopSettingsSync(dataDir);
    return {
      commandShortcuts: settings.commandShortcuts ?? {},
      customCommands: settings.customCommands ?? [],
      hasCommandShortcuts: "commandShortcuts" in settings,
      hasCustomCommands: "customCommands" in settings,
      aiAutoApplyVerifiedProposals: settings.aiAutoApplyVerifiedProposals ?? false,
      aiWebSearchEnabled: isAiWebSearchEnabled(settings),
      aiSubagents: resolveAiSubagentSettings(settings),
      // 既定 (ja) はキーごと削除される保存形式なので、未設定は null で返す。
      // ここで既定値に解決してしまうと、初回起動でOSロケール検出が効かなくなる。
      uiLocale: settings.uiLocale ?? null,
    };
  });

  ipcMain.handle("settings:set-ui-locale", async (_event, value: unknown) => {
    const uiLocale = normalizeUiLocale(value);
    if (!uiLocale) {
      return { ok: false, error: te("electron.settings.unsupportedLocale") };
    }
    await writeDesktopSettings(dataDir, { uiLocale });
    setAppLocale(uiLocale);
    // web検索と同じ理由: Codex の常駐 app-server は spawn 前の config.toml しか
    // 読まないので、ここで伝えないと MCP サーバー (別プロセス) だけ元の言語のまま
    // アプリ再起動まで残る。Claude/Antigravity は turn ごとに渡し直すので不要。
    codexAppServerClient.setUiLocale(uiLocale);
    return { ok: true };
  });

  // 初回起動で検出した言語を書くための入口。読んでから書くまでをほかの書き込みと同じ列で行い、
  // その間にもう言語が選ばれていればそちらを残して返す (起動直後の古い読み取りで選択を消さない)。
  ipcMain.handle("settings:init-ui-locale", async (_event, value: unknown) => {
    const detected = normalizeUiLocale(value);
    if (!detected) {
      return { ok: false, error: te("electron.settings.unsupportedLocale") };
    }
    const uiLocale = await transactDesktopSettings(dataDir, async (current, write) => {
      const existing = normalizeUiLocale(current.uiLocale);
      if (existing) {
        return existing;
      }
      await write({ uiLocale: detected });
      return detected;
    });
    setAppLocale(uiLocale);
    codexAppServerClient.setUiLocale(uiLocale);
    return { ok: true, uiLocale };
  });

  ipcMain.handle("settings:set-ai-auto-apply-verified-proposals", async (_event, value: unknown) => {
    await writeDesktopSettings(dataDir, { aiAutoApplyVerifiedProposals: value === true });
    // 設定をONにした直後、既存の検証済みpending提案がすでにあれば即座に自動承認する。
    scheduleAutoApplyCheck();
    return { ok: true };
  });

  ipcMain.handle("settings:set-ai-web-search-enabled", async (_event, value: unknown) => {
    await writeDesktopSettings(dataDir, { aiWebSearchEnabled: value === true });
    // Codex は常駐 app-server の config.toml に web_search を焼き込むため、設定変更を
    // クライアントへ伝えて (アイドル時は) 再起動させる。Claude/Antigravity は turn ごとに
    // ai-edit:run が設定を読み直すので、ここでの伝搬は不要。
    codexAppServerClient.setWebSearchEnabled(value === true);
    return { ok: true };
  });

  ipcMain.handle("settings:set-ai-subagents", async (_event, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: te("electron.settings.invalidAiSubagents") };
    }
    const aiSubagents = normalizeAiSubagentSettings(value);
    await writeDesktopSettings(dataDir, { aiSubagents });
    // Web検索と同じく、Codex は常駐 app-server の config.toml に [agents] を焼き込むので、
    // クライアントへ伝えて (アイドル時は) 再起動させる。Claude/Antigravity は turn ごとに
    // ai-edit:run が設定を読み直すので、ここでの伝搬は不要。
    codexAppServerClient.setSubagentPolicy(resolveAiSubagentPolicy(aiSubagents, "chatgpt"));
    return { ok: true, aiSubagents };
  });

  ipcMain.handle("settings:set-command-shortcuts", async (_event, value: unknown) => {
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      return { ok: false, error: te("electron.settings.invalidShortcuts") };
    }
    const normalized = normalizeDesktopCommandShortcuts(value ?? {});
    await writeDesktopSettings(dataDir, {
      commandShortcuts: Object.keys(normalized).length > 0 ? normalized : undefined,
    });
    return { ok: true };
  });

  ipcMain.handle("settings:set-custom-commands", async (_event, value: unknown) => {
    if (!Array.isArray(value)) {
      return { ok: false, error: te("electron.settings.invalidCustomCommands") };
    }
    await writeDesktopSettings(dataDir, {
      customCommands: normalizeDesktopCustomCommands(value),
    });
    return { ok: true };
  });

  ipcMain.handle("settings:set-command-config", async (_event, value: unknown) => {
    const payload = parseDesktopCommandSettingsPayload(value);
    if (!payload) {
      return { ok: false, error: te("electron.settings.invalidShortcuts") };
    }
    await writeDesktopSettings(dataDir, payload);
    return { ok: true };
  });
}
