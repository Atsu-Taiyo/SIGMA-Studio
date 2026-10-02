"use client";
import { type LayoutSectionNode } from "@/features/document";
import { type PageBreakMarkerKind } from "@/features/text-editing";
import { useT } from "@/lib/i18n/react";
import { ChevronRight,Columns3,Copy,CornerDownRight,Heading,PackagePlus,Settings2,Trash2 } from "lucide-react";
import { getLayoutSectionColumnCount } from "./render-units";

/**
 * Whether a manual break at this spot is a column break (改段) rather than a page break
 * (改ページ): either the whole page uses multi-column flow, or the block sits inside a local
 * (段組) layoutSection with more than one column. Shared by the body and problem context menus
 * so their item labels always agree with what `getColumnBreakBeforeBlockIdForContextMenu` /
 * the on-canvas marker actually do.
 */
export function resolveContextMenuBreaksToColumn(isColumnFlow: boolean, layoutSection: LayoutSectionNode | null): boolean {
  return isColumnFlow || (!!layoutSection && getLayoutSectionColumnCount(layoutSection) > 1);
}

/** 段組の中かどうかで区切りの**種別**を決める (表示文言は描画側が作る)。 */
export function resolvePageBreakMarkerKind(isColumnBreak: boolean): PageBreakMarkerKind {
  return isColumnBreak ? "columnBreak" : "pageBreak";
}

/**
 * Block-scoped menu items shared by the body ("本文操作") and problem ("問題操作") context
 * menus: "ここを段組にする" / "段組を変更"+"段組を解除" / block-scoped "素材に追加" / the
 * 改ページ・改段 挿入・解除 pair. The problem menu renders this only when its target is a
 * concrete block inside prompt/hints/solution (not `lead`, and not the problem-wide actions
 * like copying the whole problem or saving it as a material).
 */
