import { Mark, mergeAttributes, type Editor } from "@tiptap/core";

export interface CommentMentionCandidate {
  userId: string;
  name: string;
}

export type LoadCommentMentionCandidates = () => Promise<CommentMentionCandidate[]>;

export const CommentMentionMark = Mark.create({
  name: "commentMention",
  inclusive: false,
  addAttributes: () => ({
    userId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-comment-mention"),
      renderHTML: (attributes: Record<string, unknown>) => ({ "data-comment-mention": attributes.userId }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-comment-mention]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "comment-mention" }), 0],
});

export function commentMentionQuery(editor: Editor) {
  const { selection } = editor.state;
  if (!selection.empty || !editor.isFocused) return null;
  const { $from, from } = selection;
  if ($from.marks().some((mark) => mark.type.name === "commentMention")) return null;
  const prefix = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(prefix);
  return match ? { from: from - match[1].length - 1, to: from, query: match[1] } : null;
}

export function insertCommentMention(editor: Editor, candidate: CommentMentionCandidate) {
  const range = commentMentionQuery(editor);
  if (!range) return;
  editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, [
    { type: "text", text: `@${candidate.name}`, marks: [{ type: "commentMention", attrs: { userId: candidate.userId } }] },
    { type: "text", text: " ", marks: [] },
  ]).run();
}
