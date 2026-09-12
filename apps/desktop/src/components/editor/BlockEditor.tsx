"use client";

import {
  ArrowDown,
  ArrowUp,
  Code,
  Copy,
  FileQuestion,
  GripVertical,
  ListPlus,
  PenLine,
  Quote,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import { useEditorExtensions } from "@/components/editor/editor-extension-context";
import { RichTextEditor } from "@/components/editor/RichTextEditor";
import { TextFlowEditor, type TextFlowBlock } from "@/components/editor/TextFlowEditor";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  CodeBlockNode,
  SigmaBlock,
  HeadingNode,
  ParagraphNode,
  ProblemAreaBlock,
  ProblemAreaKind,
  ProblemNode,
  QuoteBlockNode,
  RichBlock,
} from "@/features/document";
import { getTextFlowBlockChildren } from "@/features/text-editing";

export interface BlockEditorProps {
  block: SigmaBlock;
  selectedId: string | null;
  historyRevision: number;
  onSelect: (blockId: string) => void;
  onChange: (blockId: string, updater: (block: SigmaBlock | RichBlock) => SigmaBlock | RichBlock) => void;
  onDelete: (blockId: string) => void;
  onDuplicate: (blockId: string) => void;
  onMove: (blockId: string, direction: "up" | "down") => void;
  onAddProblemBlock: (problemId: string, area: ProblemAreaKind, block: RichBlock) => void;
  formatTarget?: string;
}

function useTextFlowEditPolicy() {
  return useEditorExtensions().textFlowEditPolicy;
}

export function BlockEditor(props: BlockEditorProps) {
  const { block } = props;

  if (block.type === "section") {
    return <SectionEditor {...props} block={block} />;
  }

  if (block.type === "heading") {
    return <HeadingEditor {...props} block={block} />;
  }

  if (block.type === "paragraph") {
    return <ParagraphEditor {...props} block={block} nested={false} />;
  }

  if (block.type === "list") {
    return <ListEditor {...props} block={block} nested={false} />;
  }

  if (block.type === "layoutSection") {
    return <LayoutSectionEditor {...props} block={block} />;
  }

  if (block.type === "boxBlock") {
    return <BoxBlockEditor {...props} block={block} />;
  }

  if (block.type === "divider") {
    return <hr className="block-editor-divider" data-sigma-doc-id={block.id} />;
  }

  if (block.type === "quote") {
    return <QuoteBlockEditor {...props} block={block} nested={false} />;
  }

  if (block.type === "codeBlock") {
    return <CodeBlockEditor {...props} block={block} nested={false} />;
  }

  return <ProblemEditor {...props} block={block} />;
}

interface TypedBlockProps<T extends SigmaBlock | RichBlock> extends Omit<BlockEditorProps, "block"> {
  block: T;
  nested?: boolean;
}

interface BlockFrameProps {
  block: SigmaBlock | RichBlock;
  selectedId: string | null;
  nested?: boolean;
  label: string;
  icon: ReactNode;
  children: ReactNode;
  onSelect: (blockId: string) => void;
  onDelete: (blockId: string) => void;
  onDuplicate: (blockId: string) => void;
  onMove: (blockId: string, direction: "up" | "down") => void;
}

function LayoutSectionEditor({
  block,
  ...props
}: TypedBlockProps<Extract<SigmaBlock, { type: "layoutSection" }>>) {
  const t = useT("editor");
  return (
    <BlockFrame
      {...props}
      block={block}
      label={t("block.columns", { columns: block.layout.columnCount })}
      icon={t("block.columnsIcon")}
    >
      <div className="nested-block-list">
        {block.children.map((child) => (
          <BlockEditor key={child.id} {...props} block={child} />
        ))}
      </div>
    </BlockFrame>
  );
}

