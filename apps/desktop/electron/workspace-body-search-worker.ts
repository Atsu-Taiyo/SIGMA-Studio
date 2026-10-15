import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";

import { documentSearchText } from "../src/features/document/application/document-search-text";
import type { SigmaDocument } from "../src/features/document";

/** 教材の JSON を読んで、本文検索の文字列だけを返す。読めない・壊れた教材は null。 */
parentPort?.on("message", async (message: { id: number; filePath: string }) => {
  let text: string | null = null;
  try {
    text = documentSearchText(JSON.parse(await readFile(message.filePath, "utf8")) as SigmaDocument);
  } catch {
    text = null;
  }
  parentPort?.postMessage({ id: message.id, text });
});
