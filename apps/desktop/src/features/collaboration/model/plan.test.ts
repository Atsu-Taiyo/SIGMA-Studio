import { describe, expect, it } from "vitest";
import type { ServerCollaborationCapabilities } from "./catalog";
import { collaborationPlanState, FREE_PLAN, FREE_PLAN_FEATURES, formatUsd, hierarchyShareNeedsUpgrade, PRO_PLAN, PRO_PLAN_FEATURES } from "./plan";

const capabilities = (next: Partial<ServerCollaborationCapabilities>): ServerCollaborationCapabilities => ({
  canStartDocumentShare: true, documentShareSource: "free", hierarchySharingEnabled: true,
  canStartHierarchyShare: false,
  hierarchyShareSource: "none",
  ...next,
});

describe("collaboration plan", () => {
  it("offers Pro at nine US dollars per user with fifteen collaborators", () => {
    expect(formatUsd(FREE_PLAN.priceUsd)).toBe("$0");
    expect(FREE_PLAN_FEATURES).toEqual(["editing", "documentSharing", "joining", "basicRoles"]);
    expect(formatUsd(PRO_PLAN.priceUsd)).toBe("$9");
    expect(PRO_PLAN.collaboratorLimit).toBe(15);
    expect(PRO_PLAN_FEATURES).toEqual(["collaborators", "unlimitedDocuments", "workspaceSharing", "roles"]);
  });

  it("derives the displayed plan only from server capabilities", () => {
    expect(collaborationPlanState(undefined)).toBe("unavailable");
    expect(collaborationPlanState(capabilities({ canStartDocumentShare: true, documentShareSource: "free", hierarchySharingEnabled: false }))).toBe("unavailable");
    expect(collaborationPlanState(capabilities({}))).toBe("free");
    expect(collaborationPlanState(capabilities({ canStartHierarchyShare: true, hierarchyShareSource: "trial" }))).toBe("trial");
    expect(collaborationPlanState(capabilities({ canStartHierarchyShare: true, hierarchyShareSource: "entitlement" }))).toBe("pro");
  });

  it("asks for an upgrade only when the server offers hierarchy sharing but not to this owner", () => {
    expect(hierarchyShareNeedsUpgrade(capabilities({}))).toBe(true);
    expect(hierarchyShareNeedsUpgrade(capabilities({ canStartHierarchyShare: true, hierarchyShareSource: "trial" }))).toBe(false);
    expect(hierarchyShareNeedsUpgrade(capabilities({ canStartDocumentShare: true, documentShareSource: "free", hierarchySharingEnabled: false }))).toBe(false);
    expect(hierarchyShareNeedsUpgrade(undefined)).toBe(false);
  });
});

describe("paywall reasons", () => {
  it("maps plan-limit failures to the action that was attempted", async () => {
    const { planPaywallReasonFromError } = await import("./plan");
    const ipc = (code: string) => new Error(`Error invoking remote method 'shared-catalog:start': Error: ${code}`);
    expect(planPaywallReasonFromError(ipc("DOCUMENT_LIMIT"), "documentShare")).toBe("documentLimit");
    expect(planPaywallReasonFromError(ipc("PRO_REQUIRED"), "hierarchyShare")).toBe("hierarchyShare");
    expect(planPaywallReasonFromError(ipc("PRO_REQUIRED"), "adminRole")).toBe("adminRole");
    expect(planPaywallReasonFromError(ipc("PARTICIPANT_LIMIT"), "invite")).toBe("participantLimit");
    expect(planPaywallReasonFromError(ipc("PRO_REQUIRED"), "invite")).toBeNull();
    expect(planPaywallReasonFromError(ipc("FORBIDDEN"), "hierarchyShare")).toBeNull();
    expect(planPaywallReasonFromError(undefined, "documentShare")).toBeNull();
  });

  it("treats the free participant seat as taken only on the free plan", async () => {
    const { freeParticipantSeatTaken } = await import("./plan");
    const owner = { role: "owner" }, editor = { role: "editor" };
    expect(freeParticipantSeatTaken(capabilities({ participantLimit: 1 }), [owner])).toBe(false);
    expect(freeParticipantSeatTaken(capabilities({ participantLimit: 1 }), [owner, editor])).toBe(true);
    expect(freeParticipantSeatTaken(capabilities({ participantLimit: 15, canStartHierarchyShare: true, hierarchyShareSource: "entitlement" }), [owner, editor])).toBe(false);
    expect(freeParticipantSeatTaken(capabilities({}), [owner, editor])).toBe(false);
  });
});
