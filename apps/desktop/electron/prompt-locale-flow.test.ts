import { describe, expect, it } from "vitest";

import { createTranslator, SUPPORTED_LOCALES } from "@/lib/i18n";

import { buildClaudeEditPrompt } from "./claude-edit";
import { resolveDesktopPromptLocale } from "./desktop-settings";
import { buildGeminiEditPrompt } from "./gemini-edit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AppLocale } from "@/lib/i18n";
import { CodexAppServerClient } from "./codex-app-server-client";
import { buildClaudeMcpConfig } from "./claude-mcp-config";
import { buildCodexAgentConfigToml } from "./codex-mcp-config";
import { buildGeminiWorkspaceSettings } from "./gemini-settings-config";
import { VALIDATION_LOCALE_ENV } from "@/lib/ai/validation-locale";

/**
 * **main プロセスには renderer の React context が無い**ので、プロンプトの言語は
 * IPC ハンドラが run ごとに解決して provider まで引き回す。
 *
 * 引き回しの**漏れ自体は型で塞いである** (`locale` は必須引数。途中で落とすと
 * コンパイルエラーになる — 実際 WI-8 で共有ランナーが落としていたのを型が捕まえた)。
 * ここが見るのはその先、**届いた locale が実際に出力の言語を変えているか**と、
 * 解決関数が未設定環境で安全に既定へ落ちるか。
 */
const ARGS = { instruction: "x", fileId: "f1" };
// **`・` と CJK 約物まで含める。** 狭いクラスだと「日本語なし」と言いながら全角記号が残る (code-review 指摘)。
const JAPANESE = /[\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF\uFF01-\uFF60]/u;

describe("prompt locale reaches every provider", () => {
  const providers: Array<[string, (locale: "ja" | "en") => string]> = [
    ["claude", (locale) => buildClaudeEditPrompt({ ...ARGS, locale })],
    ["antigravity", (locale) => buildGeminiEditPrompt({ ...ARGS, locale })],
  ];

  for (const [name, build] of providers) {
    for (const locale of SUPPORTED_LOCALES) {
      it(`${name} builds its prompt in ${locale}`, () => {
        const text = build(locale);
        expect(text).toContain(createTranslator(locale, "prompt")("documentLanguagePolicy"));
      });
    }

    it(`${name} sends no Japanese when the UI is English`, () => {
      const leaked = [...build("en")].filter((character) => JAPANESE.test(character));
      expect([...new Set(leaked)].join(""), `${name} leaked Japanese`).toBe("");
    });
  }
});

describe("resolveDesktopPromptLocale", () => {
  it("falls back to the default when nothing is configured", () => {
    // 保存された設定が無く OS ロケールも解釈できない環境 (CI / 初回起動) では
    // 既定へ落ちる。ここが未定義を返すと i18next が言語未指定で解決に失敗する。
    expect(resolveDesktopPromptLocale("/nonexistent-data-dir")).toBe("ja");
    expect(resolveDesktopPromptLocale("/nonexistent-data-dir", "xx-YY")).toBe("ja");
  });

  it("accepts an OS locale when there is no saved setting", () => {
    expect(resolveDesktopPromptLocale("/nonexistent-data-dir", "en-US")).toBe("en");
  });
});

const SPEC = {
  execPath: "/bin/node",
  scriptPath: "/app/server.js",
  userDataDir: "/data",
  runContextFile: "/data/run.json",
  renderBridgeFile: "/data/bridge.json",
  uiLocale: "en" as const,
};

