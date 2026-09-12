"use client";

import { useEffect, useRef, useState } from "react";

interface WorkspaceInlineRenameInputProps {
  original: string;
  ariaLabel: string;
  className?: string;
  onCommit: (nextName: string) => void;
  onCancel: () => void;
}

// This component is where the S1 "renamed input clobbers itself mid-type"
// bug class dies structurally: the draft string lives ONLY in this
// component's own useState. The parent's rename state never holds a draft,
// so there is no parent-owned object for a background refresh to touch and
// no effect keyed on that object to misfire mid-keystroke.
//
// Callers must mount this only while renaming and pass key={`${type}:${id}`}
// so autoFocus + the mount-only select() below run exactly once per rename,
// with no rAF and no dependency array to get wrong.
export function WorkspaceInlineRenameInput({
  original,
  ariaLabel,
  className,
  onCommit,
  onCancel,
}: WorkspaceInlineRenameInputProps) {
  const [draft, setDraft] = useState(original);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape and Enter both blur the input; onBlur must not double-fire a
  // commit (Enter) or turn into a save (Escape) because of that blur.
  const cancelledRef = useRef(false);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (committedRef.current || cancelledRef.current) {
      return;
    }
    committedRef.current = true;
    onCommit(draft);
  };

  const cancel = () => {
    if (committedRef.current || cancelledRef.current) {
      return;
    }
    cancelledRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      aria-label={ariaLabel}
      className={className}
      draggable={false}
      onChange={(event) => setDraft(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Every key stops here, not just Enter/Escape: the F2 / Delete /
        // arrow-key handling a later step adds to the row must never see
        // keystrokes meant for this input.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (cancelledRef.current || committedRef.current) {
          return;
        }
        commit();
      }}
    />
  );
}
