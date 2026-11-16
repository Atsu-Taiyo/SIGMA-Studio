/** Opens the local manual from either application screen. No network is required. */
export const OPEN_USAGE_MANUAL_EVENT = "sigma-studio:open-usage-manual";
export function openUsageManual() {
  window.dispatchEvent(new Event(OPEN_USAGE_MANUAL_EVENT));
}
