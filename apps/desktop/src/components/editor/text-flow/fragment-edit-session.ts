import type { TextFlowBlock } from "@/features/text-editing";
import type { TextFlowChangeContext } from "./types";

export interface FragmentEdit {
  blockId: string;
  blocks: TextFlowBlock[];
  activeBlockId?: string | null;
  context?: TextFlowChangeContext;
}

export interface FragmentEditOwner {
  owns: (blockId: string) => boolean;
  apply: (edit: FragmentEdit) => void;
}

/**
 * A continuation is an input surface of its source flow, not a document writer.
 * Scope by canvas so identical block ids in two open documents never cross-talk.
 * The owner updates its measured editing document before committing to SigmaDoc.
 */
export class FragmentEditSession {
  private owners = new Set<FragmentEditOwner>();

  register(owner: FragmentEditOwner): () => void {
    this.owners.add(owner);
    return () => { this.owners.delete(owner); };
  }

  hasOwner(blockId: string): boolean {
    return [...this.owners].filter((owner) => owner.owns(blockId)).length === 1;
  }

  dispatch(edit: FragmentEdit): boolean {
    const owners = [...this.owners].filter((owner) => owner.owns(edit.blockId));
    // During ownership handoff, never guess which flow is allowed to save.
    if (owners.length !== 1) return false;
    owners[0].apply(edit);
    return true;
  }
}

const sessions = new WeakMap<HTMLElement, FragmentEditSession>();

export function getFragmentEditSession(canvas: HTMLElement): FragmentEditSession {
  let session = sessions.get(canvas);
  if (!session) {
    session = new FragmentEditSession();
    sessions.set(canvas, session);
  }
  return session;
}
