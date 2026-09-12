/** 改行やブロック境界の前後どちら側に属するか。 */
export type CaretAffinity = "before" | "after";

/**
 * `"node"` は divider / boxBlock / layoutSection のように**ノードそのもの**を選んでいる状態
 * (ProseMirror の `NodeSelection`)。`"text"` はブロックの中の文字位置。
 */
export type CaretAddressKind = "text" | "node";

/**
 * 本文中の 1 つの論理位置。**必ず葉ブロック**を指す (コンテナ id を持たせると、復元側が
 * offset を文字位置として解釈できない)。
 */
export interface CaretAddress {
  blockId: string;
  /** ProseMirror-compatible offset inside the SigmaDoc text block. */
  offset: number;
  affinity: CaretAffinity;
  kind: CaretAddressKind;
}

/**
 * Ephemeral editor selection. This deliberately lives outside SigmaDoc: it is
 * session/history state, while SigmaDoc remains the persisted source of truth.
 */
export interface TextFlowSelectionBookmark {
  anchor: CaretAddress;
  head: CaretAddress;
  /** 上下移動の間だけ維持したい画面上の横位置。持っていなければ null。 */
  preferredX: number | null;
}

export function isCollapsedTextFlowSelection(
  selection: TextFlowSelectionBookmark,
): boolean {
  return selection.anchor.blockId === selection.head.blockId
    && selection.anchor.offset === selection.head.offset
    && selection.anchor.kind === selection.head.kind;
}