export function BlockContextMenuItems({
  targetBlockId,
  selectionBlockIds,
  layoutSection,
  canWrapInColumns,
  canEditColumns,
  breakKind,
  showInsertBreak,
  showRemoveBreak,
  onWrapBlockInColumns,
  onUnwrapColumns,
  onColumnCountChange,
  onColumnRuleSettings,
  onMaterialSaveRequest,
  onSelectionMaterialSaveRequest,
  boxId,
  onBoxTitleEditRequest,
  onBoxSettingsRequest,
  onBoxCopy,
  onBoxDelete,
  onInsertBreak,
  onRemoveBreak,
  onClose,
}: {
  targetBlockId: string;
  selectionBlockIds: string[];
  layoutSection: LayoutSectionNode | null;
  canWrapInColumns: boolean;
  canEditColumns: boolean;
  /**
   * 区切りの**種別**。表示文言を型の判別子にすると、訳した瞬間に型が変わって
   * 分岐が壊れる (`page-break-gap-extension.ts` で実際に起きていた形)。
   * 文言はメニュー側が種別から作る。
   */
  breakKind: PageBreakMarkerKind;
  showInsertBreak: boolean;
  showRemoveBreak: boolean;
  onWrapBlockInColumns?: (blockIds: string[], columnCount: number) => void;
  onUnwrapColumns?: (sectionId: string) => void;
  onColumnCountChange: (sectionId: string, columnCount: number) => void;
  onColumnRuleSettings: (sectionId: string, blockId: string) => void;
  onMaterialSaveRequest?: (targetBlockId?: string | null) => void;
  onSelectionMaterialSaveRequest?: (blockIds: string[]) => void;
  boxId?: string | null;
  onBoxTitleEditRequest?: (boxId: string) => void;
  onBoxSettingsRequest?: (boxId: string) => void;
  onBoxCopy?: (boxId: string) => void;
  onBoxDelete?: (boxId: string) => void;
  onInsertBreak: () => void;
  onRemoveBreak: () => void;
  onClose: () => void;
}) {
  const tEditor = useT("editor");
  const tSettings = useT("settings");
  // 「改ページ」「改段」は本文編集面の語彙 (`editor` namespace)。
  const breakLabel = breakKind === "columnBreak"
    ? tEditor("pagination.columnBreak")
    : tEditor("pagination.pageBreak");
  const layoutSectionColumnCount = layoutSection ? getLayoutSectionColumnCount(layoutSection) : 1;

  return (
    <>
      {canWrapInColumns && (
        <div className="page-context-menu-submenu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            onClick={(event) => event.preventDefault()}
          >
            <Columns3 size={15} />
            <span>{tEditor(selectionBlockIds.length > 1 ? "pageMenu.wrapSelectionInColumns" : "pageMenu.wrapInColumns")}</span>
            <ChevronRight size={14} className="page-context-menu-caret" aria-hidden="true" />
          </button>
          <div className="page-context-menu-submenu-panel" role="menu" aria-label={tEditor("pageMenu.columns")}>
            {[2, 3, 4].map((columnCount) => (
              <button
                key={columnCount}
                type="button"
                role="menuitem"
                onClick={() => {
                  onWrapBlockInColumns?.(
                    selectionBlockIds.length > 0 ? selectionBlockIds : [targetBlockId],
                    columnCount,
                  );
                  onClose();
                }}
              >
                <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {canEditColumns && layoutSection && (
        <>
          <button type="button" role="menuitem" onClick={() => { onColumnRuleSettings(layoutSection.id, targetBlockId); onClose(); }}>
            <Settings2 size={15} />
            <span>{tSettings("columnRule.title")}</span>
          </button>
          <div className="page-context-menu-submenu">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onClick={(event) => event.preventDefault()}
            >
              <Columns3 size={15} />
              <span>{tEditor("pageMenu.changeColumns")}</span>
              <ChevronRight size={14} className="page-context-menu-caret" aria-hidden="true" />
            </button>
            <div className="page-context-menu-submenu-panel" role="menu" aria-label={tEditor("pageMenu.changeColumns")}>
              {[2, 3, 4].map((columnCount) => (
                <button
                  key={columnCount}
                  type="button"
                  role="menuitemradio"
                  aria-checked={layoutSectionColumnCount === columnCount}
                  className={layoutSectionColumnCount === columnCount ? "selected" : ""}
                  onClick={() => {
                    onColumnCountChange(layoutSection.id, columnCount);
                    onClose();
                  }}
                >
                  <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
                </button>
              ))}
            </div>
          </div>
          {onUnwrapColumns && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onUnwrapColumns(layoutSection.id);
                onClose();
              }}
            >
              <Columns3 size={15} />
              <span>{tEditor("pageMenu.unwrapColumns")}</span>
            </button>
          )}
        </>
      )}
      {boxId && onBoxTitleEditRequest && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxTitleEditRequest(boxId);
            onClose();
          }}
        >
          <Heading size={15} />
          <span>{tEditor("pageMenu.boxEditTitle")}</span>
        </button>
      )}
      {boxId && onBoxSettingsRequest && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxSettingsRequest(boxId);
            onClose();
          }}
        >
          <Settings2 size={15} />
          <span>{tEditor("pageMenu.boxSettings")}</span>
        </button>
      )}
      {boxId && onBoxCopy && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxCopy(boxId);
            onClose();
          }}
        >
          <Copy size={15} />
          <span>{tEditor("pageMenu.boxCopy")}</span>
        </button>
      )}
      {boxId && onBoxDelete && (
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => {
            onBoxDelete(boxId);
            onClose();
          }}
        >
          <Trash2 size={15} />
          <span>{tEditor("pageMenu.boxDelete")}</span>
        </button>
      )}
      {(selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest) || onMaterialSaveRequest ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            if (selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest) {
              onSelectionMaterialSaveRequest(selectionBlockIds);
            } else {
              onMaterialSaveRequest?.(targetBlockId);
            }
            onClose();
          }}
        >
          <PackagePlus size={15} />
          <span>{tEditor(selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest ? "pageMenu.saveSelectionAsMaterial" : "pageMenu.saveAsMaterial")}</span>
        </button>
      ) : null}
      {showInsertBreak && (
        <button type="button" role="menuitem" onClick={onInsertBreak}>
          <CornerDownRight size={15} />
          <span>{tEditor("pagination.insertBreak", { kind: breakLabel })}</span>
        </button>
      )}
      {showRemoveBreak && (
        <button type="button" role="menuitem" onClick={onRemoveBreak}>
          <CornerDownRight size={15} />
          <span>{tEditor("pagination.removeBreak", { kind: breakLabel })}</span>
        </button>
      )}
    </>
  );
}
