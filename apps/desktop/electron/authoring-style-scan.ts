/**
 * Notes and edit examples are placed in the AI prompt, so text that reads like
 * an instruction to the model, asks for credentials, or hides characters is
 * withheld. Nothing is rewritten on disk: the caller reports how much was held back.
 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁯﻿\u{E0000}-\u{E007F}]/u;
const THREATS: readonly RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)/i,
  /(?:system|developer)\s*(?:prompt|message)/i,
  /you\s+are\s+now\b/i,
  /<\/?\s*(?:system|instructions?|tool_call|function_calls?|assistant)\b/i,
  /(?:これまで|今まで|以前|上記|以上|前|先)の(?:指示|命令|プロンプト|ルール|設定)[をは](?:すべて|全て|全部)?(?:無視|忘れ|破棄|取り消)/u,
  /システム\s*プロンプト/u,
  /(?:api[_ -]?key|secret|password|token|credentials?|認証情報|パスワード|秘密鍵|トークン)[^\n]{0,60}(?:send|post|upload|exfiltrat|reveal|print|送信|送れ|送って|貼り付け|出力|表示|教え)/iu,
  /(?:curl|wget)\s+\S|\|\s*(?:sh|bash|zsh)\b/i,
];

export function isSuspicious(text: string): boolean {
  return INVISIBLE.test(text) || THREATS.some(pattern => pattern.test(text));
}

/** Drop suspicious lines, keeping the rest of a note usable. */
export function scanLines(text: string): { text: string; blocked: number } {
  let blocked = 0;
  const kept = text.split("\n").filter(line => {
    if (!isSuspicious(line)) return true;
    blocked++;
    return false;
  });
  return { text: blocked ? kept.join("\n") : text, blocked };
}
