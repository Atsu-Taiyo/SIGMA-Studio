/** Store changes consumed by desktop listeners and storage adapters. */
export type LocalStoreChangeEvent =
  | {
      type: "documentVersion";
      fileId: string;
      change: "captured" | "pruned";
      timestamp: number;
    }
  | {
      type: "document";
      fileId: string;
      change: "changed" | "deleted";
      timestamp: number;
      /** main側の検証済み自動承認がこの保存を作った場合の提案ID。 */
      autoAppliedProposalIds?: string[];
    }
  | {
      type: "workspace";
      timestamp: number;
    }
  | {
      type: "library";
      timestamp: number;
    }
  | {
      type: "watcher";
      scope: "documents" | "library";
      change: "failed" | "recovered";
      timestamp: number;
    };
