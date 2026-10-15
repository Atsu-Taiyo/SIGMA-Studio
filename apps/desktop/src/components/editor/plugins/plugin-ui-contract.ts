/** Presentation contract only; distribution and execution belong to the desktop host. */
export type {
  OfficialOrganization,
  OfficialPluginBridge,
  OfficialPluginRow,
  OfficialPluginStatus,
} from "@/lib/plugin-status-contracts";
import type { OfficialPluginBridge } from "@/lib/plugin-status-contracts";

export function getOfficialPluginBridge(): OfficialPluginBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { sigmaPlugins?: OfficialPluginBridge }).sigmaPlugins ?? null;
}
