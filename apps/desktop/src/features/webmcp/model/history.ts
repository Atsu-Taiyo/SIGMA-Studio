/**
 * Web版でWebMCPの作業ドラフトが決着した記録。デスクトップの
 * `DesktopMcpEditProposalSummary` に当たるものがWebには無い (userDataへ書かない)
 * ため、ページを開いているあいだだけメモリに積む最小の形だけを持つ。
 *
 * 巻き戻し情報 (`appliedRevision`) は持たない。Webの取り消しは⌘Z一本で、
 * `commitDocumentChange` が1 undo単位になっている。
 */
export interface WebMcpHistoryEntry {
  /** 同じ固定提案IDで複数回決着しても重複しない、表示行用の識別子。 */
  entryId: string;
  id: string;
  status: "applied" | "rejected";
  operationCount: number;
  /** 変更対象の本文ブロック/図形ID。先頭だけを行の抜粋に使う。 */
  targetIds: string[];
  resolvedAt: number;
}

/** 表示に必要な範囲だけ残す。古いものから落ちる。 */
export const WEBMCP_HISTORY_LIMIT = 8;
