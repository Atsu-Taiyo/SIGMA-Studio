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
