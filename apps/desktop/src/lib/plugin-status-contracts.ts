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

/**
 * 追加・更新の進み具合。ダウンロードが要るのは、このPCにまだ無いファイルだけ。
 * - verifying: このPCにある同じ内容のファイル (前の版・中断した取得) を確かめて使う
 * - downloading: 残りのファイルを取得する
 * - waiting: 動いている変換が終わるのを待つ
 * - registering: 付属フォントを登録する
 */
export interface OfficialPluginProgress {
  pluginId: string;
  stage: "verifying" | "downloading" | "waiting" | "registering";
  /** この版のファイル数と、そのうち用意できた数。 */
  files: number;
  completedFiles: number;
  /** ダウンロードせずに、このPCにあるものを使ったファイル数。 */
  reusedFiles: number;
  /** ダウンロードが必要なバイト数と、受け取ったバイト数。 */
  downloadBytes: number;
  receivedBytes: number;
}

export interface OfficialPluginStatus {
  available: boolean;
  requiresLogin: boolean;
  requiresRole?: boolean;
  offline?: boolean;
  offlineUntil?: string;
  autoUpdate: boolean;
  phase: "idle" | "checking" | "installing";
  plugins: OfficialPluginRow[];
  organizations?: OfficialOrganization[];
  error?: OfficialPluginErrorCode;
  /** phase が installing の間だけ。 */
  progress?: OfficialPluginProgress;
}

export interface OfficialPluginBridge {
  status(): Promise<OfficialPluginStatus>;
  check(): Promise<OfficialPluginStatus>;
  install(id: string): Promise<OfficialPluginStatus>;
  setEnabled(id: string, enabled: boolean): Promise<OfficialPluginStatus>;
  setAutoUpdate(enabled: boolean): Promise<OfficialPluginStatus>;
  onChange(listener: (status: OfficialPluginStatus) => void): () => void;
}
