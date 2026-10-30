import { Worker } from "node:worker_threads";

import { PluginError } from "./manifest";

export interface LocalFontBytes {
  family: string;
  bytes: Uint8Array;
}

/** ワーカーを動かす1回ごとの状況。拡張機能が自分で同梱している書体の名前を、ホストが知っているものとして渡す。 */
export interface WorkerContext {
  bundledFamilies: ReadonlySet<string>;
  /** この系統の書体は拡張機能が持っているので、このPCから読まない。 */
  ownFamilyPrefixes: readonly string[];
}

export type RunWorker = (filename: string, payload: Record<string, unknown>, context?: WorkerContext) => Promise<unknown>;
export type MeasurePluginDocument = (document: unknown, blockIds: string[]) => Promise<unknown>;

const MAX_FONT_FAMILIES = 128;
const MAX_FAMILY_LENGTH = 256;

/**
 * 検証済みのワーカーをワーカースレッドで1回だけ動かす。
 * 時間と使えるメモリに上限があり、結果は1回受け取ったら必ずスレッドごと止める。
 * ワーカーは、このPCのフォントが要るときだけ `local-font-request` で家族名を頼める。
 * ホスト側は個数と文字列の形を確かめてから `loadLocalFonts` に渡し、元の教材は外へ出さない。
 */
export function createWorkerRunner({ loadLocalFonts = async () => [], measureDocument, timeoutMs = 90_000, maxOldGenerationSizeMb = 768 }: {
  loadLocalFonts?: (families: string[], context: WorkerContext) => Promise<LocalFontBytes[]>;
  measureDocument?: MeasurePluginDocument;
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
} = {}): RunWorker {
  return (filename, payload, context = { bundledFamilies: new Set(), ownFamilyPrefixes: [] }) => new Promise((resolve, reject) => {
    const worker = new Worker(filename, { workerData: payload, resourceLimits: { maxOldGenerationSizeMb } });
    let finished = false;
    let measuring = false;
    let measurementCount = 0;
    const finish = (error: PluginError | null, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new PluginError("timeout")), timeoutMs);
    worker.on("message", (message: { type?: string; families?: unknown; ok?: boolean; result?: unknown; document?: unknown; blockIds?: unknown } | null) => {
      if (message?.type === "document-measure-request") {
        const ids = message.blockIds;
        let size = Infinity;
        try { size = Buffer.byteLength(JSON.stringify(message.document) ?? ""); } catch { /* Invalid document data fails closed below. */ }
        if (!measureDocument || measuring || ++measurementCount > 8 || !Array.isArray(ids) || ids.length > 25_000
          || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 256)
          || size > 64 * 1024 * 1024) {
          finish(new PluginError("import-failed")); return;
        }
        measuring = true;
        void measureDocument(message.document, ids as string[]).then(measurement => {
          measuring = false;
          if (!finished) worker.postMessage({ type: "document-measure-response", measurement });
        }).catch(() => finish(new PluginError("import-failed")));
      } else if (message?.type === "local-font-request") {
        const families = message.families;
        if (!Array.isArray(families) || families.length > MAX_FONT_FAMILIES
          || !families.every((family) => typeof family === "string" && family.length <= MAX_FAMILY_LENGTH)) {
          finish(new PluginError("import-failed"));
          return;
        }
        void loadLocalFonts(families as string[], context).then((fonts) => {
          if (!finished) worker.postMessage({ type: "local-font-response", fonts }, fonts.map((font) => font.bytes.buffer as ArrayBuffer));
        }).catch(() => finish(new PluginError("unavailable")));
      } else if (message?.ok) {
        finish(null, message.result);
      } else {
        finish(new PluginError("import-failed"));
      }
    });
    worker.once("error", () => finish(new PluginError("import-failed")));
    worker.once("exit", () => finish(new PluginError("import-failed")));
  });
}
