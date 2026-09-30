"use client";

import type { Editor } from "@tiptap/core";
import { useEffect, useId, useMemo, useState } from "react";
import { COMMENT_AI_MENTION_AGENTS } from "@/lib/comment-agent-mentions";
import { useT } from "@/lib/i18n/react";
import { CommentAuthorAvatar } from "./CommentAuthorAvatar";
import { commentMentionQuery, insertCommentAgentMention, insertCommentMention, type CommentMentionCandidate, type LoadCommentMentionCandidates } from "./comment-mentions";

type MentionOption =
  | { kind: "member"; key: string; member: CommentMentionCandidate }
  | { kind: "agent"; key: string; agent: typeof COMMENT_AI_MENTION_AGENTS[number] };

const NO_MEMBERS: CommentMentionCandidate[] = [];

function insertMentionOption(editor: Editor, option: MentionOption) {
  if (option.kind === "member") insertCommentMention(editor, option.member);
  else insertCommentAgentMention(editor, option.agent.keyword);
}

export function CommentMentionMenu({ editor, loadCandidates }: {
  editor: Editor | null;
  loadCandidates?: LoadCommentMentionCandidates;
}) {
  const t = useT("editor");
  const id = useId();
  const [query, setQuery] = useState<ReturnType<typeof commentMentionQuery>>(null);
  const [result, setResult] = useState<{ loader: LoadCommentMentionCandidates; members: CommentMentionCandidate[]; status: "ready" | "error" } | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      setQuery(commentMentionQuery(editor));
      setSelected(0);
      setDismissed(false);
    };
    editor.on("selectionUpdate", update).on("update", update).on("focus", update).on("blur", update);
    return () => { editor.off("selectionUpdate", update).off("update", update).off("focus", update).off("blur", update); };
  }, [editor]);
  const active = query !== null;
  useEffect(() => {
    if (!active || !loadCandidates) return;
    let cancelled = false;
    loadCandidates().then((members) => {
      if (!cancelled) setResult({ loader: loadCandidates, members, status: "ready" });
    }).catch(() => {
      if (!cancelled) setResult({ loader: loadCandidates, members: [], status: "error" });
    });
    return () => { cancelled = true; };
  }, [active, loadCandidates]);
  const members = result?.loader === loadCandidates ? result?.members ?? NO_MEMBERS : NO_MEMBERS;
  const status = result?.loader === loadCandidates ? result?.status ?? "loading" : "loading";
  const needle = query?.query.toLocaleLowerCase() ?? "";
  const candidates = useMemo((): MentionOption[] => [
    ...members
      .filter((member) => `${member.name} ${member.email ?? ""}`.toLocaleLowerCase().includes(needle))
      .slice(0, 20)
      .map((member): MentionOption => ({ kind: "member", key: member.userId, member })),
    // AI は @claude のように打てば呼べるが、チップになると分かるよう候補にも出す。
    ...COMMENT_AI_MENTION_AGENTS
      .filter((agent) => `${agent.keyword} ${agent.name}`.toLocaleLowerCase().includes(needle))
      .map((agent): MentionOption => ({ kind: "agent", key: `agent:${agent.keyword}`, agent })),
  ], [members, needle]);

  const open = active && Boolean(loadCandidates) && !dismissed;
  useEffect(() => {
    if (!editor || !open) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-controls", id);
    dom.setAttribute("aria-expanded", "true");
    if (candidates[selected]) dom.setAttribute("aria-activedescendant", `${id}-${selected}`);
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || editor.view.composing || event.keyCode === 229) return;
      if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
      if (event.key === "Enter" && !candidates[selected]) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") setDismissed(true);
      else if (event.key === "Enter") { insertMentionOption(editor, candidates[selected]); }
      else if (candidates.length) setSelected((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
    };
    dom.addEventListener("keydown", keydown, true);
    return () => {
      dom.removeEventListener("keydown", keydown, true);
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, open, candidates, selected, id]);
  if (!open || !editor) return null;
  return <div className="comment-mention-menu">
    <div className="comment-mention-menu-label">{t("comment.mentionMembers")}</div>
    <div id={id} role="listbox" aria-label={t("comment.mentionMembers")}>
      {candidates.map((option, index) => <button key={option.key} id={`${id}-${index}`} type="button" role="option" aria-selected={index === selected}
        className="comment-mention-option"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => insertMentionOption(editor, option)}>
        {option.kind === "member"
          ? <>
            <CommentAuthorAvatar name={option.member.name} avatarUrl={option.member.avatarUrl} />
            <span className="comment-mention-option-text">
              <span className="comment-mention-option-name">{option.member.name}</span>
              {option.member.email && option.member.email !== option.member.name && <span className="comment-mention-option-sub">{option.member.email}</span>}
            </span>
          </>
          : <>
            <CommentAuthorAvatar name={option.agent.name} agent={{ vendor: option.agent.vendor }} />
            <span className="comment-mention-option-text">
              <span className="comment-mention-option-name">{option.agent.name}</span>
              <span className="comment-mention-option-sub">{t("comment.mentionAgentHint", { keyword: option.agent.keyword })}</span>
            </span>
          </>}
      </button>)}
    </div>
    {(status !== "ready" || candidates.length === 0) && <div role="status">{t(status === "error" ? "comment.mentionError" : status === "loading" ? "comment.mentionLoading" : "comment.mentionEmpty")}</div>}
  </div>;
}
