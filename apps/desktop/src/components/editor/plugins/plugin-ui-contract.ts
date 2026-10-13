/** Presentation contract only; distribution and execution belong to the desktop host. */
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
export interface OfficialPluginStatus {
  available: boolean;
  requiresLogin: boolean;
  requiresRole?: boolean;
  autoUpdate: boolean;
  phase: "idle" | "checking" | "installing";
  plugins: OfficialPluginRow[];
  error?: "unavailable" | "unauthorized" | "forbidden" | "incompatible" | "verification-failed" | "busy";
}
export interface OfficialPluginBridge {
  status(): Promise<OfficialPluginStatus>;
  check(): Promise<OfficialPluginStatus>;
  install(id: string): Promise<OfficialPluginStatus>;
  setEnabled(id: string, enabled: boolean): Promise<OfficialPluginStatus>;
  setAutoUpdate(enabled: boolean): Promise<OfficialPluginStatus>;
  onChange(listener: (status: OfficialPluginStatus) => void): () => void;
}
export function getOfficialPluginBridge(): OfficialPluginBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sigmaPlugins?: OfficialPluginBridge }).sigmaPlugins ?? null;
}
