"use client";

import type { Editor } from "@tiptap/core";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COMMENT_AI_MENTION_AGENTS } from "@/lib/comment-agent-mentions";
import { useT } from "@/lib/i18n/react";
import { CommentAuthorAvatar } from "./CommentAuthorAvatar";
import { commentMentionQuery, insertCommentAgentMention, insertCommentMention, type CommentMentionCandidate, type LoadCommentMentionCandidates } from "./comment-mentions";

type MentionOption =
  | { kind: "member"; key: string; member: CommentMentionCandidate }
  | { kind: "agent"; key: string; agent: typeof COMMENT_AI_MENTION_AGENTS[number] };

const NO_MEMBERS: CommentMentionCandidate[] = [];
/** 候補はキャレットの行のすぐ下に開く。下に収まらなければ行の上へ回す。 */
const CARET_GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

function insertMentionOption(editor: Editor, option: MentionOption) {
  if (option.kind === "member") insertCommentMention(editor, option.member);
  else insertCommentAgentMention(editor, option.agent.keyword);
}

/**
 * `@` を打ったときに出す宛先の候補。入力欄の中に差し込まず (欄の高さが跳ねる)、キャレットの下に浮かべる。
 * コメントの欄はスクロールする枠の中にあるので、切られないよう body へ出す。外側を押したら閉じる面
 * (浮かべた入力欄・広げたカード・Dock) は `data-comment-popover` を内側として扱う。
 */
export function CommentMentionMenu({ editor, loadCandidates }: {
  editor: Editor | null;
  loadCandidates?: LoadCommentMentionCandidates;
}) {
  const t = useT("editor");
  const id = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<ReturnType<typeof commentMentionQuery>>(null);
  const [result, setResult] = useState<{ loader: LoadCommentMentionCandidates; members: CommentMentionCandidate[]; status: "ready" | "error" } | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
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
      if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
      if ((event.key === "Enter" || event.key === "Tab") && !candidates[selected]) return;
      event.preventDefault();
      // 同じ要素にある ProseMirror のキー処理 (Enter で送信・段落の分割) まで届けない。
      event.stopImmediatePropagation();
      if (event.key === "Escape") setDismissed(true);
      else if (event.key === "Enter" || event.key === "Tab") { insertMentionOption(editor, candidates[selected]); }
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

  // キャレット (`@` の位置) の下に置く。打ち進めて候補の数が変わっても、`@` の位置は動かない。
  const from = query?.from ?? null;
  useLayoutEffect(() => {
    if (!editor || !open || from === null) return;
    const place = () => {
      const menu = menuRef.current;
      let caret: { left: number; top: number; bottom: number };
      try {
        caret = editor.view.coordsAtPos(from);
      } catch {
        return;
      }
      const width = menu?.offsetWidth ?? 0;
      const height = menu?.offsetHeight ?? 0;
      const below = caret.bottom + CARET_GAP_PX;
      const top = below + height <= window.innerHeight - VIEWPORT_MARGIN_PX
        ? below
        : Math.max(VIEWPORT_MARGIN_PX, caret.top - CARET_GAP_PX - height);
      const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(caret.left - 10, window.innerWidth - width - VIEWPORT_MARGIN_PX));
      setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" || !menuRef.current ? null : new ResizeObserver(place);
    if (menuRef.current) observer?.observe(menuRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [editor, open, from, candidates.length]);

  if (!open || !editor || typeof window === "undefined") return null;
  const memberOptions = candidates.filter((option) => option.kind === "member");
  const agentOptions = candidates.filter((option) => option.kind === "agent");
  const renderOption = (option: MentionOption) => {
    const index = candidates.indexOf(option);
    return <button key={option.key} id={`${id}-${index}`} type="button" role="option" aria-selected={index === selected}
      className="comment-mention-option"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setSelected(index)}
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
    </button>;
  };
  // 共同編集者がいない (共有していない) 教材では、人の欄そのものを出さない。
  const memberStatus = status !== "ready"
    ? t(status === "error" ? "comment.mentionError" : "comment.mentionLoading")
    : members.length > 0 && memberOptions.length === 0 ? t("comment.mentionEmpty") : null;
  if (candidates.length === 0 && !memberStatus) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="comment-mention-menu"
      data-comment-popover="true"
      style={position ? { left: `${position.left}px`, top: `${position.top}px` } : { visibility: "hidden" }}
    >
      <div id={id} role="listbox" aria-label={t("comment.mentionMembers")}>
        {(memberOptions.length > 0 || memberStatus) && (
          <div role="group" aria-label={t("comment.mentionMembersSection")}>
            <div className="comment-mention-menu-label" aria-hidden="true">{t("comment.mentionMembersSection")}</div>
            {memberOptions.map(renderOption)}
            {memberStatus && <div className="comment-mention-menu-status" role="status">{memberStatus}</div>}
          </div>
        )}
        {agentOptions.length > 0 && (
          <div role="group" aria-label={t("comment.mentionAgentsSection")}>
            <div className="comment-mention-menu-label" aria-hidden="true">{t("comment.mentionAgentsSection")}</div>
            {agentOptions.map(renderOption)}
          </div>
        )}
      </div>
    </div>,
    window.document.body,
  );
}
