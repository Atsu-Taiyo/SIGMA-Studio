"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { OverlayActionRequestInput, OverlaySelectionStylePatch, OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { BoxedVariant } from "@/features/document";
import type { TextAlign } from "@/features/document";

import type { BlockStructureOptionValue, BlockStyleOptionValue } from "../constants";
import type { BlockStyleToolbarState } from "../toolbar-formatting";

/**
 * 選択バーが上部ツールバーと **同じ状態・同じ操作** を使うための束ね。
 *
 * 状態の持ち主は `EditorShell` のままで、ここは読み書きの窓口だけ。バーは書式の実装を持たず、
 * 上部ツールバーが送るのと同じ要求 (`FORMAT_TEXT_EVENT`・オーバーレイ操作) を送る。
 * そのため、押せる/押せないの判定や跨ぎ選択・AI ロックの扱いは、ツールバーと必ず一致する。
 */
export interface SelectionToolbarTextBinding {
  /** 文字書式 (太字・サイズ・色…) を受けられる選択か。 */
  enabled: boolean;
  canBlockStyle: boolean;
  canBlockStructure: boolean;
  canAlign: boolean;
  fontSize: number;
  fontSizeMixed: boolean;
  /** `paragraph` / `h1`〜`h3`。段落スタイルの対象でなければ空文字。 */
  blockStyle: string;
  blockStructure: BlockStyleToolbarState;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  boxed: boolean;
  boxedVariant: BoxedVariant;
  boxedPaddingY: number;
  textColor: string;
  textBackgroundColor: string | null;
  textAlign: TextAlign;
  toggleInline: (command: "bold" | "italic" | "underline") => void;
  applyBlockStyle: (style: BlockStyleOptionValue) => void;
  applyBlockStructure: (value: BlockStructureOptionValue | "divider") => void;
  setFontSize: (size: number) => void;
  toggleBoxed: () => void;
  selectBoxedVariant: (variant: BoxedVariant) => void;
  setBoxedPaddingY: (paddingY: number) => void;
  setTextColor: (color: string) => void;
  setTextBackgroundColor: (color: string | null) => void;
  applyTextAlign: (align: TextAlign) => void;
  insertBoxBlock: () => void;
}

export interface SelectionToolbarShapeBinding {
  /** 図形を編集できる状況か (AI による編集ロック中は false)。 */
  enabled: boolean;
  selection: OverlaySelectionSummary;
  strokeColor: string | null;
  fillColor: string | null;
  fillOpacity: number;
  applyStyle: (patch: OverlaySelectionStylePatch) => void;
  fillColorPatch: (color: string) => OverlaySelectionStylePatch;
  request: (request: OverlayActionRequestInput) => void;
  /** 素材として保存できる文脈のときだけ渡る。 */
  saveAsMaterial?: () => void;
}

export interface SelectionToolbarBinding {
  text: SelectionToolbarTextBinding;
  shape: SelectionToolbarShapeBinding;
}

const SelectionToolbarContext = createContext<SelectionToolbarBinding | null>(null);

export function SelectionToolbarProvider({
  value,
  children,
}: {
  value: SelectionToolbarBinding;
  children: ReactNode;
}) {
  return <SelectionToolbarContext.Provider value={value}>{children}</SelectionToolbarContext.Provider>;
}

export function useSelectionToolbarBinding(): SelectionToolbarBinding | null {
  return useContext(SelectionToolbarContext);
}
