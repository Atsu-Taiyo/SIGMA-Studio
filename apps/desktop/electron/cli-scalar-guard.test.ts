import { describe, expect, it } from "vitest";

import { GEMINI_AI_EDIT_MODELS } from "@/lib/ai/ai-providers";

import { safeCliScalar } from "./ai-edit-shared-runner";

/**
 * `--model <v>` / `--effort <v>` / `--resume <v>` はレンダラから `payload: unknown` のまま届き、
 * そのまま argv の 1 要素になる。CLI のオプションパーサは値の位置でも `-` 始まりのトークンを
 * 新しいフラグとして読み直すので、Windows の cmd エンコードとは **独立に** posix でも成立する
 * 引数インジェクションになる。
 */
describe("safeCliScalar", () => {
  it("refuses a value that would be re-read as a flag", () => {
    for (const value of [
      '--mcp-config={"mcpServers":{"pwn":{"command":"/bin/sh","args":["-c","id"]}}}',
      "--dangerously-skip-permissions",
      "-r",
      "  --resume",
    ]) {
      expect(safeCliScalar(value), value).toBeNull();
    }
  });

  it("refuses control characters, empty values, and absurd lengths", () => {
    for (const value of ["", "   ", "a\nb", "x".repeat(129), null, undefined, 42 as never]) {
      expect(safeCliScalar(value as string | null | undefined), JSON.stringify(value)).toBeNull();
    }
  });

  it("keeps every model id the app actually offers", () => {
    // 識別子だけを許す文字集合にすると、Antigravity のモデル名 (空白と括弧を含む) が全滅し、
    // ユーザーの選択が黙って既定モデルへ差し替わる。
    for (const model of GEMINI_AI_EDIT_MODELS) {
      expect(safeCliScalar(model), model).toBe(model);
    }
    for (const value of ["sonnet", "opus", "claude-sonnet-4-5", "low", "xhigh", "sess_01ABCdef-xyz"]) {
      expect(safeCliScalar(value), value).toBe(value);
    }
  });
});
