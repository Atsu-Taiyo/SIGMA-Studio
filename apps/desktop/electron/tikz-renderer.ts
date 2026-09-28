import path from "node:path";
import { Worker } from "node:worker_threads";
import { isTikzImageSource } from "../src/features/document/tikz";
import type { TikzRenderResponse } from "../src/lib/tikz-contract";

let activeRenders = 0;

/** Each compile gets an isolated in-memory TeX filesystem and a terminable CPU budget. */
export async function renderTikz(input: unknown, options: { workerPath?: string; timeoutMs?: number } = {}): Promise<TikzRenderResponse> {
  if (!isTikzImageSource(input)) return { ok: false, error: "invalid-input" };
  if (activeRenders >= 2) return { ok: false, error: "busy" };
  activeRenders++;
  try {
    return await new Promise<TikzRenderResponse>((resolve) => {
      const worker = new Worker(options.workerPath ?? path.join(__dirname, "tikz-worker.cjs"), {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      let finished = false;
      const finish = (result: TikzRenderResponse) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Wait for disposal before releasing the concurrency slot.
        void worker.terminate().finally(() => resolve(result));
      };
      const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), options.timeoutMs ?? 20_000);
      worker.once("message", (result: TikzRenderResponse) => finish(result));
      worker.once("error", () => finish({ ok: false, error: "render-failed" }));
      worker.once("exit", () => finish({ ok: false, error: "render-failed" }));
    });
  } catch {
    return { ok: false, error: "render-failed" };
  } finally {
    activeRenders--;
  }
}
