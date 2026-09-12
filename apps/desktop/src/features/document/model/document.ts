import type { SigmaBlock } from "./blocks";
import type { SigmaCommentThread } from "./comments";
import type { SigmaMetadata } from "./metadata";
import type { PageLayout } from "./page-layout";

export type SigmaDocVersion = "2.0";
export type OutputProfileName = "student" | "teacher" | "answerBook";

export interface SigmaDocument {
  version: SigmaDocVersion;
  docId: string;
  metadata: SigmaMetadata;
  content: SigmaBlock[];
  outputProfiles: Record<OutputProfileName, OutputProfile>;
  comments?: SigmaCommentThread[];
  pageLayout?: PageLayout;
  updatedAt?: string;
}

export interface OutputProfile {
  showSolutions?: boolean;
  showHints?: boolean;
  includeAnswers?: boolean;
  onlySolutions?: boolean;
  includeComments?: boolean;
}
