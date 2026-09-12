// Compatibility facade: document text operations live in the text-editing feature.
export {
  countTextMatches,
  findFirstBlockWithText,
  replaceInDocument,
  updateInlineMathTexInDocument,
} from "@/features/text-editing";
