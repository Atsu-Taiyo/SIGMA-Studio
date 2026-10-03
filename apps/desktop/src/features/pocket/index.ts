/**
 * ポケット: 編集画面の上にある、コピーと同じ内容を複数・何度でも持ち運べる一時置き場。
 *
 * 公開するのは、紙面の高さを決める姿の購読、ポケットの UI、コマンドから呼ぶ操作だけ。
 * 中身 (項目の並び) はアプリの作業台で、教材の保存・共有・履歴には載らない。
 */
export { getPocketPhase, togglePocketExpanded, usePocketPhase } from "./application/pocket-store";
export type { PocketPhase } from "./application/pocket-store";
export { addSelectionToPocket, insertPocketItem } from "./application/pocket-transfer";
export type { PocketAddResult, PocketInsertResult } from "./application/pocket-transfer";
export { PocketBar, PocketIcon } from "./view/PocketBar";
