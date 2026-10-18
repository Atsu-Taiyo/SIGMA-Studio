"use client";

import { useState } from "react";

import { AntigravityMark, ClaudeMark, GeminiMark, OpenAiMark } from "@/components/branding/provider-logos";
import { getCommentAgentBrand } from "@/lib/comment-agents";
import { useT } from "@/lib/i18n/react";
import type { SigmaCommentAgent } from "@/features/document";

/**
 * コメントの差出人アイコン。
 *
 * **人が書いたコメントと AI が書いたコメントを、名前を読まずに見分けられること**が
 * このコンポーネントの仕事。AI のときは `agent.vendor` の提供元ロゴを地色ごと出し、
 * 人のときは従来どおり頭文字を出す。ロゴを持たない提供元は頭文字 + 提供元の色で、
 * どちらの場合も右下に AI バッジを重ねる。ロゴは AI チャットなど他の面と同じ現行のもの。
 */
export function CommentAuthorAvatar({
  agent,
  avatarUrl,
  name,
}: {
  agent?: SigmaCommentAgent | null;
  avatarUrl?: string | null;
  name: string;
}) {
  const t = useT("editor");

  if (agent) {
    const brand = getCommentAgentBrand(agent.vendor);
    return (
      <span
        className="comment-author-avatar agent"
        role="img"
        aria-label={t("comment.agentAvatarAria", { name, vendor: brand.label })}
        style={{ background: brand.background, color: brand.foreground }}
      >
        {brand.hasLogo
          ? <CommentAgentLogo agent={agent} />
          : <span aria-hidden="true">{getAuthorInitial(name)}</span>}
        <span className="comment-author-avatar-badge" aria-hidden="true">
          <SparkleGlyph />
        </span>
      </span>
    );
  }

  if (avatarUrl) {
    // 画像が読めない (オフライン・期限切れ・CSP) ときに、何も描かれない灰色の丸にしない。頭文字へ戻す。
    return <CommentAvatarImage key={avatarUrl} avatarUrl={avatarUrl} name={name} label={t("comment.avatarAria", { name })} />;
  }

  return <CommentAvatarInitials name={name} />;
}

function CommentAvatarImage({ avatarUrl, name, label }: { avatarUrl: string; name: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <CommentAvatarInitials name={name} />;
  }
  return (
    <span className="comment-author-avatar image" role="img" aria-label={label}>
      {/* Electron の独自スキーム (sigma-collaboration-profile:) は next/image で読めない。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
}

function CommentAvatarInitials({ name }: { name: string }) {
  const initials = getAuthorInitials(name);
  return (
    <span className="comment-author-avatar" data-initials={initials.length} aria-hidden="true">{initials}</span>
  );
}

export function getAuthorInitial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] ?? "G").toUpperCase();
}

/**
 * アイコンの頭文字。英字の名前は姓名の頭文字 2 つ (Atsushi Kim → AK)、メールアドレスは
 * `.` や `_` で区切った名前の部分から取る (hanako.sato@… → HS)。漢字・かなは 1 文字 (佐藤 花子 → 佐)。
 */
export function getAuthorInitials(name: string): string {
  const trimmed = name.trim();
  const local = trimmed.includes("@") ? trimmed.slice(0, trimmed.indexOf("@")) : trimmed;
  const words = local.split(/[\s._\-+]+/u).filter(Boolean);
  if (words.length >= 2 && words.slice(0, 2).every((word) => /^[A-Za-z]/.test(word))) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return getAuthorInitial(words[0] ?? trimmed);
}

/**
 * 提供元ロゴ。アプリの他の面と同じ現行のマークを使う (OpenAI は Blossom、Claude、Gemini)。
 * マークは自分で幅と高さを持つので、場面ごとの大きさは外側の `.comment-author-avatar-logo` が決める。
 * Google は Antigravity と Gemini を同じ提供元に寄せているため、モデル名で描き分ける。
 */
function CommentAgentLogo({ agent }: { agent: SigmaCommentAgent }) {
  return <span className="comment-author-avatar-logo" aria-hidden="true">{renderAgentMark(agent)}</span>;
}

function renderAgentMark(agent: SigmaCommentAgent) {
  switch (agent.vendor) {
    case "openai":
      return <OpenAiMark />;
    case "anthropic":
      return <ClaudeMark />;
    case "google":
      return agent.model?.toLowerCase().includes("antigravity") ? <AntigravityMark /> : <GeminiMark />;
    case "microsoft":
      // Microsoft だけは 4 色が意味を持つので、固有色の 4 つの四角で描く。
      return (
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
          <rect x="1" y="1" width="10" height="10" fill="#f25022" />
          <rect x="13" y="1" width="10" height="10" fill="#7fba00" />
          <rect x="1" y="13" width="10" height="10" fill="#00a4ef" />
          <rect x="13" y="13" width="10" height="10" fill="#ffb900" />
        </svg>
      );
    default:
      return <SparkleGlyph size={15} />;
  }
}

function SparkleGlyph({ size = 9 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
      <path d={SPARKLE_PATH} fill="currentColor" />
    </svg>
  );
}

/** 四芒星。提供元ロゴを持たない AI と、アバター右下の AI バッジに使う。 */
const SPARKLE_PATH = "M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12";
