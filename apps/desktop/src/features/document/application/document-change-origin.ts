/**
 * Where a document change comes from. A hold that only stops a person from changing what they cannot
 * see (an AI proposal shown as its result only) does not apply to an approved AI proposal being
 * applied or to a version restore. Absent means a human edit.
 */
export type DocumentChangeOrigin = "human-edit" | "ai-approval" | "history-restore";
