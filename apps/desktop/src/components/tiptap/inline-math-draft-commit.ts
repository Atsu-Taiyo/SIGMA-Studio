import type { Editor } from "@tiptap/core";

// Only active input views register a callback; the draft stays owned by its view.
const pendingCommits = new WeakMap<Editor, Set<() => void>>();

export function registerInlineMathDraftCommit(editor: Editor, commit: () => void): () => void {
  let commits = pendingCommits.get(editor);
  if (!commits) {
    commits = new Set();
    pendingCommits.set(editor, commits);
  }
  commits.add(commit);
  return () => {
    commits.delete(commit);
    if (commits.size === 0 && pendingCommits.get(editor) === commits) pendingCommits.delete(editor);
  };
}

/** Commit before building a mark transaction, which can replace its NodeView. */
export function commitInlineMathDrafts(editor: Editor): void {
  for (const commit of [...(pendingCommits.get(editor) ?? [])]) commit();
}
