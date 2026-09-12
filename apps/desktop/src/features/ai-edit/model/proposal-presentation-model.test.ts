import { describe, expect, it } from "vitest";

import type { AiEditPreviewState } from "./preview";
import { deriveAiProposalPresentation } from "./proposal-presentation-model";

function previewGroup(
  proposalIds: string[],
  roomId?: string,
): AiEditPreviewState {
  return {
    targetId: proposalIds[0] ?? "",
    draft: {
      summary: proposalIds.join(","),
      plan: [],
      operations: [],
      warnings: [],
    },
    createdAt: 0,
    proposalIds,
    baseRevision: 1,
    providers: [],
    roomId,
  };
}

const isActive = (status: string | undefined) => (
  status === "preparing"
  || status === "waiting"
  || status === "running"
  || status === "applying"
);

describe("deriveAiProposalPresentation", () => {
  it("hides only the active room's proposal and preserves visible proposal order", () => {
    const groups = [
      previewGroup(["unattributed"]),
      previewGroup(["active-1", "active-2"], "room-active"),
      previewGroup(["completed"], "room-completed"),
      previewGroup(["missing-session"], "room-missing"),
    ];
    const sessions = new Map([
      ["room-active", { status: "running", anchor: { documentId: "file-1" } }],
      ["room-completed", { status: "completed", anchor: { documentId: "file-1" } }],
    ]);

    const result = deriveAiProposalPresentation(groups, sessions, "file-1", isActive);

    expect(result.previewGroups).toEqual([
      groups[0],
      groups[2],
      groups[3],
    ]);
    expect(result.allVisibleProposalIds).toEqual([
      "unattributed",
      "completed",
      "missing-session",
    ]);
  });

  it("reports an active run without deriving any document-wide edit lock from it", () => {
    const result = deriveAiProposalPresentation(
      [previewGroup(["proposal-1"], "room-1")],
      new Map([[
        "room-1",
        { status: "applying", anchor: { documentId: "file-1" } },
      ]]),
      "file-1",
      isActive,
    );

    expect(result.hasActiveRunForDocument).toBe(true);
    // Editability is decided per target (useAiLockedTargets), never from here.
    expect(result).not.toHaveProperty("documentEditLockReason");
    expect(result).not.toHaveProperty("documentEditLocked");
    expect(result).not.toHaveProperty("documentEditLockMessage");
  });

  it("keeps a pending group visible after its run finishes", () => {
    const groups = [previewGroup(["proposal-1"], "room-1")];
    const result = deriveAiProposalPresentation(
      groups,
      new Map([[
        "room-1",
        { status: "completed", anchor: { documentId: "file-1" } },
      ]]),
      "file-1",
      isActive,
    );

    expect(result.hasActiveRunForDocument).toBe(false);
    expect(result.previewGroups).toEqual(groups);
    expect(result.allVisibleProposalIds).toEqual(["proposal-1"]);
  });

  it("does not attribute a background document's run to the active document", () => {
    const result = deriveAiProposalPresentation(
      [],
      new Map([[
        "room-background",
        { status: "running", anchor: { documentId: "file-2" } },
      ]]),
      "file-1",
      isActive,
    );

    expect(result.previewGroups).toEqual([]);
    expect(result.hasActiveRunForDocument).toBe(false);
  });
});
