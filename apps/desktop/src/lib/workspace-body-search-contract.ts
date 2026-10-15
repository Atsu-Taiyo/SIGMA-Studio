/** 本文のどこで一致したかを一覧に添えるための抜粋。`match` が検索語に当たった部分。 */
export interface WorkspaceBodySearchExcerpt {
  before: string;
  match: string;
  after: string;
}

export interface WorkspaceBodySearchHit {
  fileId: string;
  excerpt: WorkspaceBodySearchExcerpt;
}

/**
 * 本文検索の途中経過。1 つの検索語につき、最初の 1 通は `reset: true` (それまでの結果を捨てて
 * `hits` に置き換える)、以降は見つかった・外れた教材だけを足し引きする差分で届く。
 */
export interface WorkspaceBodySearchUpdate {
  /** どの検索語への答えか。画面は自分が最後に送った番号のものだけを使う。 */
  queryId: number;
  reset: boolean;
  hits: WorkspaceBodySearchHit[];
  /** 読み直したら一致しなくなった教材。 */
  removed: string[];
  /** まだ本文を読んでいない教材の数。0 になったら、この検索語の結果は出そろっている。 */
  pending: number;
}

/** 画面が持つ本文検索の口。開いている間は索引を作り続け、検索語を変えるたびに結果を流し直す。 */
export interface WorkspaceBodySearchHandle {
  setQuery(queryId: number, query: string): void;
  close(): void;
}

/** preload が公開する口。セッションは画面が作った ID で区別し、届く結果にも同じ ID が付く。 */
export interface WorkspaceBodySearchBridge {
  setQuery(sessionId: string, queryId: number, query: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  onUpdate(handler: (update: WorkspaceBodySearchUpdate & { sessionId: string }) => void): () => void;
}
