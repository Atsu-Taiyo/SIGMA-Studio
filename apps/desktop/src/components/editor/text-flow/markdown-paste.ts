import { parseMarkdownToTextFlowBlocks } from "@/lib/markdown-to-text-flow";

/**
 * Paste is intentionally conservative: ordinary prose stays on Tiptap's
 * native paste path, while unambiguous Markdown is converted to SigmaDoc.
 */
export function parsePastedMarkdown(text: string) {
  return parseMarkdownToTextFlowBlocks(text);
}

/**
 * クリップボードのプレーンテキストを Markdown として読む。ただし ProseMirror の編集面が書いた HTML が
 * 添えてあるときは読まない。その HTML は枠・色・下線などの書式を持ち、プレーンテキストは数式を
 * `$tex$` へ落とした劣化版なので、Markdown で上書きすると数式は戻っても枠や色が落ちる
 * (切り取りや、payload を持たない別の編集面からのコピー)。外部のページが書いた HTML には
 * 従来どおり Markdown を優先する。
 */
export function parsePastedMarkdownFromClipboard(clipboardData: Pick<DataTransfer, "getData">) {
  return clipboardData.getData("text/html").includes("data-pm-slice")
    ? null
    : parsePastedMarkdown(clipboardData.getData("text/plain"));
}
