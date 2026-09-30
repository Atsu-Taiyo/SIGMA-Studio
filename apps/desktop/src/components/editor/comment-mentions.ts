import { Extension, Mark, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { splitCommentAiMentions } from "@/lib/comment-agent-mentions";

export interface CommentMentionCandidate {
  userId: string;
  name: string;
  /** チップのツールチップに出す。名前と同じ (メールしか分からない) ときは省略してよい。 */
  email?: string;
  avatarUrl?: string | null;
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

/**
 * 打ち込まれた AI メンション (@claude など) を、投稿前の入力欄でもチップ状に見せる。
 * 本文は普通のテキストのまま (AI の起動判定は本文の文字列で行う) で、装飾だけを重ねる。
 */
export const CommentAgentMentionHighlight = Extension.create({
  name: "commentAgentMentionHighlight",
  addProseMirrorPlugins: () => [new Plugin({
    key: new PluginKey("commentAgentMentionHighlight"),
    props: {
      decorations: ({ doc }) => {
        const decorations: Decoration[] = [];
        doc.descendants((node, position) => {
          if (!node.isTextblock) return true;
          const text = node.textBetween(0, node.content.size, undefined, "\ufffc");
          let offset = 0;
          for (const part of splitCommentAiMentions(text)) {
            if (part.agent) {
              // 数式ノードは 1 文字ぶんの占位 (\ufffc) なので、テキスト上の位置と文書上の位置は一致する。
              decorations.push(Decoration.inline(position + 1 + offset, position + 1 + offset + part.text.length, { class: "comment-mention is-agent" }));
            }
            offset += part.text.length;
          }
          return false;
        });
        return DecorationSet.create(doc, decorations);
      },
    },
  })],
});

export function insertCommentAgentMention(editor: Editor, keyword: string) {
  const range = commentMentionQuery(editor);
  if (!range) return;
  editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, `@${keyword} `).run();
}
