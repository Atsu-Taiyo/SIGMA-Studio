"use client";

// Static text rendering is also used by Electron main when it creates AI preview SVGs.
// Keep this entrypoint free of browser-only 3D interaction adapters.
export {
  boxedInlineRunAlignmentSignature,
  renderInlineContent,
  useBoxedInlineRunAlignment,
} from "./InlineContent";
