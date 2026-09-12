import type { InlineNode, SigmaCommentAnchor } from "@/features/document";

/** 保存インジケータが表示する状態。 */
export type EditorSaveState = "idle" | "saving" | "saved" | "warning" | "error";

/**
 * 編集中のインライン数式。`updateTex` はその数式ノードに書き戻すコールバックで、
 * 数式ダイアログとツールバーが同じ 1 つの編集対象を共有するためにここに置く。
 */
export interface EditorSelectedInlineMath {
  id: string;
  tex: string;
  cursor: number;
  blockId?: string;
  setCursor?: (cursor: number) => void;
  updateTex: (tex: string, cursor?: number) => void;
}

/** `useState` のセッタと同じ「値または更新関数」。移行元の呼び出し方をそのまま使える。 */
export type EditorStateUpdate<T> = T | ((current: T) => T);

export interface EditorSelectionSlice {
  selectedId: string | null;
  selectedInlineMath: EditorSelectedInlineMath | null;
  setSelectedId: (update: EditorStateUpdate<string | null>) => void;
  setSelectedInlineMath: (update: EditorStateUpdate<EditorSelectedInlineMath | null>) => void;
}

export interface EditorCommentSlice {
  /** 選択範囲から作れる「まだ確定していない」コメントアンカー。 */
  commentAnchorCandidate: SigmaCommentAnchor | null;
  /** コメント作成中のアンカー (入力欄が開いている)。 */
  pendingCommentAnchor: SigmaCommentAnchor | null;
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  commentReplyDrafts: Record<string, InlineNode[]>;
  setCommentAnchorCandidate: (update: EditorStateUpdate<SigmaCommentAnchor | null>) => void;
  setPendingCommentAnchor: (update: EditorStateUpdate<SigmaCommentAnchor | null>) => void;
  setActiveCommentThreadId: (update: EditorStateUpdate<string | null>) => void;
  setHighlightedCommentThreadId: (update: EditorStateUpdate<string | null>) => void;
  setCommentReplyDraft: (threadId: string, draft: InlineNode[] | null) => void;
  clearCommentReplyDrafts: () => void;
}

export interface EditorSaveSlice {
  saveState: EditorSaveState;
  statusMessage: string;
  setSaveState: (update: EditorStateUpdate<EditorSaveState>) => void;
  setStatusMessage: (update: EditorStateUpdate<string>) => void;
}

/** ホワイトボードのカメラのパン成分 (画面px)。倍率と組で 1 つのカメラを成す。 */
export interface EditorWhiteboardPan {
  panX: number;
  panY: number;
}

export interface EditorToolbarSlice {
  zoom: number;
  /**
   * パンを倍率と同じストアに置く理由: ホイールは React の外 (native リスナ) から来るので、
   * ストア購読の再レンダーとコンポーネント state の更新では優先度 (lane) が違い、自動バッチでも
   * 1 つの commit にまとまらない。別々に持つとホイール 1 発ごとに「倍率は新しいがパンは
   * 1 フレーム古い」= 左上原点で拡大した絵が挟まる。
   */
  whiteboardPan: EditorWhiteboardPan;
  outlineOpen: boolean;
  outlineWidth: number;
  setZoom: (update: EditorStateUpdate<number>) => void;
  setWhiteboardPan: (update: EditorStateUpdate<EditorWhiteboardPan>) => void;
  /** 倍率とパンを 1 回の set で更新する。錨つきズームは必ずこちらを使う。 */
  setWhiteboardCamera: (zoom: number, pan: EditorWhiteboardPan) => void;
  setOutlineOpen: (update: EditorStateUpdate<boolean>) => void;
  setOutlineWidth: (update: EditorStateUpdate<number>) => void;
}

export type EditorState =
  & EditorSelectionSlice
  & EditorCommentSlice
  & EditorSaveSlice
  & EditorToolbarSlice;

export interface EditorStateInitializer {
  selectedId?: string | null;
  zoom?: number;
  outlineOpen?: boolean;
  outlineWidth?: number;
  statusMessage?: string;
}
