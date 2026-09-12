// 検証済み自動承認 (aiAutoApplyVerifiedProposals) は、人間がアクティブに教材を編集している
// 最中でも発火しうる (= 自動保存の直後にファイル変更を検知して即承認してしまう) と、
// タイピング中に画面が差し替わる体験になってしまう。main.ts の runAutoApplyCheck は、対象
// fileId への「renderer からの保存IPC (storage:save-document)」の直近タイムスタンプを見て、
// AUTO_APPLY_DEFER_MS 未満ならその教材への自動承認を1回スキップする。判定だけを純粋関数として
// 切り出し、main.ts 側のI/O(タイマー管理・実際のスキップ)から独立にテストできるようにする。
//
// 承認IPC・revert等、renderer保存以外の保存経路ではタイムスタンプを記録しない
// (それらは人間のアクティブな編集ではないため、自動承認を遅らせる理由がない)。

export const AUTO_APPLY_DEFER_MS = 2000;

/**
 * lastRendererSaveAt (その教材への直近のrenderer保存時刻。記録が無ければ undefined) を基準に、
 * 自動承認を今回は見送るべきかを判定する。人間がタイプし続けている限り呼び出すたびに
 * lastRendererSaveAt が更新され続けるため、このチェックは延期され続け、手が止まって
 * AUTO_APPLY_DEFER_MS が経過して初めて false (=進めてよい) になる。
 */
export function shouldDeferAutoApply(lastRendererSaveAt: number | undefined, now: number): boolean {
  return lastRendererSaveAt !== undefined && now - lastRendererSaveAt < AUTO_APPLY_DEFER_MS;
}
