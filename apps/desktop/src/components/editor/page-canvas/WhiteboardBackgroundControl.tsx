"use client";

import { Ban, Grid3x3, Grip } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import type { PageBackground } from "@/features/document";
import { useT } from "@/lib/i18n/react";

/**
 * キャンバス右下の浮遊コントロール。ズームピルの左隣に並ぶ。
 *
 * 用紙設定ダイアログには置かない — 下地の切り替えは「見ながら選ぶ」操作で、
 * ダイアログを開かせると即時性が失われる (確定した設計判断)。
 * 見た目は `.whiteboard-zoom-controls` と同じ規則を共有する (globals.css で両クラスを
 * 並べている)。新しい色トークン・影・角丸は作らない。
 */
const OPTIONS = [
  { value: "grid", labelKey: "whiteboardBackground.grid", Icon: Grid3x3 },
  { value: "dots", labelKey: "whiteboardBackground.dots", Icon: Grip },
  { value: "none", labelKey: "whiteboardBackground.none", Icon: Ban },
] as const satisfies readonly {
  value: PageBackground;
  labelKey: "whiteboardBackground.grid" | "whiteboardBackground.dots" | "whiteboardBackground.none";
  Icon: typeof Grid3x3;
}[];

export interface WhiteboardBackgroundControlProps {
  value: PageBackground;
  onChange: (background: PageBackground) => void;
}

export function WhiteboardBackgroundControl({ value, onChange }: WhiteboardBackgroundControlProps) {
  const t = useT("shape");
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(0, OPTIONS.findIndex((option) => option.value === value));

  /**
   * `role="radiogroup"` は「Tab で 1 回入って、あとは矢印で選ぶ」ことを読み上げで約束する。
   * roving tabIndex と矢印キーを実装しないと、その約束だけして中身が無い状態になる。
   */
  const moveTo = (index: number) => {
    const wrapped = (index + OPTIONS.length) % OPTIONS.length;
    buttonRefs.current[wrapped]?.focus();
    onChange(OPTIONS[wrapped].value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(selectedIndex + 1);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(selectedIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveTo(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveTo(OPTIONS.length - 1);
    }
  };

  return (
    <div
      className="whiteboard-background-controls"
      role="radiogroup"
      aria-label={t("whiteboardBackground.aria")}
      onKeyDown={handleKeyDown}
    >
      {OPTIONS.map(({ value: option, labelKey, Icon }, index) => {
        const label = t(labelKey);
        return (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          aria-label={label}
          title={label}
          tabIndex={index === selectedIndex ? 0 : -1}
          ref={(node) => {
            buttonRefs.current[index] = node;
          }}
          className={value === option ? "is-selected" : undefined}
          onClick={() => onChange(option)}
        >
          <Icon size={14} />
        </button>
        );
      })}
    </div>
  );
}
