import { useSyncExternalStore } from "react";

import {
  isCanonicalFrameSvg,
  resolveCustomFrameMetrics,
  type ProblemCustomFrame,
} from "@/features/document";

/**
 * The user's own problem frames, kept so a drawing made once can be used on any problem in any
 * material. A problem always carries its own copy of the frame it uses (the file stays
 * self-contained), so the library is only a shelf to pick from: deleting or editing an entry never
 * changes a problem that already used it.
 *
 * It lives in the profile's `localStorage`, like the other per-user preferences. Reads validate
 * every entry again, because the value outlives the code that wrote it.
 */
export interface ProblemFrameLibraryEntry {
  id: string;
  name: string;
  custom: ProblemCustomFrame;
  updatedAt: number;
}

export const PROBLEM_FRAME_LIBRARY_STORAGE_KEY = "sigma-studio:problem-frame-library";
export const MAX_PROBLEM_FRAME_LIBRARY_ENTRIES = 60;
const MAX_NAME_LENGTH = 40;

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: { raw: string | null; entries: readonly ProblemFrameLibraryEntry[] } | null = null;
const EMPTY: readonly ProblemFrameLibraryEntry[] = [];

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is ProblemFrameLibraryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const custom = entry.custom as Record<string, unknown> | undefined;
  return typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.name === "string"
    && typeof entry.updatedAt === "number"
    && typeof custom === "object" && custom !== null
    && typeof custom.svg === "string" && isCanonicalFrameSvg(custom.svg)
    && typeof custom.width === "number" && typeof custom.height === "number";
}

function parse(raw: string | null): readonly ProblemFrameLibraryEntry[] {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return EMPTY;
    return value.filter(isEntry).map((entry) => ({
      ...entry,
      name: entry.name.slice(0, MAX_NAME_LENGTH),
      // A stored frame is not trusted any more than a document is: numbers come back in range.
      custom: { ...entry.custom, ...resolveCustomFrameMetrics(entry.custom) },
    }));
  } catch {
    return EMPTY;
  }
}

export function getProblemFrameLibrary(): readonly ProblemFrameLibraryEntry[] {
  if (typeof window === "undefined") return EMPTY;
  const raw = readStorage();
  if (cache && cache.raw === raw) return cache.entries;
  cache = { raw, entries: parse(raw) };
  return cache.entries;
}

function write(entries: readonly ProblemFrameLibraryEntry[]): boolean {
  try {
    const raw = JSON.stringify(entries);
    window.localStorage.setItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY, raw);
    cache = { raw, entries };
    listeners.forEach((listener) => listener());
    return true;
  } catch {
    // Storage full or blocked: the problem keeps its frame, only the shelf could not be updated.
    return false;
  }
}

function createId(): string {
  return `frame_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanName(name: string, fallback: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH) || fallback;
}

/** Newest first, so a frame just made is the first thing on the shelf. */
export function addProblemFrameToLibrary(
  custom: ProblemCustomFrame,
  name: string,
): ProblemFrameLibraryEntry | null {
  const entry: ProblemFrameLibraryEntry = {
    id: createId(),
    name: cleanName(name, name),
    custom,
    updatedAt: Date.now(),
  };
  const next = [entry, ...getProblemFrameLibrary()].slice(0, MAX_PROBLEM_FRAME_LIBRARY_ENTRIES);
  return write(next) ? entry : null;
}

export function updateProblemFrameInLibrary(
  id: string,
  patch: { name?: string; custom?: ProblemCustomFrame },
): boolean {
  const current = getProblemFrameLibrary();
  if (!current.some((entry) => entry.id === id)) return false;
  return write(current.map((entry) => entry.id !== id ? entry : {
    ...entry,
    name: patch.name === undefined ? entry.name : cleanName(patch.name, entry.name),
    custom: patch.custom ?? entry.custom,
    updatedAt: Date.now(),
  }));
}

export function removeProblemFrameFromLibrary(id: string): boolean {
  const current = getProblemFrameLibrary();
  return current.some((entry) => entry.id === id)
    ? write(current.filter((entry) => entry.id !== id))
    : false;
}

/** The entry a problem's own copy of a frame came from, found by its drawing. */
export function findProblemFrameLibraryEntry(
  custom: ProblemCustomFrame | undefined,
): ProblemFrameLibraryEntry | undefined {
  return custom ? getProblemFrameLibrary().find((entry) => entry.custom.svg === custom.svg) : undefined;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PROBLEM_FRAME_LIBRARY_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useProblemFrameLibrary(): readonly ProblemFrameLibraryEntry[] {
  return useSyncExternalStore(subscribe, getProblemFrameLibrary, () => EMPTY);
}
