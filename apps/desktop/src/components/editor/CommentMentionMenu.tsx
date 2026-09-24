"use client";

import type { Editor } from "@tiptap/core";
import { useEffect, useId, useState } from "react";
import { useT } from "@/lib/i18n/react";
import { commentMentionQuery, insertCommentMention, type CommentMentionCandidate, type LoadCommentMentionCandidates } from "./comment-mentions";

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
  const members = result?.loader === loadCandidates ? result?.members ?? [] : [];
  const status = result?.loader === loadCandidates ? result?.status ?? "loading" : "loading";
  const candidates = members.filter((member) => member.name.toLocaleLowerCase().includes(query?.query.toLocaleLowerCase() ?? "")).slice(0, 20);
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
      else if (event.key === "Enter") { insertCommentMention(editor, candidates[selected]); }
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
      {candidates.map((member, index) => <button key={member.userId} id={`${id}-${index}`} type="button" role="option" aria-selected={index === selected}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => insertCommentMention(editor, member)}>{member.name}</button>)}
    </div>
    {candidates.length === 0 && <div role="status">{t(status === "error" ? "comment.mentionError" : status === "loading" ? "comment.mentionLoading" : "comment.mentionEmpty")}</div>}
  </div>;
}
