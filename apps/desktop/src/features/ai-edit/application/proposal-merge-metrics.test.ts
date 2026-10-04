import { describe, expect, it, vi } from "vitest";

import { createEmptyProposalMergeReport } from "@/lib/ai/proposal-merge-basis";

import {
  AI_PROPOSAL_ADOPTION_MERGE_COUNTERS,
  AI_PROPOSAL_MERGE_COUNTERS,
  countAdoptionMergeFallbacks,
  countProposalMergeFallbacks,
} from "./proposal-merge-metrics";

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

describe("countAdoptionMergeFallbacks", () => {
  it("counts nothing for an adoption that merged nothing", () => {
    const count = vi.fn();

    countAdoptionMergeFallbacks(createEmptyProposalMergeReport(), count);
    countAdoptionMergeFallbacks(undefined, count);

    expect(count).not.toHaveBeenCalled();
  });

  it("counts the merged units and every fallback, once per occurrence", () => {
    const count = vi.fn();

    countAdoptionMergeFallbacks({
      ...createEmptyProposalMergeReport(),
      humanEditedUnits: ["p_1", "$"],
      overlaps: ["#p_1.children"],
      capped: true,
      reidentified: 2,
      editBeatsDelete: ["#p_2"],
      invalidAfterMerge: 1,
    }, count);

    const counted = count.mock.calls.map(([name]) => name);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.mergedUnits)).toHaveLength(2);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.overlaps)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.capped)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.reidentified)).toHaveLength(2);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.editBeatsDelete)).toHaveLength(1);
    expect(counted.filter((name) => name === AI_PROPOSAL_ADOPTION_MERGE_COUNTERS.invalidAfterMerge)).toHaveLength(1);
    expect(counted).toHaveLength(8);
  });

  it("names the counters under AiProposalMerge.adoption, apart from the approval's", () => {
    expect(Object.values(AI_PROPOSAL_ADOPTION_MERGE_COUNTERS).sort()).toEqual([
      "AiProposalMerge.adoption.capped",
      "AiProposalMerge.adoption.editBeatsDelete",
      "AiProposalMerge.adoption.invalidAfterMerge",
      "AiProposalMerge.adoption.mergedUnits",
      "AiProposalMerge.adoption.overlaps",
      "AiProposalMerge.adoption.reidentified",
    ]);
  });
});
