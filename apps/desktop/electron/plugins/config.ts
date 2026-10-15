import type { PluginConfig } from "./host";

/** リリースビルドが埋め込む取得先と公開鍵。設定が無いビルドでは拡張機能の取得は「利用できません」になる。 */
declare const __SIGMA_EXTENSIONS_CONFIG__: PluginConfig | null;

export function extensionsBuildConfig(): PluginConfig | null {
  return typeof __SIGMA_EXTENSIONS_CONFIG__ === "undefined" ? null : __SIGMA_EXTENSIONS_CONFIG__;
}
