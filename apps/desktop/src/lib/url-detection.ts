/**
 * URL detection helpers used by the flow editor to recognise URLs as the user
 * types and offer a quick "turn into a QR code" action.
 *
 * Detection is intentionally view-only: matches are computed from text, not
 * persisted onto SigmaDoc. This keeps the document model unchanged while still
 * letting the editor highlight URLs and expose a QR action.
 */

export interface DetectedUrl {
  /** The matched URL text, with trailing punctuation trimmed. */
  url: string;
  /** Start offset within the scanned string (inclusive). */
  start: number;
  /** End offset within the scanned string (exclusive). */
  end: number;
}

// Matches http(s):// URLs. The body is limited to the RFC 3986 unreserved and
// reserved character set, so the match stops at whitespace and at CJK or other
// prose characters. Trailing punctuation is trimmed separately so sentences
// like "see https://example.com." work.
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

// Punctuation that commonly follows a URL in prose and should not be part of it.
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>。、，．！？」』）】〕》〉]+$/;

/**
 * Trim a closing bracket from the end of a URL only when it is unbalanced, so
 * that URLs that legitimately contain parentheses (e.g. Wikipedia links) are
 * preserved while a trailing ")" from prose is dropped.
 */
function trimTrailing(url: string): string {
  let result = url;
  // Repeatedly trim trailing prose punctuation. Closing brackets are kept when
  // a matching opener exists inside the URL.
  for (;;) {
    const match = TRAILING_PUNCTUATION.exec(result);
    if (!match) {
      break;
    }
    let trimmed = result;
    let changed = false;
    for (let i = result.length - 1; i >= match.index; i -= 1) {
      const char = result[i];
      if (char === ")" || char === "]" || char === "}") {
        const opener = char === ")" ? "(" : char === "]" ? "[" : "{";
        const opens = (trimmed.match(new RegExp(`\\${opener}`, "g")) ?? []).length;
        const closes = (trimmed.match(new RegExp(`\\${char}`, "g")) ?? []).length;
        if (closes <= opens) {
          break;
        }
      }
      trimmed = trimmed.slice(0, -1);
      changed = true;
    }
    if (!changed) {
      break;
    }
    result = trimmed;
  }
  return result;
}

/** Find every http(s) URL within `text`, returning matches in document order. */
export function findUrls(text: string): DetectedUrl[] {
  if (!text) {
    return [];
  }

  const matches: DetectedUrl[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const trimmed = trimTrailing(raw);
    if (trimmed.length === 0) {
      continue;
    }
    // A bare scheme like "https://" is not a usable URL.
    if (!/https?:\/\/\S/i.test(trimmed) || /^https?:\/\/$/i.test(trimmed)) {
      continue;
    }
    matches.push({
      url: trimmed,
      start: match.index,
      end: match.index + trimmed.length,
    });
  }
  return matches;
}

/** Whether the given string is exactly a single detectable URL. */
export function isSingleUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const matches = findUrls(trimmed);
  return matches.length === 1 && matches[0].url === trimmed;
}
