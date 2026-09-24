import type { ServerCollaborationCapabilities } from "./catalog";

/**
 * Hosted plan terms shown by the paywall. Prices are presented in USD
 * only; there is intentionally no local-currency conversion. Checkout is not
 * implemented yet, so these values never decide server authorization.
 */
export const FREE_PLAN = {
  priceUsd: 0,
} as const;

export const PRO_PLAN = {
  priceUsd: 9,
  collaboratorLimit: 15,
} as const;

/** What the free plan already allows; Pro lists only what it adds. */
export const FREE_PLAN_FEATURES = [
  "editing",
  "documentSharing",
  "joining",
  "basicRoles",
] as const;
export type FreePlanFeature = (typeof FREE_PLAN_FEATURES)[number];

export const PRO_PLAN_FEATURES = [
  "collaborators",
  "unlimitedDocuments",
  "workspaceSharing",
  "roles",
] as const;
export type ProPlanFeature = (typeof PRO_PLAN_FEATURES)[number];

/** `unavailable` means this server does not offer hierarchy sharing at all. */
export type CollaborationPlanState = "unavailable" | "free" | "trial" | "pro";

export function collaborationPlanState(
  capabilities: ServerCollaborationCapabilities | undefined,
): CollaborationPlanState {
  if (!capabilities?.hierarchySharingEnabled) return "unavailable";
  if (capabilities.hierarchyShareSource === "entitlement") return "pro";
  if (capabilities.hierarchyShareSource === "trial") return "trial";
  return "free";
}

/**
 * Folder and workspace sharing is the plan boundary. Individual documents stay
 * free, and a server that disables hierarchy sharing is not an upgrade case.
 */
export function hierarchyShareNeedsUpgrade(
  capabilities: ServerCollaborationCapabilities | undefined,
): boolean {
  return capabilities?.hierarchySharingEnabled === true && !capabilities.canStartHierarchyShare;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Why the paywall opened. The paywall states this reason first, so a blocked
 * action always explains itself where the upgrade is offered.
 */
export type PlanPaywallReason = "hierarchyShare" | "documentLimit" | "participantLimit" | "adminRole";

/** Server codes that mean "this owner's plan does not allow it". */
const PLAN_LIMIT_CODES = ["DOCUMENT_LIMIT", "PARTICIPANT_LIMIT", "PRO_REQUIRED"] as const;

/**
 * Maps a failed owner-side sharing action to the paywall reason, or `null` when
 * the failure is not about the plan. `PRO_REQUIRED` is ambiguous on the server
 * (hierarchy share or admin role), so the caller says what it attempted.
 */
export function planPaywallReasonFromError(
  error: unknown,
  attempted: "hierarchyShare" | "documentShare" | "adminRole" | "invite",
): PlanPaywallReason | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = PLAN_LIMIT_CODES.find((candidate) => message.includes(candidate));
  if (!code) return null;
  if (code === "DOCUMENT_LIMIT") return "documentLimit";
  if (code === "PARTICIPANT_LIMIT") return "participantLimit";
  if (attempted === "adminRole") return "adminRole";
  if (attempted === "hierarchyShare") return "hierarchyShare";
  return null;
}

/**
 * Free owners have one participant seat; seats are counted when an invitation is
 * accepted. Creating another invitation once the seat is taken cannot succeed, so
 * the paywall opens at the attempt instead of failing later for the invitee.
 */
export function freeParticipantSeatTaken(
  capabilities: ServerCollaborationCapabilities | undefined,
  participants: readonly { role: string }[],
): boolean {
  if (collaborationPlanState(capabilities) !== "free") return false;
  const limit = capabilities?.participantLimit;
  if (typeof limit !== "number") return false;
  return participants.filter((participant) => participant.role !== "owner").length >= limit;
}
