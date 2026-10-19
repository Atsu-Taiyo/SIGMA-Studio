import { describe, expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { duplicateFailureMessage, ipcFailureReason } from "./duplicate-failure-message";

// Issue #250: duplicating a cloud material showed Electron's
// "Error invoking remote method 'storage:duplicate-file': Error: TARGET_UNAVAILABLE".
const ipc = (reason: string) => new Error(`Error invoking remote method 'storage:duplicate-file': Error: ${reason}`);

describe("duplicate failure messages", () => {
  it("removes Electron's IPC prefix", () => {
    expect(ipcFailureReason(ipc("MISSING_ASSET"))).toBe("MISSING_ASSET");
    expect(ipcFailureReason(new Error("Error invoking remote method 'storage:duplicate-file': TypeError: fetch failed"))).toBe("fetch failed");
    expect(ipcFailureReason(new Error("CATALOG_OFFLINE"))).toBe("CATALOG_OFFLINE");
    expect(ipcFailureReason(undefined)).toBe("");
  });

  it("says why in Japanese and what to do, never the internal call", () => {
    const t = createTranslator("ja", "editor");
    const cases: [unknown, string][] = [
      [ipc("TARGET_UNAVAILABLE"), "複製元の教材が見つからないか、アクセスできなくなっています。教材一覧を開き直して確認してください。"],
      [ipc("FORBIDDEN"), "この場所に教材を作成する権限がありません。"],
      [ipc("READ_ONLY"), "複製元の教材が見つからないか、アクセスできなくなっています。教材一覧を開き直して確認してください。"],
      [ipc("HIERARCHY_SHARE_IN_PROGRESS"), "共有の準備が終わっていないため、複製できません。準備が終わってから、もう一度お試しください。"],
      [ipc("AUTH_REQUIRED"), "共有教材を複製するにはサインインが必要です。サインインしてから、もう一度お試しください。"],
      [ipc("MISSING_ASSET"), "教材の画像を取得できなかったため、複製できませんでした。元の教材はそのままです。接続を確認して、もう一度お試しください。"],
      [ipc("CATALOG_OFFLINE"), "共有サーバーに接続できないため、教材を複製できませんでした。元の教材はそのままです。接続を確認して、もう一度お試しください。"],
      [new Error("Error invoking remote method 'storage:duplicate-file': TypeError: fetch failed"), "共有サーバーに接続できないため、教材を複製できませんでした。元の教材はそのままです。接続を確認して、もう一度お試しください。"],
      [ipc("HTTP_503"), "共有サーバーに接続できないため、教材を複製できませんでした。元の教材はそのままです。接続を確認して、もう一度お試しください。"],
      // An unknown code still reads as a sentence, with the code kept for support.
      [ipc("INVALID_REQUEST"), "教材を複製できませんでした（INVALID_REQUEST）。元の教材はそのままです。"],
      // main already explained it in Japanese (a local material that disappeared).
      [ipc("複製元の教材が見つかりません"), "複製元の教材が見つかりません"],
      [new Error("Error invoking remote method 'storage:duplicate-file': Error: Cannot read properties of undefined"), "教材を複製できませんでした"],
      [undefined, "教材を複製できませんでした"],
    ];
    for (const [error, expected] of cases) {
      const message = duplicateFailureMessage(error, t);
      expect(message).toBe(expected);
      expect(message).not.toMatch(/invoking|remote method/u);
    }
  });

  it("has English copy for every reason", () => {
    const t = createTranslator("en", "editor");
    expect([
      duplicateFailureMessage(ipc("TARGET_UNAVAILABLE"), t), duplicateFailureMessage(ipc("HIERARCHY_SHARE_IN_PROGRESS"), t),
      duplicateFailureMessage(ipc("AUTH_REQUIRED"), t), duplicateFailureMessage(ipc("MISSING_ASSET"), t),
      duplicateFailureMessage(ipc("CATALOG_OFFLINE"), t), duplicateFailureMessage(ipc("INVALID_REQUEST"), t),
    ]).toEqual([
      "The original document cannot be found or is no longer accessible. Reopen the document list to check.",
      "This document cannot be duplicated until sharing finishes setting up. Try again when it is done.",
      "Sign in to duplicate a shared document, then try again.",
      "Could not duplicate the document because its images could not be retrieved. The original is unchanged. Check your connection and try again.",
      "Could not duplicate the document because the sharing server cannot be reached. The original is unchanged. Check your connection and try again.",
      "Could not duplicate the document (INVALID_REQUEST). The original is unchanged.",
    ]);
  });
});
