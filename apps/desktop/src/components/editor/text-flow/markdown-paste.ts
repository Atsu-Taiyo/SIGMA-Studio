import { parseMarkdownToTextFlowBlocks } from "@/lib/markdown-to-text-flow";

/**
 * Paste is intentionally conservative: ordinary prose stays on Tiptap's
 * native paste path, while unambiguous Markdown is converted to SigmaDoc.
 */
export function parsePastedMarkdown(text: string) {
  return parseMarkdownToTextFlowBlocks(text);
}
