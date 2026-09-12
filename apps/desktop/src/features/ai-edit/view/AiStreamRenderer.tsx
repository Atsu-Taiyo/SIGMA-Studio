"use client";

import { Fragment, useMemo } from "react";

import type { MathFractionSizing } from "@/features/document";
import { InlineMathPreview } from "@/features/rendering/adapters/react";

export interface AiStreamRendererProps {
  text: string;
  className?: string;
  mathFractionSizing?: MathFractionSizing | null;
}

type Segment =
  | { kind: "text"; value: string }
  | { kind: "math"; tex: string; display: boolean };

const MATH_DELIMITERS: Array<{ open: string; close: string; display: boolean }> = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  { open: "$", close: "$", display: false },
];

function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = "";
  let i = 0;

  while (i < text.length) {
    const matchedDelim = MATH_DELIMITERS.find((d) => text.startsWith(d.open, i));
    if (matchedDelim) {
      const start = i + matchedDelim.open.length;
      const closeAt = text.indexOf(matchedDelim.close, start);
      if (closeAt !== -1) {
        if (buffer) {
          segments.push({ kind: "text", value: buffer });
          buffer = "";
        }
        segments.push({
          kind: "math",
          tex: text.slice(start, closeAt),
          display: matchedDelim.display,
        });
        i = closeAt + matchedDelim.close.length;
        continue;
      }

      // Partial / unterminated math at stream tail. Render what we have so far
      // as math so the user sees progressive equations.
      const tail = text.slice(start);
      if (tail.length > 0) {
        if (buffer) {
          segments.push({ kind: "text", value: buffer });
          buffer = "";
        }
        segments.push({ kind: "math", tex: tail, display: matchedDelim.display });
      }
      return segments;
    }

    buffer += text[i];
    i += 1;
  }

  if (buffer) {
    segments.push({ kind: "text", value: buffer });
  }
  return segments;
}

interface Block {
  kind: "heading" | "paragraph" | "list" | "ordered" | "code";
  level?: number;
  lines: string[];
  language?: string;
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({ kind: "code", lines: codeLines, language });
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: Math.min(3, headingMatch[1].length),
        lines: [headingMatch[2]],
      });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trimStart())) {
        items.push(lines[i].trimStart().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", lines: items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trimStart())) {
        items.push(lines[i].trimStart().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ordered", lines: items });
      continue;
    }

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^(#{1,3})\s+/.test(lines[i].trimStart()) &&
      !/^[-*]\s+/.test(lines[i].trimStart()) &&
      !/^\d+\.\s+/.test(lines[i].trimStart()) &&
      !lines[i].trimStart().startsWith("```")
    ) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function renderInline(text: string, keyPrefix: string, mathFractionSizing?: MathFractionSizing | null) {
  const segments = tokenize(text);
  return segments.map((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.kind === "math") {
      return (
        <InlineMathPreview
          key={key}
          tex={segment.tex.trim()}
          displayMode={segment.display}
          mathFractionSizing={mathFractionSizing}
        />
      );
    }
    return <InlineMarkdown key={key} text={segment.value} />;
  });
}

function InlineMarkdown({ text }: { text: string }) {
  // Minimal inline markdown: **bold**, *italic*, `code`. Single pass.
  const nodes: React.ReactNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      const parts = buffer.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) {
          nodes.push(<br key={`br:${nodes.length}:${index}`} />);
        }
        if (part) {
          nodes.push(part);
        }
      });
      buffer = "";
    }
  };

  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        nodes.push(<strong key={`b:${i}`}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push(<code key={`c:${i}`}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && end !== i + 1) {
        flush();
        nodes.push(<em key={`i:${i}`}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }

    buffer += text[i];
    i += 1;
  }

  flush();
  return <>{nodes}</>;
}

function renderLineBreaks(lines: string[], keyPrefix: string, mathFractionSizing?: MathFractionSizing | null) {
  return (
    <Fragment key={`${keyPrefix}:lines`}>
      {renderInline(lines.join("\n"), `${keyPrefix}:lines`, mathFractionSizing)}
    </Fragment>
  );
}

export function AiStreamRenderer({ text, className, mathFractionSizing }: AiStreamRendererProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  if (!text.trim()) {
    return null;
  }

  const classes = ["ai-stream-render", "rich-inline-content", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {blocks.map((block, index) => {
        const key = `b${index}`;

        if (block.kind === "heading") {
          const level = block.level ?? 2;
          const content = renderInline(block.lines[0] ?? "", key, mathFractionSizing);
          if (level === 1) {
            return <h3 key={key}>{content}</h3>;
          }
          if (level === 2) {
            return <h4 key={key}>{content}</h4>;
          }
          return <h5 key={key}>{content}</h5>;
        }

        if (block.kind === "list") {
          return (
            <ul key={key}>
              {block.lines.map((item, idx) => (
                <li key={`${key}:i${idx}`}>{renderInline(item, `${key}:i${idx}`, mathFractionSizing)}</li>
              ))}
            </ul>
          );
        }

        if (block.kind === "ordered") {
          return (
            <ol key={key}>
              {block.lines.map((item, idx) => (
                <li key={`${key}:i${idx}`}>{renderInline(item, `${key}:i${idx}`, mathFractionSizing)}</li>
              ))}
            </ol>
          );
        }

        if (block.kind === "code") {
          return (
            <pre key={key} className="ai-stream-code" data-language={block.language || undefined}>
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }

        return <p key={key}>{renderLineBreaks(block.lines, key, mathFractionSizing)}</p>;
      })}
    </div>
  );
}
