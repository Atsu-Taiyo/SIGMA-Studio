/** Opt-in, content-free timings. Never records document text, URLs or file paths. */
export class PdfExportProfile {
  private readonly enabled = process.env.SIGMA_STUDIO_PDF_PROFILE === "1";
  private readonly started = performance.now();
  private readonly entries: Array<{ stage: string; ms: number; pageIndex?: number }> = [];

  async measure<T>(stage: string, task: () => Promise<T>, pageIndex?: number): Promise<T> {
    if (!this.enabled) return task();
    const start = performance.now();
    try { return await task(); }
    finally { this.entries.push({ stage, ms: performance.now() - start, pageIndex }); }
  }

  record(entries: Array<{ stage: string; ms: number }>, pageIndex: number): void {
    if (this.enabled) this.entries.push(...entries.map(entry => ({ ...entry, pageIndex })));
  }

  finish(pageCount: number, success: boolean): void {
    if (this.enabled) console.info("[pdf-profile] " + JSON.stringify({
      pageCount, success, totalMs: performance.now() - this.started, entries: this.entries,
    }));
  }
}
