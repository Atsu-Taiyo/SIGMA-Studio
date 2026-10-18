import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommentAuthorAvatar, getAuthorInitials } from "./CommentAuthorAvatar";

const render = (vendor: "openai" | "anthropic" | "google" | "microsoft" | "meta" | "other", model?: string) =>
  renderToStaticMarkup(<CommentAuthorAvatar name="AI" agent={{ vendor, model }} />);

describe("CommentAuthorAvatar AI logos", () => {
  it("uses the current provider marks the rest of the app uses, on a white ground", () => {
    const openai = render("openai");
    // 現行の OpenAI のマーク (Blossom) で、旧ロゴの六角の結び目ではない。
    expect(openai).toContain("M9.205 8.658");
    expect(openai).not.toContain("M22.2819 9.8211");
    expect(openai).toContain("background:#ffffff");

    const anthropic = render("anthropic");
    expect(anthropic).toContain("#D97757");
    expect(anthropic).not.toContain("M17.3041 3.541h");
    expect(anthropic).toContain("background:#ffffff");
  });

  it("draws Google with the Gemini mark, or Antigravity's when the model says so", () => {
    expect(render("google", "Gemini 3.5 Flash")).toContain("sigma-gemini-mark-gradient");
    expect(render("google")).toContain("sigma-gemini-mark-gradient");
    expect(render("google", "Antigravity")).toContain("sigma-antigravity-mark-gradient");
  });

  it("keeps Microsoft's four colors and the generic mark for providers without a logo", () => {
    expect(render("microsoft")).toContain("#f25022");
    const meta = render("meta");
    expect(meta).not.toContain("comment-author-avatar-logo");
    expect(meta).toContain("background:#0064e0");
  });

  it("still marks every AI avatar with the AI badge and a readable name", () => {
    const html = render("openai");
    expect(html).toContain("comment-author-avatar-badge");
    expect(html).toContain('role="img"');
  });
});

describe("CommentAuthorAvatar people", () => {
  it("英字の姓名は頭文字 2 つ、メールは名前の部分から、漢字は 1 文字", () => {
    expect(getAuthorInitials("Atsushi Kim")).toBe("AK");
    expect(getAuthorInitials("hanako.sato@example.test")).toBe("HS");
    expect(getAuthorInitials("taro@example.test")).toBe("T");
    expect(getAuthorInitials("佐藤 花子")).toBe("佐");
    expect(getAuthorInitials("  ")).toBe("G");
  });

  it("アイコンの画像は img で読み、読めないときに頭文字へ戻せるようにする", () => {
    const html = renderToStaticMarkup(<CommentAuthorAvatar name="Atsushi Kim" avatarUrl="sigma-collaboration-profile://avatar?url=x" />);
    expect(html).toContain('<img src="sigma-collaboration-profile://avatar?url=x"');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    expect(renderToStaticMarkup(<CommentAuthorAvatar name="Atsushi Kim" />)).toContain(">AK<");
  });
});
