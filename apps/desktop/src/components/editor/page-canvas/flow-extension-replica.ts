import { createContext, useContext } from "react";

/**
 * フロー内の拡張ノードの中身が「続きの複製」(ページ・段の境目で切れたノードの次の帯) として
 * 描かれているか。複製は同じ `content` をもう一度描くだけなので、中身は自分がどちらで描かれて
 * いるかをこれで知り、操作の結果 (ポップオーバーなど) を正本の側にだけ出す。寸法は正本と同じに保つ
 * (複製は正本と同じ組版を前提に帯をずらして切り取る)。
 */
export const FlowExtensionReplicaContext = createContext(false);

export function useIsFlowExtensionReplica(): boolean {
  return useContext(FlowExtensionReplicaContext);
}
