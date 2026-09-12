import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import { tv } from "@/lib/ai/validation-locale";
import { CodexGeneratedImageStore, readCodexGeneratedImageBytes } from "./codex-generated-images";

/** Serializes image imports independently of the JSON-RPC reader, then drains before a follow-up turn. */
export class CodexImageGenerationRun {
  private pending = Promise.resolve();
  private seen = new Set<string>();
  private stopped = false;
  readonly imageIds = new Set<string>();
  readonly errors: string[] = [];

  constructor(private readonly options: {
    store: CodexGeneratedImageStore;
    runId: string;
    fileId: string;
    allowedRoots: string[];
    onEvent: (event: AiEditRunEvent) => void;
    isCancelled: () => boolean;
  }) {}

  handle(notification: { method: string; params?: Record<string, unknown> }, threadId: string): boolean {
    const params = notification.params ?? {};
    const item = params.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "imageGeneration") return false;
    if (this.stopped || this.options.isCancelled()) return true;
    if (typeof item.id !== "string" || typeof params.turnId !== "string") return true;
    const itemId = item.id;
    const turnId = params.turnId;
    const identity = JSON.stringify([threadId, turnId, itemId]);
    if (notification.method === "item/started") {
      if (!this.seen.has(identity)) this.emit(itemId, "started", tv("run.itemType_imageGeneration"));
    } else if (notification.method === "item/completed" && !this.seen.has(identity)) {
      this.seen.add(identity);
      this.pending = this.pending.then(async () => {
        if (this.stopped || this.options.isCancelled()) return;
        try {
          const bytes = await readCodexGeneratedImageBytes(item, this.options.allowedRoots);
          if (this.stopped || this.options.isCancelled()) return;
          const record = await this.options.store.register({
            runId: this.options.runId, fileId: this.options.fileId, threadId, turnId, itemId,
          }, bytes);
          if (this.stopped || this.options.isCancelled()) return;
          this.imageIds.add(record.imageId);
          this.emit(itemId, "completed", tv("generatedImage.ready"), [{
            dataUrl: record.previewDataUrl,
            generatedImage: { runId: record.runId, imageId: record.imageId },
          }]);
        } catch (error) {
          if (this.stopped || this.options.isCancelled()) return;
          const message = tv("generatedImage.importFailed", { p0: error instanceof Error ? error.message : tv("generatedImage.failed") });
          this.errors.push(message);
          this.emit(itemId, "completed", message);
        }
      });
    }
    return true;
  }

  private emit(itemId: string, itemStatus: "started" | "completed", message: string, images?: AiEditRunEvent["images"]): void {
    this.options.onEvent({
      kind: "activity", phase: "streaming", timestamp: Date.now(),
      itemType: "imageGeneration", itemId, itemStatus, message, ...(images ? { images } : {}),
    });
  }

  async settle(cancelled = false): Promise<void> {
    this.stopped ||= cancelled || this.options.isCancelled();
    await this.pending;
    this.stopped ||= this.options.isCancelled();
    if (this.stopped) {
      await this.options.store.removeRun(this.options.runId);
      this.imageIds.clear();
    }
  }
}
