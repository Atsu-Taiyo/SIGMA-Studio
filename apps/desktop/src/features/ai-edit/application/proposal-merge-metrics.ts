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

/**
 * Counters for the merge the renderer runs when it adopts an approved document: the human typed
 * during the approval round trip and the typing is merged with the AI's result. Adopting without
 * such typing, or with typing only in units the AI did not change, leaves all of them at zero.
 * `mergedUnits` counts units both sides changed (merged instead of taking the AI's version whole);
 * `droppedHumanEdits` / `droppedAiEdits` count places where one side's change is not in the result
 * (the human's input replaced by the AI's, or an approved AI edit not applied).
 */
export const AI_PROPOSAL_ADOPTION_MERGE_COUNTERS = {
  mergedUnits: "AiProposalMerge.adoption.mergedUnits",
  overlaps: "AiProposalMerge.adoption.overlaps",
  capped: "AiProposalMerge.adoption.capped",
  reidentified: "AiProposalMerge.adoption.reidentified",
  editBeatsDelete: "AiProposalMerge.adoption.editBeatsDelete",
  invalidAfterMerge: "AiProposalMerge.adoption.invalidAfterMerge",
  droppedHumanEdits: "AiProposalMerge.adoption.droppedHumanEdits",
  droppedAiEdits: "AiProposalMerge.adoption.droppedAiEdits",
} as const;

/** Counts each fallback of an approval's merge report once per occurrence. */
export function countProposalMergeFallbacks(
  report: ProposalMergeReport | undefined,
  count: (name: string) => void = countPerformanceEvent,
): void {
  if (!report) {
    return;
  }
  countOccurrences([
    [AI_PROPOSAL_MERGE_COUNTERS.overlaps, report.overlaps.length],
    [AI_PROPOSAL_MERGE_COUNTERS.capped, cappedOccurrences(report)],
    [AI_PROPOSAL_MERGE_COUNTERS.reidentified, report.reidentified],
    [AI_PROPOSAL_MERGE_COUNTERS.editBeatsDelete, report.editBeatsDelete.length],
    [AI_PROPOSAL_MERGE_COUNTERS.invalidAfterMerge, report.invalidAfterMerge],
    [AI_PROPOSAL_MERGE_COUNTERS.anchorRelocated, report.anchorRelocated],
    [AI_PROPOSAL_MERGE_COUNTERS.legacyNoBase, report.legacyNoBase],
  ], count);
}

/** Counts what the adoption merge of an approved document decided, once per occurrence. */
export function countAdoptionMergeFallbacks(
  report: ProposalMergeReport | undefined,
  count: (name: string) => void = countPerformanceEvent,
): void {
  if (!report) {
    return;
  }
  countOccurrences([
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.mergedUnits, report.humanEditedUnits.length],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.overlaps, report.overlaps.length],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.capped, cappedOccurrences(report)],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.reidentified, report.reidentified],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.editBeatsDelete, report.editBeatsDelete.length],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.invalidAfterMerge, report.invalidAfterMerge],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.droppedHumanEdits, report.droppedHumanEdits?.length ?? 0],
    [AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.droppedAiEdits, report.droppedAiEdits?.length ?? 0],
  ], count);
}

function cappedOccurrences(report: ProposalMergeReport): number {
  return report.cappedPaths.length || (report.capped ? 1 : 0);
}

function countOccurrences(occurrences: Array<[string, number]>, count: (name: string) => void): void {
  for (const [name, times] of occurrences) {
    for (let index = 0; index < times; index += 1) {
      count(name);
    }
  }
}