function BlockFrame({
  block,
  selectedId,
  nested,
  label,
  icon,
  children,
  onSelect,
  onDelete,
  onDuplicate,
  onMove,
}: BlockFrameProps) {
  const t = useT("editor");
  const isSelected = selectedId === block.id;
  const alignClass =
    "align" in block && (block.align === "center" || block.align === "right") ? `text-align-${block.align}` : "";
  return (
    <section
      id={block.id}
      className={`editor-block type-${block.type} ${nested ? "nested" : ""} ${isSelected ? "selected" : ""} ${alignClass}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(block.id);
      }}
    >
      <div className="block-handle">
        <GripVertical size={16} />
        {label && (
          <>
            <span>{icon}</span>
            <span className="block-label">{label}</span>
          </>
        )}
      </div>
      {!nested && (
        <div className="block-actions">
          <button type="button" className="icon-button small" title={t("block.moveUp")} aria-label={t("block.moveUp")} onClick={() => onMove(block.id, "up")}>
            <ArrowUp size={15} />
          </button>
          <button type="button" className="icon-button small" title={t("block.moveDown")} aria-label={t("block.moveDown")} onClick={() => onMove(block.id, "down")}>
            <ArrowDown size={15} />
          </button>
          <button type="button" className="icon-button small" title={t("block.duplicate")} aria-label={t("block.duplicate")} onClick={() => onDuplicate(block.id)}>
            <Copy size={15} />
          </button>
          <button type="button" className="icon-button small danger" title={t("block.delete")} aria-label={t("block.delete")} onClick={() => onDelete(block.id)}>
            <Trash2 size={15} />
          </button>
        </div>
      )}
      <div className="block-content">{children}</div>
    </section>
  );
}

function SectionEditor({ block, onChange, ...props }: TypedBlockProps<SigmaBlock & { type: "section" }>) {
  const t = useT("editor");
  return (
    <BlockFrame {...props} block={block} label={t("block.section")} icon={<ListPlus size={15} />}>
      <input
        className="section-title-input"
        style={{ textAlign: block.align ?? "left" }}
        value={block.title}
        onChange={(event) => {
          const title = event.target.value;
          onChange(block.id, (node) => (node.type === "section" ? { ...node, title } : node));
        }}
        aria-label={t("block.sectionTitle")}
      />
    </BlockFrame>
  );
}

function HeadingEditor({ block, onChange, ...props }: TypedBlockProps<HeadingNode>) {
  const t = useT("editor");
  return (
    <BlockFrame {...props} block={block} label={t("block.headingLevel", { level: block.level })} icon={<PenLine size={15} />}>
      <RichTextEditor
        block={block}
        className={`rich-text heading-editor heading-${block.level}`}
        style={{ textAlign: block.align ?? "left" }}
        selected={props.selectedId === block.id}
        historyRevision={props.historyRevision}
        formatTarget={props.formatTarget}
        placeholder={t("block.heading")}
        onChange={(children, level) => {
          onChange(block.id, (node) =>
            node.type === "heading" ? { ...node, children, level: level ?? block.level } : node,
          );
        }}
      />
    </BlockFrame>
  );
}

function ParagraphEditor({ block, onChange, nested, ...props }: TypedBlockProps<ParagraphNode>) {
  const t = useT("editor");
  return (
    <BlockFrame {...props} nested={nested} block={block} label={nested ? "" : t("block.paragraph")} icon={<PenLine size={15} />}>
      <RichTextEditor
        block={block}
        placeholder={t("block.paragraph")}
        selected={props.selectedId === block.id}
        historyRevision={props.historyRevision}
        formatTarget={props.formatTarget}
        onChange={(children) => {
          onChange(block.id, (node) => (node.type === "paragraph" ? { ...node, children } : node));
        }}
      />
    </BlockFrame>
  );
}

/**
 * 引用とコードは本文フローのブロックなので、リストと同じく `TextFlowEditor` に丸ごと渡す。
 * 中身の編集規則 (引用の中で Enter を押す・コードの中で改行する) を二重に持たないための形。
 */
function QuoteBlockEditor({ block, onChange, nested, ...props }: TypedBlockProps<QuoteBlockNode>) {
  const editPolicy = useTextFlowEditPolicy();
  const t = useT("editor");

  return (
    <BlockFrame {...props} nested={nested} block={block} label={nested ? "" : t("block.quote")} icon={<Quote size={15} />}>
      <TextFlowEditor
        blocks={[block]}
        selectedId={props.selectedId}
        historyRevision={props.historyRevision}
        placeholder={t("block.quote")}
        onSelect={props.onSelect}
        onChange={(_previousIds, nextBlocks) => {
          const nextBlock = nextBlocks[0];
          onChange(block.id, (node) => (node.type === "quote" && nextBlock?.type === "quote" ? nextBlock : node));
        }}
        enableBoxCommands={false}
        formatTarget={props.formatTarget}
        editPolicy={editPolicy}
      />
    </BlockFrame>
  );
}

function CodeBlockEditor({ block, onChange, nested, ...props }: TypedBlockProps<CodeBlockNode>) {
  const editPolicy = useTextFlowEditPolicy();
  const t = useT("editor");

  return (
    <BlockFrame {...props} nested={nested} block={block} label={nested ? "" : t("block.code")} icon={<Code size={15} />}>
      <TextFlowEditor
        blocks={[block]}
        selectedId={props.selectedId}
        historyRevision={props.historyRevision}
        placeholder={t("block.code")}
        onSelect={props.onSelect}
        onChange={(_previousIds, nextBlocks) => {
          const nextBlock = nextBlocks[0];
          onChange(block.id, (node) => (
            node.type === "codeBlock" && nextBlock?.type === "codeBlock" ? nextBlock : node
          ));
        }}
        enableBoxCommands={false}
        formatTarget={props.formatTarget}
        editPolicy={editPolicy}
      />
    </BlockFrame>
  );
}

function ListEditor({ block, onChange, nested, ...props }: TypedBlockProps<Extract<RichBlock, { type: "list" }>>) {
  const t = useT("editor");
  const editPolicy = useTextFlowEditPolicy();

  return (
    <BlockFrame {...props} nested={nested} block={block} label={nested ? "" : t("block.list")} icon={<ListPlus size={15} />}>
      <TextFlowEditor
        blocks={[block]}
        selectedId={props.selectedId}
        historyRevision={props.historyRevision}
        placeholder={t("block.listItem")}
        onSelect={props.onSelect}
        onChange={(_previousIds, nextBlocks) => {
          const nextBlock = nextBlocks[0];
          onChange(block.id, (node) => (node.type === "list" && nextBlock?.type === "list" ? nextBlock : node));
        }}
        enableBoxCommands={false}
        formatTarget={props.formatTarget}
        editPolicy={editPolicy}
      />
    </BlockFrame>
  );
}

function BoxBlockEditor({ block, onChange, ...props }: TypedBlockProps<BoxBlockNode>) {
  const t = useT("editor");
  const editPolicy = useTextFlowEditPolicy();

  return (
    <BlockFrame {...props} block={block} label={t("block.box")} icon={<PenLine size={15} />}>
      <TextFlowEditor
        blocks={block.blocks}
        selectedId={props.selectedId}
        historyRevision={props.historyRevision}
        placeholder={t("block.boxBody")}
        onSelect={props.onSelect}
        enableBoxCommands={false}
        formatTarget={props.formatTarget}
        editPolicy={editPolicy}
        onChange={(_previousIds, nextBlocks) => {
          onChange(block.id, (node) => (
            node.type === "boxBlock"
              ? { ...node, blocks: nextBlocks.map((next) => textFlowBlockToBoxBlockChild(next, t)) }
              : node
          ));
        }}
      />
    </BlockFrame>
  );
}

function textFlowBlockToBoxBlockChild(block: TextFlowBlock, t: Translate<"editor">): BoxBlockChildBlock {
  if (block.type === "layoutSection") {
    return block;
  }
  if (block.type === "section" || block.type === "boxBlock") {
    return block;
  }
  return textFlowBlockToRichBlock(block, t);
}

function ProblemEditor({ block, onChange, ...props }: TypedBlockProps<ProblemNode>) {
  const t = useT("editor");
  return (
    <BlockFrame {...props} block={block} label={t("block.problem")} icon={<FileQuestion size={15} />}>
      <div className="semantic-block-header">
        <div className="semantic-block-title">
          <span>{t("block.problem")}</span>
        </div>
      </div>

      <RichBlockList
        title={t("block.problemLead")}
        blocks={block.lead}
        parent={block}
        area="lead"
        {...props}
        onChange={onChange}
      />

      <RichBlockList
        title={t("block.problemPrompt")}
        showTitle={false}
        blocks={block.prompt}
        parent={block}
        area="prompt"
        {...props}
        onChange={onChange}
      />

      <RichBlockList
        title={t("block.problemHints")}
        blocks={block.hints}
        parent={block}
        area="hints"
        {...props}
        onChange={onChange}
      />

      <RichBlockList
        title={t("block.problemSolution")}
        blocks={block.solution}
        parent={block}
        area="solution"
        {...props}
        onChange={onChange}
      />
    </BlockFrame>
  );
}

function RichBlockList({
  title,
  showTitle = true,
  blocks,
  parent,
  area,
  onChange,
  ...props
}: Omit<TypedBlockProps<ProblemNode>, "block"> & {
  title: string;
  showTitle?: boolean;
  blocks: ProblemAreaBlock[];
  parent: ProblemNode;
  area: ProblemAreaKind;
}) {
  const t = useT("editor");
  const editPolicy = useTextFlowEditPolicy();

  return (
    <div className="nested-group">
      {showTitle && (
        <div className="nested-group-header">
          <span>{title}</span>
        </div>
      )}
      <div className="nested-list">
        {buildRichRenderUnits(blocks).map((unit) =>
          unit.type === "textFlow" ? (
            <TextFlowEditor
              key={unit.id}
              blocks={unit.blocks}
              selectedId={props.selectedId}
              historyRevision={props.historyRevision}
              placeholder={placeholderForProblemArea(area, t)}
              onSelect={props.onSelect}
              enableBoxCommands
              formatTarget={props.formatTarget}
              editPolicy={editPolicy}
              onChange={(previousIds, nextBlocks) => {
                onChange(parent.id, (node) => {
                  if (node.type !== "problem") {
                    return node;
                  }

                  return {
                    ...node,
                    [area]: replaceRichTextFlow(node[area], previousIds, nextBlocks, t),
                  };
                });
              }}
            />
          ) : (
            <RichBlockEditor
              key={unit.block.id}
              block={unit.block}
              {...props}
              onChange={onChange}
              nested
            />
          ),
        )}
      </div>
    </div>
  );
}

function RichBlockEditor(props: Omit<BlockEditorProps, "block"> & { block: RichBlock; nested: boolean }) {
  const { block } = props;

  if (block.type === "paragraph") {
    return <ParagraphEditor {...props} block={block} />;
  }

  if (block.type === "list") {
    return <ListEditor {...props} block={block} />;
  }

  return <HeadingEditor {...props} block={block} />;
}

type RichRenderUnit =
  | {
      type: "textFlow";
      id: string;
      blocks: TextFlowBlock[];
    }
  | {
      type: "block";
      block: RichBlock;
    };

function buildRichRenderUnits(blocks: ProblemAreaBlock[]): RichRenderUnit[] {
  const units: RichRenderUnit[] = [];
  let textRun: TextFlowBlock[] = [];

  const flushTextRun = () => {
    if (textRun.length === 0) {
      return;
    }

    units.push({
      type: "textFlow",
      id: textRun[0].id,
      blocks: textRun,
    });
    textRun = [];
  };

  for (const block of blocks) {
    if (
      block.type === "paragraph" ||
      block.type === "heading" ||
      block.type === "list" ||
      block.type === "quote" ||
      block.type === "codeBlock" ||
      block.type === "divider" ||
      block.type === "layoutSection" ||
      block.type === "boxBlock"
    ) {
      textRun.push(block);
      continue;
    }

    flushTextRun();
    units.push({ type: "block", block });
  }

  flushTextRun();
  return units;
}

function replaceRichTextFlow(
  blocks: ProblemAreaBlock[],
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
  t: Translate<"editor">,
): ProblemAreaBlock[] {
  const firstIndex = blocks.findIndex((block) => previousIds.includes(block.id));
  if (firstIndex < 0) {
    return blocks;
  }

  const previousIdSet = new Set(previousIds);
  const next = [...blocks];
  let deleteCount = 0;

  while (next[firstIndex + deleteCount] && previousIdSet.has(next[firstIndex + deleteCount].id)) {
    deleteCount += 1;
  }

  next.splice(firstIndex, deleteCount, ...nextBlocks.map((nextBlock) => textFlowBlockToProblemAreaBlock(nextBlock, t)));
  return next;
}

function textFlowBlockToProblemAreaBlock(block: TextFlowBlock, t: Translate<"editor">): ProblemAreaBlock {
  if (block.type === "layoutSection" || block.type === "boxBlock") {
    return block;
  }
  return textFlowBlockToRichBlock(block, t);
}

/**
 * 箱や段組をリッチ本文へ落とすときの退避表現。ここで作る文字列は
 * **文書に残る**ので、作った時点の UI 言語で焼く (D3)。
 */
function textFlowBlockToRichBlock(block: TextFlowBlock, t: Translate<"editor">): RichBlock {
  if (block.type === "section") {
    return {
      type: "heading",
      id: block.id,
      level: 1,
      children: [{ type: "text", text: block.title }],
      align: block.align,
      lineHeight: block.lineHeight,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "heading") {
    return {
      type: "heading",
      id: block.id,
      level: block.level,
      children: block.children,
      align: block.align,
      lineHeight: block.lineHeight,
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "list") {
    return block;
  }

  if (block.type === "boxBlock") {
    return {
      type: "paragraph",
      id: block.id,
      children: block.title?.length ? block.title : [{ type: "text", text: t("block.box") }],
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "layoutSection") {
    return {
      type: "paragraph",
      id: block.id,
      children: [{ type: "text", text: t("block.columns", { columns: block.layout.columnCount }) }],
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "divider") {
    return {
      type: "paragraph",
      id: block.id,
      children: [{ type: "text", text: "――――" }],
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  if (block.type === "quote") {
    return {
      type: "paragraph",
      id: block.id,
      children: block.blocks.flatMap(getTextFlowBlockChildren),
      pagination: block.pagination,
      spaceAfterPx: block.spaceAfterPx,
    };
  }

  return {
    type: "paragraph",
    id: block.id,
    children: getTextFlowBlockChildren(block),
    align: "align" in block ? block.align : undefined,
    lineHeight: "lineHeight" in block ? block.lineHeight : undefined,
    pagination: block.pagination,
    spaceAfterPx: block.spaceAfterPx,
  };
}

function placeholderForProblemArea(area: ProblemAreaKind, t: Translate<"editor">): string {
  if (area === "lead") {
    return t("block.placeholder.lead");
  }

  if (area === "prompt") {
    return t("block.placeholder.prompt");
  }

  if (area === "solution") {
    return t("block.placeholder.solution");
  }

  return t("block.placeholder.hints");
}
