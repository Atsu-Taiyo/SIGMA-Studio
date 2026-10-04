import { describe, expect, it, vi } from "vitest";

import { createEmptyProposalMergeReport } from "@/lib/ai/proposal-merge-basis";

import { AI_PROPOSAL_MERGE_COUNTERS, countProposalMergeFallbacks } from "./proposal-merge-metrics";

describe("countProposalMergeFallbacks", () => {
  it("counts nothing for an approval whose replay merged nothing", () => {
    const count = vi.fn();

    countProposalMergeFallbacks(createEmptyProposalMergeReport(), count);
    countProposalMergeFallbacks(undefined, count);

    expect(count).not.toHaveBeenCalled();
  });

  it("counts every fallback the merge took, once per occurrence", () => {
    const count = vi.fn();

    countProposalMergeFallbacks({
      ...createEmptyProposalMergeReport(),
      overlaps: ["#p_1.children", "#p_2.children"],
      capped: true,
      cappedPaths: ["#p_3.children"],
      reidentified: 1,
      editBeatsDelete: ["#p_4"],
      invalidAfterMerge: 2,
      anchorRelocated: 1,
      legacyNoBase: 3,
      humanEditedUnits: ["p_1", "p_2"],
    }, count);

    const counted = count.mock.calls.map(([name]) => name);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.overlaps)).toHaveLength(2);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.capped)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.reidentified)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.editBeatsDelete)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.invalidAfterMerge)).toHaveLength(2);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.anchorRelocated)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_MERGE_COUNTERS.legacyNoBase)).toHaveLength(3);
    expect(counted).toHaveLength(11);
  });

  it("names the counters under AiProposalMerge", () => {
    expect(Object.values(AI_PROPOSAL_MERGE_COUNTERS).sort()).toEqual([
      "AiProposalMerge.anchorRelocated",
      "AiProposalMerge.capped",
      "AiProposalMerge.editBeatsDelete",
      "AiProposalMerge.invalidAfterMerge",
      "AiProposalMerge.legacyNoBase",
      "AiProposalMerge.overlaps",
      "AiProposalMerge.reidentified",
    ]);
  });
});
