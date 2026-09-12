import { isMathTexCommandSupported } from "@/lib/math-tex";

export interface InlineMathTexHighlightSegment {
  text: string;
  recognizedCommand: boolean;
}

const TEX_COMMAND_PATTERN = /\\(?:[A-Za-z]+|[^\r\n])/g;

/**
 * TeXを表示用の断片に分け、MathLiveまたはKaTeXが認識するコマンドだけをマークする。
 * 引数不足や利用できる環境の制約は未知コマンドではないため着色を維持する。
 */
export function getInlineMathTexHighlightSegments(tex: string): InlineMathTexHighlightSegment[] {
  const segments: InlineMathTexHighlightSegment[] = [];
  let cursor = 0;

  for (const match of tex.matchAll(TEX_COMMAND_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ text: tex.slice(cursor, index), recognizedCommand: false });
    }
    segments.push({
      text: match[0],
      recognizedCommand: isMathTexCommandSupported(match[0]),
    });
    cursor = index + match[0].length;
  }

  if (cursor < tex.length) {
    segments.push({ text: tex.slice(cursor), recognizedCommand: false });
  }

  return segments;
}
