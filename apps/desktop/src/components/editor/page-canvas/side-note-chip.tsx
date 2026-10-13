"use client";

/**
 * サイド注の見出し (チップ)。段組の 2 段目以降では段の間に縦書きで出すので、2 桁までの数字は
 * 縦中横の印 (`side-note-digits`) で包む。横書きでは効かないので、1 段目の見え方は変わらない。
 * 段の間では短い形で出すので、元の呼び名は title (hover) に残す。
 */
export function SideNoteChip({ label, title }: { label: string; title?: string }) {
  return (
    <span title={title}>
      {label.split(/(\d+)/).map((part, index) => (
        index % 2 === 1 && part.length <= 2
          ? <span key={index} className="side-note-digits">{part}</span>
          : part
      ))}
    </span>
  );
}
