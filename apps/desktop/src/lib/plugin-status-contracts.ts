/**
 * 公式プラグイン (拡張機能) の状態を、ホスト (Electron の main) と設定画面の間で受け渡す型。
 * 配布・検証・実行はホストが持ち、画面は受け取った状態を描くだけ。
 */
export interface OfficialPluginRow {
  id: string;
  name: string;
  description: string;
  latestVersion?: string;
  installedVersion?: string;
  enabled: boolean;
  compatible: boolean;
  authorized?: boolean;
  fonts?: string[];
}

export interface OfficialOrganization {
  id: string;
  name: string;
  /** 特権側 (ホスト) が検証した画像データ。 */
  logoUrl?: string | null;
}

export type OfficialPluginErrorCode =
  | "unavailable"
  | "unauthorized"
  | "forbidden"
  | "incompatible"
  | "verification-failed"
  | "busy";

export interface OfficialPluginStatus {
  available: boolean;
  requiresLogin: boolean;
  requiresRole?: boolean;
  autoUpdate: boolean;
  phase: "idle" | "checking" | "installing";
  plugins: OfficialPluginRow[];
  organizations?: OfficialOrganization[];
  error?: OfficialPluginErrorCode;
}

export interface OfficialPluginBridge {
  status(): Promise<OfficialPluginStatus>;
  check(): Promise<OfficialPluginStatus>;
  install(id: string): Promise<OfficialPluginStatus>;
  setEnabled(id: string, enabled: boolean): Promise<OfficialPluginStatus>;
  setAutoUpdate(enabled: boolean): Promise<OfficialPluginStatus>;
  onChange(listener: (status: OfficialPluginStatus) => void): () => void;
}
