import type { TextFlowHeadingCommandRequest } from "@/components/editor/text-flow/types";
import { ensurePageLayout, type PageLayout, type SigmaDocument } from "@/features/document";

type UpdatePageLayoutAndMetadata = (
  pageLayout: PageLayout,
  metadata: SigmaDocument["metadata"],
) => void;

/** Slash-menu headings opt an unconfigured document into numbering without overriding a saved choice. */
export function handleHeadingCommandAutoNumbering(
  document: SigmaDocument,
  updatePageLayoutAndMetadata: UpdatePageLayoutAndMetadata,
  _request: TextFlowHeadingCommandRequest,
): boolean {
  void _request;
  if (document.metadata.headingNumbering === undefined) {
    updatePageLayoutAndMetadata(ensurePageLayout(document).pageLayout!, {
      ...document.metadata,
      headingNumbering: { enabled: true },
    });
  }

  return true;
}
