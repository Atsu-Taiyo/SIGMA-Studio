import type {
  BoxBlockNode,
  CodeBlockNode,
  DividerNode,
  HeadingNode,
  LayoutSectionNode,
  ListNode,
  ParagraphNode,
  ProblemNode,
  QuoteBlockNode,
  SectionNode,
} from "@/features/document";

/**
 * SigmaDoc blocks that participate in the continuous body-text projection.
 *
 * This is an editor-facing projection of the canonical document model. It
 * deliberately excludes page overlays and other page-only records.
 */
export type TextFlowBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode
  | LayoutSectionNode
  | ProblemNode;

/**
 * Port used by text-editing application operations whenever a new persisted
 * SigmaDoc node must be created.
 */
export type TextFlowIdFactory = (prefix: string) => string;

export interface TextPageBreakRequestDetail {
  blockId: string;
  enabled: boolean;
  documentNextBlockId?: string | null;
  /**
   * 区切りを入れるキャレット。`/` コマンド・ショートカットのように、打った面が位置を知っている
   * ときに渡す (分割されたブロックの続きの面で打っても、正本の面が同じ位置で区切る)。
   */
  selection?: ManualTextPageBreakSelection | null;
  /** 文書全体を見て、その位置で区切ると空のページ (段) ができないか。ホストが渡す。 */
  canInsertAt?: (point: ManualTextPageBreakSelection) => boolean;
  handled?: boolean;
  /** 受け付けたが、空のページができるので何もしなかった。 */
  rejected?: boolean;
  focusBlockId?: string;
  focusPosition?: "start" | "end";
  /** 区切りの後ろのキャレット (葉ブロックと offset)。区切りを入れたエディタが決める。 */
  focusAddress?: import("./caret-bookmark").CaretAddress;
}

export interface ManualTextPageBreakSelection {
  blockId: string;
  offset: number;
}

export interface ManualTextPageBreakResult {
  blocks: TextFlowBlock[];
  focusBlockId: string;
  focusPosition: "start" | "end";
}
