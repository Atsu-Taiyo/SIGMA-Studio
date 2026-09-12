export interface DocumentHistoryTransactionMetadata {
  /** Generic source label owned by the composition root (for example, `user` or `automation`). */
  readonly origin: string;
  /** External transaction identifiers that must travel with the same undo/redo operation. */
  readonly correlationIds?: readonly string[];
}

export interface DocumentHistoryState<TDocument, TSelection> {
  readonly document: TDocument;
  readonly selection: TSelection;
}

export interface DocumentHistoryEntry<TDocument, TSelection>
  extends DocumentHistoryState<TDocument, TSelection> {
  readonly metadata?: DocumentHistoryTransactionMetadata;
}

export interface DocumentHistoryRecordOptions {
  /**
   * Consecutive records with the same key are one undo event. The first
   * snapshot is retained so undo restores the state before the whole group.
   */
  readonly coalescingKey?: string;
}

/**
 * Framework-neutral bounded document history.
 *
 * Document instances are retained by reference: recording and restoring history
 * never clones a document. Push/pop are constant time, while clearing a redo
 * branch is amortized constant time over the undo operations that created it.
 */
export class DocumentHistoryController<TDocument, TSelection> {
  readonly #undo: BoundedStack<DocumentHistoryEntry<TDocument, TSelection>>;
  readonly #redo: BoundedStack<DocumentHistoryEntry<TDocument, TSelection>>;
  #activeCoalescingKey: string | null = null;

  constructor(maxEntries: number) {
    this.#undo = new BoundedStack(maxEntries);
    this.#redo = new BoundedStack(maxEntries);
  }

  get undoDepth(): number {
    return this.#undo.depth;
  }

  get redoDepth(): number {
    return this.#redo.depth;
  }

  record(
    entry: DocumentHistoryEntry<TDocument, TSelection>,
    options?: DocumentHistoryRecordOptions,
  ): void {
    const coalescingKey = options?.coalescingKey ?? null;
    if (coalescingKey && coalescingKey === this.#activeCoalescingKey) {
      return;
    }

    this.#undo.push(entry);
    this.#redo.clear();
    this.#activeCoalescingKey = coalescingKey;
  }

  clear(): void {
    this.#undo.clear();
    this.#redo.clear();
    this.#activeCoalescingKey = null;
  }

  /**
   * The entry a matching `undo()`/`redo()` would restore, without consuming it,
   * so a caller can decide to refuse the restore before either stack moves.
   */
  peek(direction: "undo" | "redo"): DocumentHistoryEntry<TDocument, TSelection> | null {
    return (direction === "undo" ? this.#undo : this.#redo).peek();
  }

  undo(current: DocumentHistoryState<TDocument, TSelection>): DocumentHistoryEntry<TDocument, TSelection> | null {
    this.#activeCoalescingKey = null;
    return this.#restore(this.#undo, this.#redo, current);
  }

  redo(current: DocumentHistoryState<TDocument, TSelection>): DocumentHistoryEntry<TDocument, TSelection> | null {
    this.#activeCoalescingKey = null;
    return this.#restore(this.#redo, this.#undo, current);
  }

  #restore(
    source: BoundedStack<DocumentHistoryEntry<TDocument, TSelection>>,
    target: BoundedStack<DocumentHistoryEntry<TDocument, TSelection>>,
    current: DocumentHistoryState<TDocument, TSelection>,
  ): DocumentHistoryEntry<TDocument, TSelection> | null {
    const entry = source.pop();
    if (!entry) {
      return null;
    }

    target.push({
      document: current.document,
      selection: current.selection,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
    return entry;
  }
}

class BoundedStack<T> {
  readonly #entries: Array<T | undefined>;
  readonly #maxEntries: number;
  #start = 0;
  #size = 0;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
    this.#entries = new Array<T | undefined>(maxEntries);
  }

  get depth(): number {
    return this.#size;
  }

  push(entry: T): void {
    if (this.#size < this.#maxEntries) {
      this.#entries[(this.#start + this.#size) % this.#maxEntries] = entry;
      this.#size += 1;
      return;
    }

    this.#entries[this.#start] = entry;
    this.#start = (this.#start + 1) % this.#maxEntries;
  }

  peek(): T | null {
    if (this.#size === 0) {
      return null;
    }
    return this.#entries[(this.#start + this.#size - 1) % this.#maxEntries] as T;
  }

  pop(): T | null {
    if (this.#size === 0) {
      return null;
    }

    const index = (this.#start + this.#size - 1) % this.#maxEntries;
    const entry = this.#entries[index] as T;
    this.#entries[index] = undefined;
    this.#size -= 1;
    if (this.#size === 0) {
      this.#start = 0;
    }
    return entry;
  }

  clear(): void {
    while (this.#size > 0) {
      this.#entries[this.#start] = undefined;
      this.#start = (this.#start + 1) % this.#maxEntries;
      this.#size -= 1;
    }
    this.#start = 0;
  }
}
