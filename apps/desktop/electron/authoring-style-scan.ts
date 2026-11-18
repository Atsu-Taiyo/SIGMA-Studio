/**
 * Notes and edit examples are placed in the AI prompt, so text that reads like
 * an instruction to the model, asks for credentials, or hides characters is
 * withheld. Nothing is rewritten on disk: the caller reports how much was held back.
 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁯﻿\u{E0000}-\u{E007F}]/u;
/** Control characters other than the line break, and halves of a surrogate pair. Handed to a model as a space. */
export const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
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
  /\brm\s+-[a-z]*[rf]|\b(?:shell|terminal)\s+commands?\b|\bexecute\s+(?:the\s+|this\s+|any\s+)?(?:following\s+)?(?:commands?|code|scripts?)\b/i,
  /\b(?:every|all|any)\s+(?:subsequent|future|following)\s+(?:requests?|messages?|prompts?|turns?)\b/i,
  /(?:シェル|ターミナル)(?:の)?コマンド|コマンドを実行|(?:今後|以後|以降)の(?:すべての|全ての)?(?:依頼|指示|要求|リクエスト)/u,
];

export function isSuspicious(text: string): boolean {
  // Full-width and other compatibility forms are read as the plain characters they stand for.
  const plain = text.normalize("NFKC");
  // A control character between two words is read by a model as the space it is handed on as.
  const spaced = plain.replace(CONTROL, " ");
  return INVISIBLE.test(text) || THREATS.some(pattern => pattern.test(text) || pattern.test(plain) || pattern.test(spaced));
}

/** Drop suspicious lines, keeping the rest of a note usable. */
export function scanLines(text: string): { text: string; blocked: number } {
  const lines = text.split("\n");
  const held = lines.map(line => isSuspicious(line));
  // An instruction broken over two lines reads as one. Both lines go.
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!held[index] && !held[index + 1] && isSuspicious(`${lines[index]} ${lines[index + 1]}`)) held[index] = held[index + 1] = true;
  }
  const blocked = held.filter(Boolean).length;
  return { text: blocked ? lines.filter((_, index) => !held[index]).join("\n") : text, blocked };
}