describe("validation locale reaches the MCP server process", () => {
  /**
   * MCP サーバーは**別プロセス**なので、renderer のロケールも main の
   * `setValidationLocale` も届かない。env に載せ損ねると、その provider の検証
   * フィードバックだけが既定 (日本語) のまま英語 UI へ返る。
   *
   * **`buildSigmaStudioMcpEnv` を直接呼ぶだけでは意味が無い** — 本番で渡し忘れる
   * のは呼び出し側なので、各 provider が実際に書き出す設定から env を読む
   * (最初この検査を入口だけで書いてしまい、4 呼び出し元のうち 3 つが渡し忘れて
   * いるのを見逃した: code-review 指摘)。
   */
  it("carries the locale in the Claude MCP config", () => {
    const config = buildClaudeMcpConfig({ ...SPEC, provider: "claude" });
    expect(config.mcpServers["sigma-studio-local"]?.env?.[VALIDATION_LOCALE_ENV]).toBe("en");
  });

  it("carries the locale in the Codex agent config", () => {
    const toml = buildCodexAgentConfigToml({ ...SPEC, provider: "chatgpt", webSearchEnabled: false });
    expect(toml).toContain(`${VALIDATION_LOCALE_ENV} = "en"`);
  });

  it("carries the locale in the Antigravity workspace settings", () => {
    const settings = buildGeminiWorkspaceSettings({ ...SPEC, provider: "antigravity" });
    expect(settings["mcpServers"]?.["sigma-studio-local"]?.env?.[VALIDATION_LOCALE_ENV]).toBe("en");
  });
});

/**
 * ビルダーが `uiLocale` を運ぶことと、**呼び出し側がその時点の言語を渡すこと**は別問題。
 *
 * H1 はまさにここをすり抜けた: ビルダーは正しかったが、Codex の config.toml は
 * 起動時に 1 度書かれるだけで、`settings:set-ui-locale` が常駐 app-server へ何も
 * 伝えていなかったため、言語を切り替えても MCP サーバーはアプリ再起動まで
 * 元の言語のままだった。ビルダーを直接叩く検査では永久に緑になる。
 */
describe("changing the UI language reaches the resident Codex app-server", () => {
  function makeClient(): { toml: () => string; client: CodexAppServerClient } {
    let uiLocale: AppLocale = "ja";
    const client = new CodexAppServerClient({
      codexHome: "/tmp/codex-home",
      configToml: buildCodexAgentConfigToml({ ...SPEC, uiLocale, provider: "chatgpt", webSearchEnabled: false }),
      uiLocale,
      buildConfigToml: (webSearchEnabled, locale) => {
        uiLocale = locale;
        return buildCodexAgentConfigToml({ ...SPEC, uiLocale: locale, provider: "chatgpt", webSearchEnabled });
      },
    });
    return { client, toml: () => buildCodexAgentConfigToml({ ...SPEC, uiLocale, provider: "chatgpt", webSearchEnabled: false }) };
  }

  it("rebuilds config.toml with the new locale", () => {
    const { client, toml } = makeClient();
    expect(toml()).toContain(`${VALIDATION_LOCALE_ENV} = "ja"`);

    client.setUiLocale("en");

    expect(toml()).toContain(`${VALIDATION_LOCALE_ENV} = "en"`);
  });

  it("does nothing when the locale is unchanged", () => {
    const { client } = makeClient();
    let rebuilds = 0;
    const spied = new CodexAppServerClient({
      codexHome: "/tmp/codex-home",
      configToml: "",
      uiLocale: "ja",
      buildConfigToml: () => { rebuilds += 1; return ""; },
    });
    spied.setUiLocale("ja");
    expect(rebuilds).toBe(0);
    spied.setUiLocale("en");
    expect(rebuilds).toBe(1);
    client.dispose();
    spied.dispose();
  });

  /**
   * `settings:set-ui-locale` が伝搬を落としていないことを、ハンドラ本体の
   * ソースで確かめる。IPC 登録ごと動かすには Electron 実体が要るので、
   * 「web検索は伝えているのに言語は伝えていない」という**非対称そのもの**を見る。
   */
  it("propagates from the settings IPC handler, like the web-search setting does", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./ipc/settings.ts", import.meta.url)),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf('ipcMain.handle("settings:set-ui-locale"'),
      source.indexOf('ipcMain.handle("settings:set-ai-auto-apply-verified-proposals"'),
    );
    expect(handler).toContain("codexAppServerClient.setUiLocale(");
  });
});