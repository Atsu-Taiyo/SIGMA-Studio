"use client";

import type { PageCanvasSelectionExtension } from "@/components/editor/page-canvas/editor-extension";
import { addSelectionToPocket, PocketIcon } from "@/features/pocket";
import { useT } from "@/lib/i18n/react";

import { useSelectionToolbarBinding } from "./binding";
import { TOOLBAR_ICON_SIZE, ToolDivider, ToolLabelButton } from "./controls";
import { ShapeSelectionTools } from "./ShapeSelectionTools";
import { TextSelectionTools } from "./TextSelectionTools";

/**
 * 選択に添えて出す編集操作 (書式・図形の操作) を、紙面の汎用の選択拡張として渡す。
 *
 * 紙面は選択の測定と配置だけを持ち、並べる中身はここが決める。状態と操作は
 * `SelectionToolbarProvider` 越しに `EditorShell` から読むので、拡張そのものは
 * アクションの識別 (`key`) しか持たない — 太字の状態などが変わってもアクションは作り直されない。
 */
export function createSelectionToolbarExtension(): PageCanvasSelectionExtension {
  return {
    createAction: (source) => {
      if (source.kind === "textRange") {
        return {
          key: JSON.stringify(["tools", "text", source.targetId]),
          render: () => <TextToolsHost />,
        };
      }
      if (source.kind === "overlaySelection" && source.selection.selectedCount > 0) {
        return {
          key: JSON.stringify(["tools", "overlay", source.selection.selectedShapeIds]),
          render: () => <ShapeToolsHost />,
        };
      }
      return null;
    },
  };
}

/**
 * 選んでいる文章・図形をポケットへ入れる。押しても選択は動かない (ボタンが焦点を奪わない) ので、
 * 続けて別のものを選んで入れられる。入れ方は ⌘⇧C と同じ。
 * アイコンだけでは「何が起きるか」が読み取れないので、AI への依頼やコメントと同じく言葉を添える。
 */
function PocketAddTool() {
  const t = useT("editor");
  return (
    <ToolLabelButton label={t("pocket.addToPocket")} onClick={() => { addSelectionToPocket(); }}>
      <PocketIcon size={TOOLBAR_ICON_SIZE} />
    </ToolLabelButton>
  );
}

function TextToolsHost() {
  const binding = useSelectionToolbarBinding();
  if (!binding || !binding.text.enabled) {
    return null;
  }
  return (
    <>
      <TextSelectionTools text={binding.text} />
      <PocketAddTool />
      <ToolDivider />
    </>
  );
}

function ShapeToolsHost() {
  const binding = useSelectionToolbarBinding();
  if (!binding || binding.shape.selection.selectedCount === 0) {
    return null;
  }
  return (
    <>
      <ShapeSelectionTools shape={binding.shape} text={binding.text} />
      <PocketAddTool />
      <ToolDivider />
    </>
  );
}
