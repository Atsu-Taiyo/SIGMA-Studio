"use client";

import { getCommentAgentBrand } from "@/lib/comment-agents";
import { useT } from "@/lib/i18n/react";
import type { SigmaCommentAgent, SigmaCommentAgentVendor } from "@/features/document";

/**
 * コメントの差出人アイコン。
 *
 * **人が書いたコメントと AI が書いたコメントを、名前を読まずに見分けられること**が
 * このコンポーネントの仕事。AI のときは `agent.vendor` の提供元ロゴを地色ごと出し、
 * 人のときは従来どおり頭文字を出す。ロゴを持たない提供元は頭文字 + 提供元の色で、
 * どちらの場合も右下に AI バッジを重ねる。
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
          ? <CommentAgentLogo vendor={agent.vendor} />
          : <span aria-hidden="true">{getAuthorInitial(name)}</span>}
        <span className="comment-author-avatar-badge" aria-hidden="true">
          <SparkleGlyph />
        </span>
      </span>
    );
  }

  if (avatarUrl) {
    return (
      <span
        className="comment-author-avatar image"
        role="img"
        aria-label={t("comment.avatarAria", { name })}
        style={{ backgroundImage: `url(${avatarUrl})` }}
      />
    );
  }

  return <span className="comment-author-avatar" aria-hidden="true">{getAuthorInitial(name)}</span>;
}

export function getAuthorInitial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] ?? "G").toUpperCase();
}

/**
 * 提供元ロゴ。`currentColor` で描くので、地色はアバター側が決める
 * (Microsoft だけは 4 色が意味を持つので固有色のまま)。
 */
function CommentAgentLogo({ vendor }: { vendor: SigmaCommentAgentVendor }) {
  if (vendor === "microsoft") {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="10" height="10" fill="#f25022" />
        <rect x="13" y="1" width="10" height="10" fill="#7fba00" />
        <rect x="1" y="13" width="10" height="10" fill="#00a4ef" />
        <rect x="13" y="13" width="10" height="10" fill="#ffb900" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path d={VENDOR_LOGO_PATHS[vendor] ?? SPARKLE_PATH} fill="currentColor" />
    </svg>
  );
}

function SparkleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="9" height="9" focusable="false">
      <path d={SPARKLE_PATH} fill="currentColor" />
    </svg>
  );
}

/** 四芒星。提供元ロゴを持たない AI と、アバター右下の AI バッジに使う。 */
const SPARKLE_PATH = "M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12";

const VENDOR_LOGO_PATHS: Partial<Record<SigmaCommentAgentVendor, string>> = {
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  google: SPARKLE_PATH,
};
