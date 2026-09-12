import type { print as ja } from "../ja/print";
import type { TranslationsOf } from "../types";

export const print = {
  toolbar: {
    title: "PDF preview",
    pageCount: "{{count}} pages",
    stalled: "Couldn't prepare the preview",
    openExternal: "Open in a new window",
    saveAfterReady: "You can save the PDF when the preview is ready",
    saving: "Saving PDF",
    save: "Save PDF",
    desktopOnly: "PDF saving is available in the desktop app",
    close: "Close",
  },
  load: {
    checkingAvailability: "Checking whether PDF saving is available",
    aiDocumentFailed: "Couldn't load the material for AI rendering.",
    requestedDocumentFailed: "Couldn't load the requested material.",
    documentRequired: "No material was specified for PDF saving.",
    documentRequiredShort: "No material was specified for PDF saving",
    failed: "Couldn't load the material.",
    failedTitle: "Couldn't load the material",
    backToEditor: "Back to editor",
    pending: "Loading material",
  },
  export: {
    previewNotReady: "Wait for the preview to finish, then try again",
    exporting: "Exporting PDF",
    exported: "Exported PDF: {{path}}",
    cancelled: "PDF export cancelled",
    failed: "Couldn't export the PDF",
    retryAfterReady: "You can try again when the preview is ready",
    retry: "Try again",
    closeError: "Dismiss error",
    savedTitle: "PDF saved",
    savedBody: "The PDF was saved to this computer.",
  },
  pagination: {
    page: "Page {{page}} of {{total}}",
    preview: "Page preview",
    stalledTitle: "Couldn't display the preview",
    stalledBody: "Couldn't finish preparing the pages. Try again.",
    retry: "Try again",
  },
  baked: {
    answerBookTitle: "{{title}} Answer Book",
    answerHeading: "Answers",
    problemHeading: "Problem {{number}}",
  },
} satisfies TranslationsOf<typeof ja>;
