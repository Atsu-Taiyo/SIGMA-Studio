import type { BlockSpaceAfterTarget } from "./block-affordances";

/** A gesture captures its own origin; later gestures must never commit its pointer events. */
export interface SpaceAfterDragGesture {
  target: BlockSpaceAfterTarget;
  startClientY: number;
  startPx: number;
  px: number;
  clientY: number;
  zoomFactor: number;
  frame: number | null;
  stop(): void;
}

export interface SpaceAfterCommit {
  blockId: string;
  px: number;
  deltaPx: number;
  /** Position before the gesture, used to avoid applying the committed delta twice. */
  bottomBefore: number;
}

/**
 * One canvas owns both the pointer gesture and the later wait for its committed paint.
 * Pagination remains frozen across that handoff. A typing-triggered measurement also
 * retains its baseline-refresh request until the deferred measurement is consumed.
 * This models the separate complete/cancel interaction paths used by external canvas editors (inspiration only).
 */
export class SpaceAfterDragSession {
  private drag: SpaceAfterDragGesture | null = null;
  private commit: SpaceAfterCommit | null = null;
  private recomputeDeferred = false;
  private refreshBaseline = false;

  get isDragging(): boolean { return this.drag !== null; }
  get isFrozen(): boolean { return this.drag !== null || this.commit !== null; }
  get pendingCommit(): SpaceAfterCommit | null { return this.commit; }

  resetForStart(): void {
    this.drag?.stop();
    this.drag = null;
    this.commit = null;
  }

  start(drag: SpaceAfterDragGesture): void {
    this.drag = drag;
  }

  release(drag: SpaceAfterDragGesture): boolean {
    if (this.drag !== drag) return false;
    this.drag = null;
    drag.stop();
    return true;
  }

  cancel(): void {
    const drag = this.drag;
    this.drag = null;
    this.commit = null;
    drag?.stop();
  }

  beginCommit(commit: SpaceAfterCommit): void {
    this.commit = commit;
  }

  ownsCommit(commit: SpaceAfterCommit): boolean {
    return this.commit === commit;
  }

  finishCommit(): void {
    this.commit = null;
  }

  /** Record the measurement's purpose before deciding whether it can run. */
  requestRecompute(updateBaseline: boolean): boolean {
    if (updateBaseline) this.refreshBaseline = true;
    if (this.isFrozen) {
      this.recomputeDeferred = true;
      return false;
    }
    return true;
  }

  /** A refused measurement consumes the request too; it cannot leak into a later observer. */
  consumeBaselineRefresh(measured: boolean): boolean {
    const refresh = measured && this.refreshBaseline;
    this.refreshBaseline = false;
    return refresh;
  }

  resumeRecompute(force = false): boolean {
    if (!force && !this.recomputeDeferred) return false;
    this.recomputeDeferred = false;
    return true;
  }
}
