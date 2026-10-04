import type { ProposalMergeReport } from "@/lib/ai/proposal-merge-basis";
import { countPerformanceEvent } from "@/lib/performance";

/**
 * Counters for the fallbacks an approval's merging replay took (MISS R3). An approval that did not
 * overlap any human edit leaves all of them at zero; e2e tests read them from
 * `window.__SIGMA_STUDIO_PERFORMANCE__.counters`.
 */
export const AI_PROPOSAL_MERGE_COUNTERS = {
  overlaps: "AiProposalMerge.overlaps",
  capped: "AiProposalMerge.capped",
  reidentified: "AiProposalMerge.reidentified",
  editBeatsDelete: "AiProposalMerge.editBeatsDelete",
  invalidAfterMerge: "AiProposalMerge.invalidAfterMerge",
  anchorRelocated: "AiProposalMerge.anchorRelocated",
  legacyNoBase: "AiProposalMerge.legacyNoBase",
} as const;

/** Counts each fallback of an approval's merge report once per occurrence. */
export function countProposalMergeFallbacks(
  report: ProposalMergeReport | undefined,
  count: (name: string) => void = countPerformanceEvent,
): void {
  if (!report) {
    return;
  }
  const occurrences: Array<[string, number]> = [
    [AI_PROPOSAL_MERGE_COUNTERS.overlaps, report.overlaps.length],
    [AI_PROPOSAL_MERGE_COUNTERS.capped, report.cappedPaths.length || (report.capped ? 1 : 0)],
    [AI_PROPOSAL_MERGE_COUNTERS.reidentified, report.reidentified],
    [AI_PROPOSAL_MERGE_COUNTERS.editBeatsDelete, report.editBeatsDelete.length],
    [AI_PROPOSAL_MERGE_COUNTERS.invalidAfterMerge, report.invalidAfterMerge],
    [AI_PROPOSAL_MERGE_COUNTERS.anchorRelocated, report.anchorRelocated],
    [AI_PROPOSAL_MERGE_COUNTERS.legacyNoBase, report.legacyNoBase],
  ];
  for (const [name, times] of occurrences) {
    for (let index = 0; index < times; index += 1) {
      count(name);
    }
  }
}
