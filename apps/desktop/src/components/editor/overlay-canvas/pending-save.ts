import type { OverlayChangeHistory } from "../page-overlay-types";
export interface PendingOverlaySave {
  history: OverlayChangeHistory;
  /** 本文と 1 エントリに畳むためのコアレスキー。無関係な変更が割り込んだら null に落とす。 */
  historyGroup: string | null;
}
