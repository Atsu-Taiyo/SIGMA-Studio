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
  handled?: boolean;
  focusBlockId?: string;
  focusPosition?: "start" | "end";
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
