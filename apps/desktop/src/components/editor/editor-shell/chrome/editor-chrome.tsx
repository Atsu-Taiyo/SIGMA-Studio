// EditorShell.tsx から機械的に切り出したクローム。JSX は一切書き換えていません。
//
// **JSX を生成する関数はこの1つだけです。絶対に分割しないでください。**
// パーツを別関数・子コンポーネントに切り出すと、overlay のスタイル適用（矢印の端点・線幅）が
// 描画に反映されなくなります。実測のみで機序は未解明です（arrowhead-kinds を各6回=48テストで比較）:
//
//   base(inline) 48/48 緑 / base+ローカルconstへ退避 48/48 緑 / 単一の純関数 48/48 緑
//   分割した純関数 約7件失敗 / 単一の子コンポーネント 約9/24 失敗 / 分割+子コンポーネント 失敗
//
// つまり「1関数・1 render pass で全部作る」ことが緑の条件で、共有はサブ関数ではなく
// **ローカル const** で行います。WI-4 のリボンも同じ制約に従ってください。

import { ColorPalette } from "@/components/editor/ColorPalette";
import { DocumentTabSaveDot, SaveStatusBadge } from "@/components/editor/editor-shell/SaveStatusIndicators";
import { InlineMathDetails } from "@/components/editor/EditorSettings";
import { EDITOR_TOOLBAR_CARET_SIZE, EDITOR_TOOLBAR_ICON_SIZE, EDITOR_TOOLBAR_TEXT_ICON_SIZE, EditorToolbarColorButton, EditorToolbarGroup, EditorToolbarIconButton, EditorToolbarMenuButton, EditorToolbarSelect, EditorToolbarSeparator } from "@/components/editor/EditorToolbar";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { BOXED_TEXT_STYLE_OPTIONS, BLOCK_STYLE_OPTIONS, DEFAULT_FONT_FAMILY_VALUE, KEYBOARD_ZOOM_STEP, LINE_HEIGHT_OPTIONS, MAX_BOXED_TEXT_PADDING_Y, MIN_BOXED_TEXT_PADDING_Y, TEXT_ALIGN_OPTIONS } from "@/components/editor/editor-shell/constants";
import { BoxedTextIcon, BoxedTextStylePreview, LineEndpointMenuButton } from "@/components/editor/editor-shell/formatting-icons";
import { normalizeToolbarFontFamily } from "@/components/editor/editor-shell/toolbar-formatting";
import { degradedWatcherMessage } from "@/components/editor/editor-shell/workspace-request";
import { isLineToolCommand, isShapeMenuCommand } from "@/components/editor/overlay-canvas/shape-gallery";
import { OverlayLineDashMenuButton, OverlayLineWidthMenuButton } from "@/components/editor/overlay-line-style-menus";
import { dispatchOverlayStylePreview } from "@/components/editor/page-overlay-types";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { Inline, Inset } from "@/components/ui/layout";
// 矢印/Home/End の移動先計算は設定タブと同じ純関数を使う（実装を二重に持たない）。
// Tabs コンポーネント自体は使わない（Settings.module.css をクロームへ漏らさないため）。
import { resolveTabsKeyboardIndex } from "@/components/ui/settings/Tabs";
import { LINE_HEIGHT_STEP, MAX_LINE_HEIGHT, MIN_LINE_HEIGHT } from "@/features/document";
import { DocumentTitleText } from "@/features/rendering/adapters/react";
import type { Translate } from "@/lib/i18n";
import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/lib/overlay-image-files";
import { POWERPOINT_IMPORT_ACCEPT } from "@/lib/powerpoint-import";
import { AlertTriangle, AppWindow, ArrowDownRight, ArrowLeft, Bold, Braces, BringToFront, Building2, ChartSpline, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardCopy, ClipboardPaste, Clock3, Code, Columns3, Copy, Cuboid, Download, FileCog, FilePlus, FileQuestion, FileText, FolderOpen, Highlighter, ImageIcon, Italic, Keyboard, LayoutTemplate, Library, List, ListChevronsUpDown, ListOrdered, ListPlus, ListTree, Loader2, MessageSquare, Minus, MinusCircle, MoreHorizontal, MoveDown, MoveUp, PaintBucket, PenLine, Plus, PlusCircle, Quote, Redo2, Replace, Rows3, Search, SendToBack, SeparatorHorizontal, Sigma, SlidersHorizontal, Sparkles, Square, SquareFunction, Trash2, Type, Underline, Undo2, X } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";
import type { DesktopUpdateState } from "@/types/desktop";

import { renderDocsComposition, renderRibbonComposition } from "./chrome-composition";
import type { EditorChromeParts } from "./chrome-parts";
import type { EditorChromeValue } from "./chrome-types";
import { BACKSTAGE_SECTIONS, ribbonBackstagePanelId } from "./ribbon-backstage";
import { getVisibleRibbonTabs, ribbonTabElementId } from "./ribbon-tabs";
import type { RibbonPanelTabId } from "./ribbon-tabs";

/**
 * リボンの1グループ。Word と同じ「操作の面 + 下端の見出し」で、操作の面は
 * 左に大ボタン、右に小ボタンの段（2〜3段）という構成。
 *
 * 大きさは **スロットが決める**（`.ribbon-group-large` の中身が大きくなる）。
 * ここに並ぶ element の多くは docs のツールバーと共有していて、element 自身に
 * large を付けると docs 側の見た目まで変わってしまうため。リボンでしか使わない
 * ボタンだけは EditorToolbarIconButton の `large` を直接使ってよい。
 */
interface RibbonGroupDefinition {
  key: string;
  label: string;
  /** グループ左端の大ボタン。無いグループは小ボタンの段だけになる。 */
  large?: ReactNode;
  /** 小ボタンの段。Word は 2 段に積む。 */
  rows?: readonly ReactNode[];
  /** 右下のダイアログランチャー（↘）。対応するダイアログがあるグループにだけ付ける。 */
  launcher?: { label: string; onClick: () => void };
}

export function renderEditorChrome(chrome: EditorChromeValue) {
  const { activeDocumentOpenFailure, activeFileId, addBlock, aiMenuButtonRef, appUpdateState, closeDocumentTab, commentsPanelOpen, commitDocumentTitle, copyDocumentText, createDocumentTab, createWhiteboardDocumentTab, degradedWatcherScopes, deleteActiveDocument, documentMetadatas, documentTitle, duplicateActiveDocument, exportJson, exportMenuOpen, fileMenuButtonRef, handleTitleUpdateAction, importDocumentFile, importInputRef, insertMenuButtonRef, loadingFileId, newDocButtonRef, newDocMenuOpen, openCommandSettings, openDocumentInWorkspace, openDocumentListDialog, openDocumentTabs, openImportDialog, openNewDocMenu, openOtherImportDialog, openPrintPreview, openTextImportDialog, openVersionHistory, openWorkspaceScreen, otherImportInputRef, promoteAiToSidebar, reportIssue, requestOverlayImages, resolvedDocumentTitle, scheduleCloseNewDocMenu, setAiSettingsOpen, setDesktopSettingsOpen, setExportMenuOpen, setNewDocMenuOpen, setOutlineDialogOpen, setOverlayEditing, setPageSettingsOpen, setTemplateGalleryOpen, setTexCommandReferenceOpen, setTexEnvironmentSettingsOpen, setTitleInputFocused, settingsMenuButtonRef, showRichTitle, showTitleUpdateButton, titleInputValue, titleRichNodes, titleUpdateButtonDisabled, toggleCommentsPanel, uiLayoutPreference, updateMetadata, versionHistoryOpen } = chrome.appMenu;
  const { commandTooltip, renderMenuShortcut } = chrome.commands;
  const { setMaterialLibraryOpen } = chrome.editing;
  const { ActiveTextAlignIcon, activeFontFamilyLabel, activeTextAlignOption, activeTextFontSize, activeTextFontSizeMixed, applyBlockStructure, applyBoxedTextPaddingY, applyInlineFormat, applyLineHeight, applyTextAlign, applyTextStyle, blockStyleState, boldActive, boxedTextActive, boxedTextButtonRef, boxedTextMenuOpen, boxedTextPaddingY, boxedTextVariant, canUseBlockStructure, canUseLineHeight, canUseTextAlign, canUseTextBlockStyle, canUseTextToolbar, fontFamily, fontFamilyButtonRef, fontFamilyIsKnownOption, fontFamilyIsMixed, fontFamilyMenuOpen, fontFamilyQuery, handleLineHeightStepClick, italicActive, lineHeight, lineHeightButtonRef, lineHeightCustomOpen, lineHeightInput, lineHeightInputError, lineHeightMenuOpen, moreBlocksMenuButtonRef, moreBlocksMenuOpen, orderedListMenuButtonRef, orderedListMenuOpen, setMoreBlocksMenuOpen, setOrderedListMenuOpen, saveEditorFontFamilyPreference, selectBoxedTextVariant, selectedTextAlign, selectedTextStyle, setFontFamily, setFontFamilyQuery, setLineHeightCustomOpen, setLineHeightInput, setLineHeightInputError, setTextBackgroundColor, setTextColor, setTextFontSize, startLineHeightStepping, stopLineHeightStepping, textAlignButtonRef, textAlignMenuOpen, textBackgroundColor, textBackgroundColorButtonRef, textColor, textColorButtonRef, toggleBoxedText, underlineActive, visibleCustomFontOptions, visibleFontFamilyGroups, blockStyleButtonRef, blockStyleMenuOpen, fontSizeInputRef, fontSizeInput, setFontSizeInput } = chrome.format;
  const { ActiveLineToolIcon, activeLineToolItem, activeOverlayTool, bodyToolbarLockedByAi, cancelInlineMathMenuClose, inlineMathButtonRef, inlineMathMenuOpen, lineToolMenuButtonRef, lineToolMenuOpen, openInlineMathMenu, scheduleInlineMathMenuClose, selectedInlineMath, selectedInlineMathDetails, setInlineMathMenuOpen, shapeMenuButtonRef, shapeMenuOpen, startInlineMathFromToolbar } = chrome.insert;
  const { findNext, findPrevious, overlayEditing, replaceAll, replaceNext, replaceOpen, replaceText, searchButtonRef, searchMatchCount, searchOpen, searchQuery, setReplaceOpen, setReplaceText, setSearchOpen, setSearchQuery } = chrome.search;
  const { applyOverlayStyle, arrangeOverlayShapes, canArrangeOverlayShapes, canUseFillStyleControls, canUseLineEndpointControls, canUseLineStyleControls, canUseStrokeStyleControls, effectiveLineDashMenuOpen, effectiveLineEndpointMenu, effectiveLineWidthMenuOpen, fillColorButtonRef, fillColorPatch, lineDashButtonRef, lineWidthButtonRef, overlaySelection, selectedOverlayLineDash, selectedOverlayLineSize, selectionFill, selectionFillColor, selectionFillOpacity, setStrokeColor, strokeColor, strokeColorButtonRef } = chrome.shapeStyle;
  const { activeMenu, aiDocumentWriteInProgress, colorStylePanel, document, getActiveTextTarget, imageInputRef, insertInlineMath, isDesktopApp, isEmbedded, runEditCommand, runOverlayCommand, setStatusMessage, shapeGallerySections, lineToolItems, t, toggleMenu, versionHistoryPreviewActive } = chrome.shared;
  const { setActiveMenu, setBoxedTextMenuOpen, setColorStylePanel, setFontFamilyMenuOpen, setBlockStyleMenuOpen, setLineDashMenuOpen, setLineEndpointMenu, setLineHeightMenuOpen, setLineToolMenuOpen, setLineWidthMenuOpen, setShapeMenuOpen, setTextAlignMenuOpen } = chrome.toolbarMenus;
  const { activePageNumber, applyZoom, pageCount, zoom, zoomOptions } = chrome.view;
  const { applyColumnCommand, backstage, closeBackstage, columnCommand, contextualTabVisible, ribbonCollapse, ribbonIdPrefix, ribbonTabState, selectBackstageSection, selectRibbonTab, toggleBackstage, toggleRibbonCollapse } = chrome.ribbon;

  // word を離れているのに state だけ open が残っていても、ここで必ず閉じた扱いにする。
  // タイトル行・タブ行のコマンドはこれで消すので、Backstage 用の const より前に置く。
  const backstageOpen = uiLayoutPreference.mode === "word" && backstage.open;
  // 折りたたみ中は本体を作らない。タブを押して «浮かせて» いる間だけ作る。
  const ribbonBodyHidden = ribbonCollapse.collapsed && !ribbonCollapse.overlayOpen;

  const documentIcon = (
    <div className="document-icon" aria-hidden="true">
      <span>Σ</span>
      <span>Studio</span>
    </div>
  );

  const documentTitleRow = (
    <div className="document-title-row" inert={versionHistoryPreviewActive || undefined}>
      {/* 入力欄は常時マウントしたまま、非フォーカス時だけリッチ表示を重ねる。
          フォーカスの有無で要素を差し替えると getByLabel("教材タイトル") を使う
          既存の操作 (値の検証・フォーカス・入力) と IME 変換が一斉に壊れる。 */}
      <div className="document-title-field" data-rich={showRichTitle ? "true" : undefined}>
        <input
          className="document-title-input"
          aria-label={t("title.input")}
          disabled={aiDocumentWriteInProgress || activeDocumentOpenFailure !== null}
          value={titleInputValue}
          placeholder={resolvedDocumentTitle}
          title={resolvedDocumentTitle}
          onChange={(event) =>
            updateMetadata({
              ...document.metadata,
              title: event.target.value,
            })
          }
          onFocus={(event) => {
            setTitleInputFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setTitleInputFocused(false);
            void commitDocumentTitle();
          }}
        />
        {showRichTitle && (
          <span className="document-title-rich-overlay" aria-hidden="true">
            <DocumentTitleText title={titleInputValue} nodes={titleRichNodes} />
          </span>
        )}
      </div>
      {showTitleUpdateButton && (
        <button
          type="button"
          className="title-update-button"
          title={getTitleUpdateButtonTitle(appUpdateState, t)}
          aria-label={getTitleUpdateButtonTitle(appUpdateState, t)}
          disabled={titleUpdateButtonDisabled}
          onClick={() => void handleTitleUpdateAction()}
        >
          <Download size={13} />
          <span>{getTitleUpdateButtonLabel(appUpdateState, t)}</span>
        </button>
      )}
    </div>
  );

  const fileMenu = (
    <div className="app-menu-anchor">
      <button ref={fileMenuButtonRef} type="button" className={`app-menu-button ${activeMenu === "file" ? "active" : ""}`} aria-haspopup="menu" aria-expanded={activeMenu === "file"} onClick={() => toggleMenu("file")}>
        {t("appMenu.file.label")}
      </button>
      <ToolbarPopover
        open={activeMenu === "file"}
        anchorRef={fileMenuButtonRef}
        onClose={() => {
          setActiveMenu(null);
          setExportMenuOpen(false);
        }}
        className="app-menu"
        role="menu"
        ariaLabel={t("appMenu.file.label")}
        gap={3}
      >
          <button type="button" role="menuitem" disabled={isEmbedded} onClick={duplicateActiveDocument}>
            <Copy size={16} />
            <span>{t("appMenu.file.duplicate")}</span>
          </button>
          <button type="button" role="menuitem" disabled={isEmbedded || documentMetadatas.length <= 1} onClick={() => void deleteActiveDocument()}>
            <Trash2 size={16} />
            <span>{t("appMenu.file.delete")}</span>
          </button>
          <button type="button" role="menuitem" onClick={openImportDialog}>
            <FolderOpen size={16} />
            <span>{t("appMenu.file.import")}</span>
          </button>
          {<button type="button" role="menuitem" onClick={openOtherImportDialog}>
            <FolderOpen size={16} />
            <span>{t("appMenu.file.importOther")}</span>
          </button>}
          <button type="button" role="menuitem" onClick={openTextImportDialog}>
            <ClipboardPaste size={16} />
            <span>{t("appMenu.file.importText")}</span>
          </button>
          <div
            className={`app-menu-submenu ${exportMenuOpen ? "open" : ""}`}
            role="none"
            onMouseEnter={() => setExportMenuOpen(true)}
            onMouseLeave={() => setExportMenuOpen(false)}
            onFocus={() => setExportMenuOpen(true)}
            onBlur={(event) => {
              const nextFocus = event.relatedTarget as Node | null;
              if (!nextFocus || !event.currentTarget.contains(nextFocus)) {
                setExportMenuOpen(false);
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="app-menu-submenu-trigger"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((current) => !current)}
            >
              <Download size={16} />
              <span>{t("appMenu.file.export")}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            <div className="app-menu-submenu-panel" role="menu" aria-label={t("appMenu.file.export")}>
              <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setExportMenuOpen(false); void exportJson(); }}>
                <Download size={16} />
                <span>{t("appMenu.file.exportJson")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setExportMenuOpen(false); openPrintPreview(); }}>
                <Download size={16} />
                <span>{t("appMenu.file.exportPdf")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setExportMenuOpen(false); void copyDocumentText(); }}>
                <ClipboardCopy size={16} />
                <span>{t("appMenu.file.copyText")}</span>
              </button>
            </div>
          </div>
      </ToolbarPopover>
    </div>
  );

  const insertMenu = (
    <div className="app-menu-anchor">
      <button ref={insertMenuButtonRef} type="button" className={`app-menu-button ${activeMenu === "insert" ? "active" : ""}`} aria-haspopup="menu" aria-expanded={activeMenu === "insert"} onClick={() => toggleMenu("insert")}>
        {t("appMenu.insert.label")}
      </button>
      <ToolbarPopover
        open={activeMenu === "insert"}
        anchorRef={insertMenuButtonRef}
        onClose={() => setActiveMenu(null)}
        className="app-menu"
        role="menu"
        ariaLabel={t("appMenu.insert.label")}
        gap={3}
      >
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); addBlock("paragraph"); }}>
            <FileText size={16} />
            <span>{t("appMenu.insert.paragraph")}</span>
            {renderMenuShortcut("insert.paragraph")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); addBlock("heading"); }}>
            <ListPlus size={16} />
            <span>{t("appMenu.insert.heading")}</span>
            {renderMenuShortcut("insert.heading")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); addBlock("problem"); }}>
            <FileQuestion size={16} />
            <span>{t("appMenu.insert.problem")}</span>
            {renderMenuShortcut("insert.problem")}
          </button>
          <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { setActiveMenu(null); insertInlineMath("", getActiveTextTarget()); setStatusMessage(t("insert.math.added")); }}>
            <Sigma size={16} />
            <span>{t("appMenu.insert.math")}</span>
            {renderMenuShortcut("insert.inlineMath")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); runOverlayCommand("graph"); }}>
            <ChartSpline size={16} />
            <span>{t("appMenu.insert.graph")}</span>
            {renderMenuShortcut("overlay.graph")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); runOverlayCommand("graph3d"); }}>
            <Cuboid size={16} />
            <span>{t("appMenu.insert.graph3d")}</span>
            {renderMenuShortcut("overlay.graph3d")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); imageInputRef.current?.click(); }}>
            <ImageIcon size={16} />
            <span>{t("appMenu.insert.image")}</span>
            {renderMenuShortcut("overlay.image")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setOverlayEditing(true); setLineToolMenuOpen(false); setShapeMenuOpen(true); }}>
            <Square size={16} />
            <span>{t("appMenu.insert.shape")}</span>
          </button>
      </ToolbarPopover>
    </div>
  );

  const aiMenu = (
    // Web版のAI面はキャンバス左上のAiTaskDock一本 (チャットもAI設定も無い)。
    // メニューを残すと空のパネルを開ける経路になるので、まるごと出さない。
    !isEmbedded && isDesktopApp && (
      <div className="app-menu-anchor">
        <button ref={aiMenuButtonRef} type="button" className={`app-menu-button ${activeMenu === "ai" ? "active" : ""}`} aria-haspopup="menu" aria-expanded={activeMenu === "ai"} onClick={() => toggleMenu("ai")}>
          {t("appMenu.ai.label")}
        </button>
        <ToolbarPopover
          open={activeMenu === "ai"}
          anchorRef={aiMenuButtonRef}
          onClose={() => setActiveMenu(null)}
          className="app-menu"
          role="menu"
          ariaLabel={t("appMenu.ai.label")}
          gap={3}
        >
            <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); promoteAiToSidebar(); }}>
              <Sparkles size={16} />
              <span>{t("appMenu.ai.openChat")}</span>
            </button>
            {/* AIタスクの状態は常時表示のcanvas左上アイコン (AiTaskDock) に一本化した
                ので、ここに専用の開閉メニュー項目は不要 (旧: 開閉トグル)。 */}
            <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setAiSettingsOpen(true); }}>
              <SlidersHorizontal size={16} />
              <span>{t("appMenu.ai.settings")}</span>
            </button>
        </ToolbarPopover>
      </div>
    )
  );

  const settingsMenu = (
    <div className="app-menu-anchor">
      <button ref={settingsMenuButtonRef} type="button" className={`app-menu-button ${activeMenu === "settings" ? "active" : ""}`} aria-haspopup="menu" aria-expanded={activeMenu === "settings"} onClick={() => toggleMenu("settings")}>
        {t("appMenu.settings.label")}
      </button>
      <ToolbarPopover
        open={activeMenu === "settings"}
        anchorRef={settingsMenuButtonRef}
        onClose={() => setActiveMenu(null)}
        className="app-menu"
        role="menu"
        ariaLabel={t("appMenu.settings.label")}
        gap={3}
      >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={commentsPanelOpen}
            onClick={() => {
              setActiveMenu(null);
              toggleCommentsPanel();
            }}
          >
            {commentsPanelOpen ? <Check size={16} /> : <span aria-hidden="true" />}
            <span>{t("appMenu.settings.comments")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setOutlineDialogOpen(true); }}>
            <ListTree size={16} />
            <span>{t("appMenu.settings.outline")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); openCommandSettings(); }}>
            <Keyboard size={16} />
            <span>{t("appMenu.settings.shortcuts")}</span>
            {renderMenuShortcut("settings.commands")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setTexCommandReferenceOpen(true); }}>
            <SquareFunction size={16} />
            <span>{t("appMenu.settings.texReference")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setTexEnvironmentSettingsOpen(true); }}>
            <Braces size={16} />
            <span>{t("appMenu.settings.texEnvironment")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setPageSettingsOpen(true); }}>
            <FileCog size={16} />
            <span>{t("appMenu.settings.pageSettings")}</span>
            {renderMenuShortcut("settings.page")}
          </button>
          {!isEmbedded && (
            <button type="button" role="menuitem" onClick={() => { setActiveMenu(null); setDesktopSettingsOpen(true); }}>
              <AppWindow size={16} />
              <span>{t("appMenu.settings.appSettings")}</span>
            </button>
          )}
      </ToolbarPopover>
    </div>
  );

  const documentTabsRow = (
    <div className="document-tabs-row" aria-label={t("tabs.region")}>
      <div className="document-tabs-scroll" role="tablist" aria-label={t("tabs.list")}>
        {openDocumentTabs.map((tab) => {
          const active = tab.fileId === activeFileId;
          return (
            <div className={`document-tab ${active ? "active" : ""}`} key={tab.fileId}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="document-tab-main"
                title={tab.title}
                // タイトルの数式は KaTeX の HTML になり読み上げられないので、
                // タブのアクセシブル名は生の文字列で固定する。
                aria-label={tab.title}
                onClick={() => {
                  if (tab.fileId !== activeFileId) {
                    void openDocumentInWorkspace(tab.fileId);
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    void closeDocumentTab(tab.fileId);
                  }
                }}
              >
                {loadingFileId === tab.fileId
                  ? <Loader2 className="document-tab-loading" size={14} />
                  : <FileText size={14} />}
                {/* 開いていない教材のタイトルは台帳の文字列しか無いので従来どおり
                    文字列パスで描く。アクティブなタブだけ導出したノード列を渡す。 */}
                <span><DocumentTitleText title={tab.title} nodes={active ? documentTitle.nodes : undefined} /></span>
                {active && <DocumentTabSaveDot />}
              </button>
              <button
                type="button"
                className="document-tab-close"
                title={t("tabs.close")}
                aria-label={t("tabs.closeNamed", { title: tab.title })}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeDocumentTab(tab.fileId);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const saveStateBadge = (
    <div className="save-state-wrap" aria-live="polite">
      {degradedWatcherScopes.length > 0 && (
        <div
          className="watcher-degraded-status"
          role="status"
          title={degradedWatcherMessage(degradedWatcherScopes)}
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{degradedWatcherMessage(degradedWatcherScopes)}</span>
        </div>
      )}
      {/* 保存状態と状況メッセージは **この葉だけが購読する** (`SaveStatusIndicators`)。
          リボンや EditorShell 本体で受け取ると、打鍵のたびに動く値で画面全体が再描画される。 */}
      <SaveStatusBadge />
    </div>
  );

  const reportIssueButton = (
    <button
      type="button"
      className="report-issue-button"
      title={t("actions.reportIssueTooltip")}
      aria-label={t("actions.reportIssue")}
      onClick={reportIssue}
    >
      <FileQuestion size={15} />
      <span>{t("actions.reportIssue")}</span>
    </button>
  );

  const versionHistoryButton = isEmbedded ? null : (
    <button
      type="button"
      className="version-history-button"
      title={t("versionHistory.title")}
      aria-label={t("versionHistory.title")}
      aria-pressed={versionHistoryOpen}
      onClick={openVersionHistory}
    >
      <Clock3 size={15} aria-hidden="true" />
      <span>{t("versionHistory.title")}</span>
    </button>
  );

  const menubarRightActions = (
    <div className="menubar-right-actions">
      {!isEmbedded && (
        <button
          type="button"
          className="workspace-open-button"
          title={t("actions.workspace")}
          aria-label={t("actions.workspace")}
          onClick={() => void openWorkspaceScreen()}
        >
          <Building2 size={15} />
          <span>{t("actions.workspace")}</span>
        </button>
      )}

      <div className="document-tab-actions" aria-label={t("tabs.actions")}>
        <div
          className="document-tab-action-hover"
          onMouseEnter={isEmbedded ? undefined : openNewDocMenu}
          onMouseLeave={isEmbedded ? undefined : scheduleCloseNewDocMenu}
        >
          <button
            ref={newDocButtonRef}
            type="button"
            className="document-tab-action"
            title={t("tabs.newDocument")}
            aria-label={t("tabs.newDocument")}
            aria-haspopup="menu"
            aria-expanded={newDocMenuOpen}
            disabled={isEmbedded}
            onClick={() => void createDocumentTab()}
          >
            <FilePlus size={15} />
          </button>
          <ToolbarPopover
            open={!isEmbedded && newDocMenuOpen}
            anchorRef={newDocButtonRef}
            onClose={() => setNewDocMenuOpen(false)}
            align="right"
            className="app-menu new-doc-menu"
            role="menu"
            ariaLabel={t("tabs.newDocument")}
            gap={4}
          >
            <div
              className="new-doc-menu-body"
              onMouseEnter={openNewDocMenu}
              onMouseLeave={scheduleCloseNewDocMenu}
            >
              <button type="button" role="menuitem" onClick={() => { setNewDocMenuOpen(false); void createDocumentTab(); }}>
                <FilePlus size={15} />
                <span>{t("tabs.newBlank")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setNewDocMenuOpen(false); void createWhiteboardDocumentTab(); }}>
                <Square size={15} />
                <span>{t("tabs.newWhiteboard")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setNewDocMenuOpen(false); setTemplateGalleryOpen(true); }}>
                <LayoutTemplate size={15} />
                <span>{t("tabs.newFromTemplate")}</span>
              </button>
            </div>
          </ToolbarPopover>
        </div>
        <Tooltip {...commandTooltip(t("tabs.libraryTooltip"), "document.library")}>
          <button type="button" className="document-tab-action" title={t("tabs.library")} aria-label={t("tabs.library")} disabled={isEmbedded} onClick={() => void openDocumentListDialog()}>
            <Library size={15} />
          </button>
        </Tooltip>
      </div>
    </div>
  );

  const undoButton = (
      <EditorToolbarIconButton disabled={aiDocumentWriteInProgress} tooltip={commandTooltip(t("toolbar.undoTooltip"), "edit.undo")} aria-label={t("toolbar.undo")} onClick={() => runEditCommand("undo")}>
        <Undo2 size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  const redoButton = (
      <EditorToolbarIconButton disabled={aiDocumentWriteInProgress} tooltip={commandTooltip(t("toolbar.redoTooltip"), "edit.redo")} aria-label={t("toolbar.redo")} onClick={() => runEditCommand("redo")}>
        <Redo2 size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  // ---------------------------------------------------------------------------
  // Word風のタイトル行 (QAT + 右端の常設アクション) とタブ行右端のアクション
  //
  // Word 365 のタイトルバーは 左端アイコン → クイックアクセスツールバー →
  // 中央に文書名 → 右端の常設アクション、という並び。undo / redo / 保存状態は
  // **docs と同じ element をそのまま置き直す** (新しいボタンを作らない)。
  // ---------------------------------------------------------------------------

  // コメント表示と AIチャットは Word のタブ行右端 (コメント / 共有) と
  // リボン本体 (表示タブ / ホームタブ) の両方に出る。element を1つだけ作って
  // 両方から参照する — 分割せず「共有はローカル const」で行うのが本ファイルの規約。
  const commentsToggleButton = (
      <EditorToolbarIconButton
        withText
        active={commentsPanelOpen}
        title={t("actions.comments")}
        aria-label={t("actions.comments")}
        aria-pressed={commentsPanelOpen}
        onClick={toggleCommentsPanel}
      >
        <MessageSquare size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
        <span>{t("actions.commentsShort")}</span>
      </EditorToolbarIconButton>
  );

  // ホームタブの AI グループに置く大ボタン。タブ行右端の小さい方 (aiChatButton) とは
  // 別 element にする — 同じ element を大小で使い分けることはできないし、こちらは
  // リボン専用なので large を直接付けてよい。
  const aiChatLargeButton = (
      <EditorToolbarIconButton large title={t("actions.aiChat")} aria-label={t("actions.aiChat")} onClick={() => promoteAiToSidebar()}>
        <Sparkles size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
        <span>{t("actions.aiChatShort")}</span>
      </EditorToolbarIconButton>
  );

  const aiChatButton = (
      <EditorToolbarIconButton withText title={t("actions.aiChat")} aria-label={t("actions.aiChat")} onClick={() => promoteAiToSidebar()}>
        <Sparkles size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
        <span>{t("actions.aiChatShort")}</span>
      </EditorToolbarIconButton>
  );

  // Backstage が本文を覆っている間は、タイトル行・タブ行のコマンドを出さない。
  // 出したままだと「見えていない本文」に undo / コメント / AIチャットが効いてしまい、
  // WI-1 で決めた「Backstage 中は本文へ届かせない」という規約とも食い違う。
  // タブそのもの (ファイル / ホーム …) は残すので、閉じる導線は失わない。
  const ribbonQat = uiLayoutPreference.mode !== "word" || backstageOpen ? null : (
    // 保存状態バッジは docs と同じ .save-state-wrap をそのまま入れ子にしている。
    // 入れ子にすると .menubar-row の grid item ではなくなり grid-column:4 が失効し
    // flex: 0 1 260px だけが残るので、ribbon-chrome.css 側で打ち消している。
    <div className="ribbon-qat" inert={versionHistoryPreviewActive || undefined}>
      {saveStateBadge}
      {undoButton}
      {redoButton}
    </div>
  );

  const ribbonTitlebarActions = uiLayoutPreference.mode !== "word" || backstageOpen ? null : (
    // docs ではタイトル行に常設だったワークスペース導線をここへ戻す。
    // 出し分けは docs 側 menubarRightActions と同じ !isEmbedded。
    <div className="ribbon-titlebar-actions">
      {versionHistoryButton}
      {!isEmbedded && (
        <button
          type="button"
          className="workspace-open-button"
          title={t("actions.workspace")}
          aria-label={t("actions.workspace")}
          onClick={() => void openWorkspaceScreen()}
        >
          <Building2 size={15} />
          <span>{t("actions.workspace")}</span>
        </button>
      )}
    </div>
  );

  const ribbonTabActions = uiLayoutPreference.mode !== "word" || backstageOpen ? null : (
    <div className="ribbon-tab-actions">
      {commentsToggleButton}
      {!isEmbedded && aiChatButton}
    </div>
  );

  const materialButton = (
      <EditorToolbarIconButton withText title={t("actions.materials")} aria-label={t("actions.materials")} onClick={() => setMaterialLibraryOpen(true)}>
        <Library size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
        <span>{t("actions.materials")}</span>
      </EditorToolbarIconButton>
  );

  const editingGroup = (
    <EditorToolbarGroup ariaLabel={t("toolbar.group.editing")}>
      {undoButton}
      {redoButton}
      {materialButton}
    </EditorToolbarGroup>
  );

  const blockStyleLabel = selectedTextStyle === "h1" || selectedTextStyle === "h2" || selectedTextStyle === "h3" || selectedTextStyle === "paragraph"
    ? t(`format.blockStyle.${selectedTextStyle}`)
    : t("format.blockStyle.placeholder");
  const paragraphStyleSelect = (
          <div className="shape-menu-anchor">
            <button
              ref={blockStyleButtonRef}
              type="button"
              className="toolbar-font-select block-style"
              title={blockStyleLabel}
              aria-label={t("format.blockStyle.aria")}
              aria-haspopup="menu"
              aria-expanded={blockStyleMenuOpen && canUseTextBlockStyle}
              disabled={!canUseTextBlockStyle}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const nextOpen = !blockStyleMenuOpen;
                setShapeMenuOpen(false);
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setLineWidthMenuOpen(false);
                setColorStylePanel(null);
                setLineEndpointMenu(null);
                setFontFamilyMenuOpen(false);
                setBlockStyleMenuOpen(nextOpen);
              }}
            >
              <span className="toolbar-font-select-label">{blockStyleLabel}</span>
              <ChevronDown className="toolbar-font-select-caret" size={EDITOR_TOOLBAR_CARET_SIZE} aria-hidden="true" />
            </button>
            <ToolbarPopover
              open={blockStyleMenuOpen && canUseTextBlockStyle}
              anchorRef={blockStyleButtonRef}
              onClose={() => setBlockStyleMenuOpen(false)}
              className="shape-menu font-family-menu"
              role="menu"
              ariaLabel={t("format.blockStyle.aria")}
            >
              {BLOCK_STYLE_OPTIONS.map((value) => {
                const optionLabel = t(`format.blockStyle.${value}`);
                return (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedTextStyle === value}
                    className={selectedTextStyle === value ? "active" : undefined}
                    title={optionLabel}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      applyTextStyle(value);
                      setBlockStyleMenuOpen(false);
                    }}
                  >
                    <span className="font-family-menu-option-label">{optionLabel}</span>
                    {selectedTextStyle === value ? (
                      <Check size={14} className="font-family-menu-check" />
                    ) : (
                      <span className="font-family-menu-check" aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </ToolbarPopover>
          </div>
  );

  const fontFamilyControl = (
          <div className="shape-menu-anchor">
            <button
              ref={fontFamilyButtonRef}
              type="button"
              className="toolbar-font-select"
              title={activeFontFamilyLabel}
              style={{ fontFamily }}
              aria-label={fontFamilyIsMixed ? t("format.font.mixed") : t("format.font.current", { name: activeFontFamilyLabel })}
              aria-haspopup="menu"
              aria-expanded={fontFamilyMenuOpen && canUseTextToolbar}
              disabled={!canUseTextToolbar}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setShapeMenuOpen(false);
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setLineWidthMenuOpen(false);
                setColorStylePanel(null);
                setLineEndpointMenu(null);
                setBlockStyleMenuOpen(false);
                if (!fontFamilyMenuOpen) {
                  setFontFamilyQuery("");
                }
                setFontFamilyMenuOpen((current) => !current);
              }}
            >
              <span className="toolbar-font-select-label">{activeFontFamilyLabel}</span>
              <ChevronDown className="toolbar-font-select-caret" size={EDITOR_TOOLBAR_CARET_SIZE} aria-hidden="true" />
            </button>
            <ToolbarPopover
              open={fontFamilyMenuOpen && canUseTextToolbar}
              anchorRef={fontFamilyButtonRef}
              onClose={() => {
                setFontFamilyMenuOpen(false);
                setFontFamilyQuery("");
              }}
              className="shape-menu font-family-menu"
              role="menu"
              ariaLabel={t("format.font.aria")}
            >
              <label className="font-family-menu-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={fontFamilyQuery}
                  aria-label={t("format.font.search")}
                  placeholder={t("format.font.search")}
                  data-popover-initial-focus=""
                  onChange={(event) => setFontFamilyQuery(event.target.value)}
                />
              </label>
              {!fontFamilyIsKnownOption ? (
                <div className="font-family-menu-group" role="group" aria-label={t("format.font.currentGroup")}>
                  <div className="font-family-menu-group-label">{t("format.font.currentGroup")}</div>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked="true"
                    className="active"
                    title={activeFontFamilyLabel}
                    style={{ fontFamily }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setFontFamilyMenuOpen(false)}
                  >
                    <span className="font-family-menu-option-label">{activeFontFamilyLabel}</span>
                    <Check size={14} className="font-family-menu-check" />
                  </button>
                </div>
              ) : null}
              {visibleFontFamilyGroups.map((group) => (
                <div className="font-family-menu-group" role="group" aria-label={t(`format.font.group.${group.id}`)} key={group.id}>
                  <div className="font-family-menu-group-label">{t(`format.font.group.${group.id}`)}</div>
                  {group.options.map((item) => (
                    <button
                      key={`${group.id}-${item.value}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={fontFamily === item.value}
                      className={fontFamily === item.value ? "active" : undefined}
                      title={item.label}
                      style={{ fontFamily: item.value }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        const nextFontFamily = normalizeToolbarFontFamily(item.value);
                        setFontFamily(nextFontFamily);
                        saveEditorFontFamilyPreference(nextFontFamily);
                        applyInlineFormat("fontFamily", item.value === DEFAULT_FONT_FAMILY_VALUE ? "" : item.value);
                        setFontFamilyMenuOpen(false);
                      }}
                    >
                      <span className="font-family-menu-option-label">{item.label}</span>
                      {fontFamily === item.value ? (
                        <Check size={14} className="font-family-menu-check" />
                      ) : (
                        <span className="font-family-menu-check" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              ))}
              {visibleCustomFontOptions.length > 0 && (
                <div className="font-family-menu-group" role="group" aria-label={t("format.font.customGroup")}>
                  <div className="font-family-menu-group-label">{t("format.font.customGroup")}</div>
                  {visibleCustomFontOptions.map((item) => (
                    <button
                      key={`custom-${item.value}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={fontFamily === item.value}
                      className={fontFamily === item.value ? "active" : undefined}
                      title={item.label}
                      style={{ fontFamily: item.value }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        const nextFontFamily = normalizeToolbarFontFamily(item.value);
                        setFontFamily(nextFontFamily);
                        saveEditorFontFamilyPreference(nextFontFamily);
                        applyInlineFormat("fontFamily", item.value);
                        setFontFamilyMenuOpen(false);
                      }}
                    >
                      <span className="font-family-menu-option-label">{item.label}</span>
                      {fontFamily === item.value ? (
                        <Check size={14} className="font-family-menu-check" />
                      ) : (
                        <span className="font-family-menu-check" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {visibleFontFamilyGroups.length === 0 && visibleCustomFontOptions.length === 0 && (
                <p className="font-family-menu-empty">{t("format.font.empty")}</p>
              )}
            </ToolbarPopover>
          </div>
  );

  const commitFontSizeInput = (value: string) => {
    const parsedSize = Number(value);
    if (!value.trim() || !Number.isFinite(parsedSize) || parsedSize <= 0) {
      setFontSizeInput(String(activeTextFontSize));
      return;
    }
    const size = Math.round(parsedSize * 1000) / 1000;
    setTextFontSize(size);
    setFontSizeInput(String(size));
    applyInlineFormat("fontSize", String(size));
  };

  const adjustFontSize = (delta: number) => {
    const parsedInput = Number(fontSizeInput);
    const baseSize = fontSizeInput.trim() && Number.isFinite(parsedInput) && parsedInput > 0
      ? parsedInput
      : activeTextFontSize;
    const size = Math.max(0.1, Math.round((baseSize + delta) * 1000) / 1000);
    setTextFontSize(size);
    setFontSizeInput(String(size));
    applyInlineFormat("fontSize", String(size));
  };

  const fontSizeSelect = (
    <div
      className="toolbar-font-size-control"
      title={activeTextFontSizeMixed ? t("format.fontSize.mixedHelp") : `${activeTextFontSize}pt`}
    >
      <button
        type="button"
        className="toolbar-font-size-step"
        aria-label={t("format.fontSize.decrease")}
        title={t("format.fontSize.decrease")}
        disabled={!canUseTextToolbar}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => adjustFontSize(-1)}
      >
        <Minus size={12} aria-hidden="true" />
      </button>
      <input
        ref={fontSizeInputRef}
        className="toolbar-font-size-input"
        aria-label={t("format.fontSize.aria")}
        disabled={!canUseTextToolbar}
        type="text"
        inputMode="decimal"
        value={fontSizeInput}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setFontSizeInput(event.currentTarget.value)}
        onBlur={(event) => commitFontSizeInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            if (event.nativeEvent.isComposing) {
              event.preventDefault();
              return;
            }
            event.preventDefault();
            commitFontSizeInput(event.currentTarget.value);
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setFontSizeInput(String(activeTextFontSize));
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="toolbar-font-size-step"
        aria-label={t("format.fontSize.increase")}
        title={t("format.fontSize.increase")}
        disabled={!canUseTextToolbar}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => adjustFontSize(1)}
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </div>
  );

  const boldButton = (
          <EditorToolbarIconButton
            active={canUseTextToolbar && boldActive}
            tooltip={commandTooltip(boldActive ? t("format.bold.remove") : t("format.bold.apply"), "edit.bold")}
            aria-label={t("format.bold.label")}
            aria-pressed={canUseTextToolbar && boldActive}
            disabled={!canUseTextToolbar}
            onClick={() => runEditCommand("bold")}
          >
            <Bold size={EDITOR_TOOLBAR_ICON_SIZE} />
          </EditorToolbarIconButton>
  );

  const italicButton = (
          <EditorToolbarIconButton
            active={canUseTextToolbar && italicActive}
            tooltip={commandTooltip(italicActive ? t("format.italic.remove") : t("format.italic.apply"), "edit.italic")}
            aria-label={t("format.italic.label")}
            aria-pressed={canUseTextToolbar && italicActive}
            disabled={!canUseTextToolbar}
            onClick={() => runEditCommand("italic")}
          >
            <Italic size={EDITOR_TOOLBAR_ICON_SIZE} />
          </EditorToolbarIconButton>
  );

  const underlineButton = (
          <EditorToolbarIconButton
            active={canUseTextToolbar && underlineActive}
            tooltip={commandTooltip(underlineActive ? t("format.underline.remove") : t("format.underline.apply"), "edit.underline")}
            aria-label={t("format.underline.label")}
            aria-pressed={canUseTextToolbar && underlineActive}
            disabled={!canUseTextToolbar}
            onClick={() => runEditCommand("underline")}
          >
            <Underline size={EDITOR_TOOLBAR_ICON_SIZE} />
          </EditorToolbarIconButton>
  );

  const boxedTextControl = (
          <div className="shape-menu-anchor boxed-text-toolbar-control">
            <EditorToolbarIconButton
              className="boxed-text-toggle-button"
              active={canUseTextToolbar && boxedTextActive}
              tooltip={commandTooltip(boxedTextActive ? t("format.boxedText.removeTooltip") : t("format.boxedText.applyTooltip"), "edit.boxedText")}
              aria-label={boxedTextActive ? t("format.boxedText.remove") : t("format.boxedText.apply")}
              aria-pressed={boxedTextActive}
              disabled={!canUseTextToolbar}
              onClick={toggleBoxedText}
            >
              <BoxedTextIcon />
            </EditorToolbarIconButton>
            <EditorToolbarMenuButton
              buttonRef={boxedTextButtonRef}
              variant="boxedText"
              className="boxed-text-menu-trigger"
              active={boxedTextMenuOpen && canUseTextToolbar}
              activeFormat={canUseTextToolbar && boxedTextActive}
              title={t("format.boxedText.settings", { padding: boxedTextPaddingY })}
              aria-label={t("format.boxedText.settings", { padding: boxedTextPaddingY })}
              aria-haspopup="dialog"
              aria-expanded={boxedTextMenuOpen && canUseTextToolbar}
              disabled={!canUseTextToolbar}
              onClick={() => {
                setShapeMenuOpen(false);
                setLineToolMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel(null);
                setLineEndpointMenu(null);
                setBlockStyleMenuOpen(false);
                setBoxedTextMenuOpen((current) => !current);
              }}
            >
              <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
            </EditorToolbarMenuButton>
            <ToolbarPopover
              open={boxedTextMenuOpen && canUseTextToolbar}
              anchorRef={boxedTextButtonRef}
              onClose={() => setBoxedTextMenuOpen(false)}
              className="shape-menu boxed-text-menu"
              role="dialog"
              ariaLabel={t("format.boxedText.menu")}
            >
              <div className="boxed-text-style-options" role="group" aria-label={t("format.boxedText.styles")}>
                {BOXED_TEXT_STYLE_OPTIONS.map((option) => {
                  const optionLabel = t(`format.boxedText.variant.${option.variant}`);
                  const optionSelected = boxedTextVariant === option.variant;
                  const optionApplied = boxedTextActive && optionSelected;
                  return (
                    <button
                      key={option.variant}
                      type="button"
                      className={`boxed-text-style-option ${optionSelected ? "selected" : ""} ${optionApplied ? "applied" : ""}`}
                      disabled={!canUseTextToolbar}
                      aria-pressed={optionApplied}
                      title={optionLabel}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        selectBoxedTextVariant(option.variant);
                      }}
                    >
                      <BoxedTextStylePreview variant={option.variant} />
                      <span>{optionLabel}</span>
                    </button>
                  );
                })}
              </div>
              <div className="boxed-text-padding-stepper">
                <span className="boxed-text-padding-label">{t("format.boxedText.padding")}</span>
                <button
                  type="button"
                  title={t("format.boxedText.paddingDecrease")}
                  aria-label={t("format.boxedText.paddingDecrease")}
                  disabled={!canUseTextToolbar || boxedTextPaddingY <= MIN_BOXED_TEXT_PADDING_Y}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    applyBoxedTextPaddingY(boxedTextPaddingY - 1);
                  }}
                >
                  <Minus size={14} />
                </button>
                <output aria-live="polite">{boxedTextPaddingY}px</output>
                <button
                  type="button"
                  title={t("format.boxedText.paddingIncrease")}
                  aria-label={t("format.boxedText.paddingIncrease")}
                  disabled={!canUseTextToolbar || boxedTextPaddingY >= MAX_BOXED_TEXT_PADDING_Y}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    applyBoxedTextPaddingY(boxedTextPaddingY + 1);
                  }}
                >
                  <PlusCircle size={14} />
                </button>
              </div>
            </ToolbarPopover>
          </div>
  );

  const textColorControl = (
          <div className="shape-menu-anchor">
            <EditorToolbarColorButton
              buttonRef={textColorButtonRef}
              text
              active={colorStylePanel === "text" && canUseTextToolbar}
              tooltip={{ label: t("format.textColor.tooltip") }}
              aria-label={t("format.textColor.label")}
              aria-haspopup="dialog"
              aria-expanded={colorStylePanel === "text" && canUseTextToolbar}
              disabled={!canUseTextToolbar}
              onClick={() => {
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel((current) => (current === "text" ? null : "text"));
              }}
            >
              <span aria-hidden="true" className="toolbar-icon-color-glyph">A</span>
              <span aria-hidden="true" className="toolbar-icon-color-stripe" style={{ backgroundColor: textColor }} />
            </EditorToolbarColorButton>
            <ToolbarPopover
              open={colorStylePanel === "text" && canUseTextToolbar}
              anchorRef={textColorButtonRef}
              onClose={() => setColorStylePanel(null)}
              className="color-popover"
              ariaLabel={t("format.textColor.label")}
            >
              <ColorPalette
                value={textColor}
                onChange={(color) => {
                  if (color === null) return;
                  setTextColor(color);
                  applyInlineFormat("color", color);
                  setColorStylePanel(null);
                }}
              />
            </ToolbarPopover>
          </div>
  );

  const textBackgroundControl = (
          <div className="shape-menu-anchor">
            <EditorToolbarColorButton
              buttonRef={textBackgroundColorButtonRef}
              text
              active={colorStylePanel === "textBackground" && canUseTextToolbar}
              tooltip={{ label: t("format.backgroundColor.tooltip") }}
              aria-label={t("format.backgroundColor.label")}
              aria-haspopup="dialog"
              aria-expanded={colorStylePanel === "textBackground" && canUseTextToolbar}
              disabled={!canUseTextToolbar}
              onClick={() => {
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel((current) => (current === "textBackground" ? null : "textBackground"));
              }}
            >
              <Highlighter size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span
                aria-hidden="true"
                className="toolbar-icon-color-stripe"
                style={{ backgroundColor: textBackgroundColor ?? "transparent" }}
              />
            </EditorToolbarColorButton>
            <ToolbarPopover
              open={colorStylePanel === "textBackground" && canUseTextToolbar}
              anchorRef={textBackgroundColorButtonRef}
              onClose={() => setColorStylePanel(null)}
              className="color-popover"
              ariaLabel={t("format.backgroundColor.label")}
            >
              <ColorPalette
                value={textBackgroundColor}
                allowTransparent
                transparentLabel={t("format.backgroundColor.transparent")}
                onChange={(color) => {
                  setTextBackgroundColor(color);
                  applyInlineFormat("backgroundColor", color ?? "");
                  setColorStylePanel(null);
                }}
              />
            </ToolbarPopover>
          </div>
  );

  const lineHeightControl = (
          <div className="shape-menu-anchor">
            <EditorToolbarMenuButton
              buttonRef={lineHeightButtonRef}
              variant="lineHeight"
              active={lineHeightMenuOpen && canUseLineHeight}
              tooltip={{ label: t("format.lineHeight.tooltip", { value: t("format.lineHeight.value", { value: lineHeight }) }) }}
              aria-label={t("format.lineHeight.current", { value: t("format.lineHeight.value", { value: lineHeight }) })}
              aria-haspopup="dialog"
              aria-expanded={lineHeightMenuOpen && canUseLineHeight}
              disabled={!canUseLineHeight}
              onClick={() => {
                setShapeMenuOpen(false);
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel(null);
                setLineEndpointMenu(null);
                setBlockStyleMenuOpen(false);
                setLineHeightMenuOpen((current) => {
                  const nextOpen = !current;
                  if (nextOpen) {
                    setLineHeightInput(lineHeight);
                    setLineHeightInputError(null);
                    setLineHeightCustomOpen(false);
                  }
                  return nextOpen;
                });
              }}
            >
              <ListChevronsUpDown size={EDITOR_TOOLBAR_ICON_SIZE + 1} />
              <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
            </EditorToolbarMenuButton>
            <ToolbarPopover
              open={lineHeightMenuOpen && canUseLineHeight}
              anchorRef={lineHeightButtonRef}
              onClose={() => {
                setLineHeightMenuOpen(false);
                setLineHeightCustomOpen(false);
              }}
              className="shape-menu line-height-menu"
              role="dialog"
              ariaLabel={t("format.lineHeight.label")}
            >
              {/* The fine ± stepper belongs to the 数値で指定 disclosure below; see
                  `line-height-menu.test.ts` for why a second always-on copy is not kept
                  here. */}
              {LINE_HEIGHT_OPTIONS.map(({ value }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={lineHeight === value}
                  className={lineHeight === value ? "selected" : ""}
                  title={t("format.lineHeight.value", { value })}
                  aria-label={t("format.lineHeight.value", { value })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    applyLineHeight(value);
                    setLineHeightMenuOpen(false);
                    setLineHeightCustomOpen(false);
                  }}
                >
                  <span className="line-height-menu-check" aria-hidden="true">
                    {lineHeight === value ? <Check size={16} /> : null}
                  </span>
                  <span>{t("format.lineHeight.value", { value })}</span>
                </button>
              ))}
              <div className="line-height-menu-divider" aria-hidden="true" />
              <button
                type="button"
                className={`line-height-custom-toggle ${lineHeightCustomOpen ? "open" : ""}`}
                aria-expanded={lineHeightCustomOpen}
                aria-controls="line-height-custom-panel"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setLineHeightCustomOpen((current) => {
                    const nextOpen = !current;
                    if (nextOpen) {
                      setLineHeightInput(lineHeight);
                      setLineHeightInputError(null);
                    }
                    return nextOpen;
                  });
                }}
              >
                <span>{t("format.lineHeight.custom")}</span>
                <span className="line-height-custom-toggle-value">{t("format.lineHeight.value", { value: lineHeight })}</span>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              {lineHeightCustomOpen ? (
                <div id="line-height-custom-panel" className="line-height-custom-form">
                  <div className="line-height-stepper" role="group" aria-label={t("format.lineHeight.stepper")}>
                    <button
                      type="button"
                      aria-label={t("format.lineHeight.decrease")}
                      disabled={lineHeight === String(MIN_LINE_HEIGHT) || !canUseLineHeight}
                      onPointerDown={(event) => startLineHeightStepping(event, "decrease")}
                      onPointerUp={stopLineHeightStepping}
                      onPointerLeave={stopLineHeightStepping}
                      onPointerCancel={stopLineHeightStepping}
                      onClick={(event) => handleLineHeightStepClick(event, "decrease")}
                    >
                      <Minus size={15} />
                    </button>
                    <output aria-live="polite">{t("format.lineHeight.value", { value: lineHeight })}</output>
                    <button
                      type="button"
                      aria-label={t("format.lineHeight.increase")}
                      disabled={lineHeight === String(MAX_LINE_HEIGHT) || !canUseLineHeight}
                      onPointerDown={(event) => startLineHeightStepping(event, "increase")}
                      onPointerUp={stopLineHeightStepping}
                      onPointerLeave={stopLineHeightStepping}
                      onPointerCancel={stopLineHeightStepping}
                      onClick={(event) => handleLineHeightStepClick(event, "increase")}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="line-height-custom-row">
                    <input
                      id="line-height-custom-input"
                      type="number"
                      inputMode="decimal"
                      min={MIN_LINE_HEIGHT}
                      max={MAX_LINE_HEIGHT}
                      step={LINE_HEIGHT_STEP}
                      value={lineHeightInput}
                      aria-label={t("format.lineHeight.input")}
                      aria-invalid={lineHeightInputError ? true : undefined}
                      aria-describedby="line-height-custom-help"
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setLineHeightInput(nextValue);
                        applyLineHeight(nextValue, { updateInput: false });
                      }}
                    />
                  </div>
                  <p
                    id="line-height-custom-help"
                    className={`line-height-custom-help ${lineHeightInputError ? "error" : ""}`}
                  >
                    {lineHeightInputError ?? t("format.lineHeight.inputHelp", { min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT })}
                  </p>
                </div>
              ) : null}
            </ToolbarPopover>
          </div>
  );

  const textAlignControl = (
          <div className="align-tip" aria-label={t("format.align.label")}>
            <div className="shape-menu-anchor">
              <EditorToolbarMenuButton
                buttonRef={textAlignButtonRef}
                variant="textAlign"
                active={textAlignMenuOpen && canUseTextAlign}
                tooltip={{ label: t("format.align.tooltip", { value: t(`format.align.${activeTextAlignOption.value}`) }) }}
                aria-label={t("format.align.current", { value: t(`format.align.${activeTextAlignOption.value}`) })}
                aria-haspopup="menu"
                aria-expanded={textAlignMenuOpen && canUseTextAlign}
                disabled={!canUseTextAlign}
                onClick={() => {
                  setShapeMenuOpen(false);
                  setLineToolMenuOpen(false);
                  setBoxedTextMenuOpen(false);
                  setLineHeightMenuOpen(false);
                  setLineDashMenuOpen(false);
                  setColorStylePanel(null);
                  setLineEndpointMenu(null);
                  setFontFamilyMenuOpen(false);
                  setBlockStyleMenuOpen(false);
                  setTextAlignMenuOpen((current) => !current);
                }}
              >
                <ActiveTextAlignIcon size={EDITOR_TOOLBAR_ICON_SIZE} />
                <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
              </EditorToolbarMenuButton>
              <ToolbarPopover
                open={textAlignMenuOpen && canUseTextAlign}
                anchorRef={textAlignButtonRef}
                onClose={() => setTextAlignMenuOpen(false)}
                className="shape-menu text-align-menu"
                role="menu"
                ariaLabel={t("format.align.label")}
              >
                {TEXT_ALIGN_OPTIONS.map(({ value, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedTextAlign === value}
                    className={selectedTextAlign === value ? "selected" : ""}
                    title={t(`format.align.${value}`)}
                    aria-label={t(`format.align.${value}`)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      applyTextAlign(value);
                      setTextAlignMenuOpen(false);
                    }}
                  >
                    <Icon size={18} />
                  </button>
                ))}
              </ToolbarPopover>
            </div>
          </div>
  );

  // ブロックの追加・切替。Word / Google ドキュメントと同じで、行揃え・行間と同じ「段落」の
  // 並びに置く。押せる条件は段落スタイルのドロップダウンと同じ (`canUseTextBlockStyle`)。
  const bulletListButton = (
    <EditorToolbarIconButton
      disabled={!canUseBlockStructure}
      active={blockStyleState.listType === "bullet"}
      tooltip={{ label: t("format.blockStructure.bulletList") }}
      aria-label={t("format.blockStructure.bulletList")}
      aria-pressed={blockStyleState.listType === "bullet"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => applyBlockStructure("bulletList")}
    >
      <List size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );

  const orderedListActive = blockStyleState.listType === "ordered";
  // 番号付きは「番号付きにする」と「(1) か 1. か」が同じ操作。本体を押すと直前に選んだ形式で
  // トグルし、キャレットから形式を選び直せる — 図形ツールや線の端点ピッカーと同じ作り。
  const orderedListControl = (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={orderedListMenuButtonRef}
        disabled={!canUseBlockStructure}
        active={orderedListActive || orderedListMenuOpen}
        tooltip={{ label: t("format.blockStructure.orderedListTooltip", { marker: blockStyleState.orderedMarkerStyle === "paren" ? "(1)" : "1." }) }}
        aria-label={t("format.blockStructure.orderedList")}
        aria-haspopup="menu"
        aria-expanded={orderedListMenuOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setActiveMenu(null);
          setMoreBlocksMenuOpen(false);
          setOrderedListMenuOpen((current) => !current);
        }}
      >
        <ListOrdered size={EDITOR_TOOLBAR_ICON_SIZE} />
        <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={orderedListMenuOpen && canUseBlockStructure}
        anchorRef={orderedListMenuButtonRef}
        onClose={() => setOrderedListMenuOpen(false)}
        className="shape-menu ordered-list-menu"
        role="menu"
        ariaLabel={t("format.blockStructure.numberStyle")}
      >
        {([
          { value: "orderedList" as const, marker: "decimal" as const, label: "1. 2. 3." },
          { value: "orderedListParen" as const, marker: "paren" as const, label: "(1) (2) (3)" },
        ]).map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitem"
            className={orderedListActive && blockStyleState.orderedMarkerStyle === option.marker ? "active" : ""}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOrderedListMenuOpen(false);
              applyBlockStructure(option.value);
            }}
          >
            <ListOrdered size={16} />
            <span>{option.label}</span>
          </button>
        ))}
      </ToolbarPopover>
    </div>
  );

  const moreBlocksControl = (
    <div className="shape-menu-anchor">
      <EditorToolbarMenuButton
        buttonRef={moreBlocksMenuButtonRef}
        disabled={bodyToolbarLockedByAi}
        active={moreBlocksMenuOpen || blockStyleState.inQuoteBlock || blockStyleState.inCodeBlock || blockStyleState.onDivider}
        tooltip={{ label: t("format.blockStructure.more") }}
        aria-label={t("format.blockStructure.more")}
        aria-haspopup="menu"
        aria-expanded={moreBlocksMenuOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setActiveMenu(null);
          setOrderedListMenuOpen(false);
          setMoreBlocksMenuOpen((current) => !current);
        }}
      >
        <MoreHorizontal size={EDITOR_TOOLBAR_ICON_SIZE} />
        <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
      </EditorToolbarMenuButton>
      <ToolbarPopover
        open={moreBlocksMenuOpen && !bodyToolbarLockedByAi}
        anchorRef={moreBlocksMenuButtonRef}
        onClose={() => setMoreBlocksMenuOpen(false)}
        className="shape-menu block-structure-menu"
        role="menu"
        ariaLabel={t("format.blockStructure.more")}
      >
        <button
          type="button"
          role="menuitem"
          className={blockStyleState.inQuoteBlock ? "active" : ""}
          disabled={!canUseBlockStructure}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setMoreBlocksMenuOpen(false);
            applyBlockStructure("quote");
          }}
        >
          <Quote size={16} />
          <span>
            {blockStyleState.inQuoteBlock
              ? t("format.blockStructure.removeQuote")
              : t("format.blockStructure.quote")}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={blockStyleState.inCodeBlock ? "active" : ""}
          disabled={!canUseBlockStructure}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setMoreBlocksMenuOpen(false);
            applyBlockStructure("code");
          }}
        >
          <Code size={16} />
          <span>
            {blockStyleState.inCodeBlock
              ? t("format.blockStructure.removeCode")
              : t("format.blockStructure.code")}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={blockStyleState.onDivider ? "active" : ""}
          disabled={!canUseBlockStructure}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setMoreBlocksMenuOpen(false);
            applyBlockStructure("divider");
          }}
        >
          <SeparatorHorizontal size={16} />
          <span>
            {blockStyleState.onDivider
              ? t("format.blockStructure.removeDivider")
              : t("format.blockStructure.divider")}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={bodyToolbarLockedByAi}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setMoreBlocksMenuOpen(false);
            addBlock("boxBlock");
          }}
        >
          <Square size={16} />
          <span>{t("format.blockStructure.fancybox")}</span>
        </button>
      </ToolbarPopover>
    </div>
  );

  const blockStyleControls = (
    <>
      {bulletListButton}
      {orderedListControl}
      {moreBlocksControl}
    </>
  );

  const formatGroup = (
    <>
        <EditorToolbarSeparator />

        <EditorToolbarGroup ariaLabel={t("toolbar.group.format")}>
          {paragraphStyleSelect}
          <span className="toolbar-inline-divider" aria-hidden="true" />
          {fontFamilyControl}
          {fontSizeSelect}
          {boldButton}
          {italicButton}
          {underlineButton}
          {boxedTextControl}
          {textColorControl}
          {textBackgroundControl}
          {lineHeightControl}
          {textAlignControl}
          <span className="toolbar-inline-divider" aria-hidden="true" />
          {blockStyleControls}
        </EditorToolbarGroup>
      </>
  );

  const inlineMathControl = (
      <div className="shape-menu-anchor">
        <EditorToolbarIconButton
          buttonRef={inlineMathButtonRef}
          disabled={bodyToolbarLockedByAi}
          active={inlineMathMenuOpen && selectedInlineMath !== null}
          tooltip={commandTooltip(t("insert.math.tooltip"), "insert.inlineMath")}
          aria-label={t("insert.math.label")}
          aria-haspopup="dialog"
          aria-expanded={inlineMathMenuOpen}
          onMouseEnter={openInlineMathMenu}
          onMouseLeave={scheduleInlineMathMenuClose}
          onClick={startInlineMathFromToolbar}
        >
          <Sigma size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <ToolbarPopover
          open={inlineMathMenuOpen}
          anchorRef={inlineMathButtonRef}
          onClose={() => setInlineMathMenuOpen(false)}
          className="inline-math-toolbar-popover"
          role="dialog"
          ariaLabel={t("insert.math.details")}
          onMouseLeave={scheduleInlineMathMenuClose}
        >
          <div onMouseEnter={openInlineMathMenu}>
            <Inset as="header" className="inline-math-toolbar-popover-header" space="md">
              <Inline gap="sm" justify="between">
                <span className="inline-math-toolbar-popover-title">{t("insert.math.label")}</span>
                <IconButton
                  label={t("insert.math.close")}
                  tone="ghost"
                  size="sm"
                  onClick={() => setInlineMathMenuOpen(false)}
                >
                  <X size={15} aria-hidden="true" />
                </IconButton>
              </Inline>
            </Inset>
            <InlineMathDetails
              key={selectedInlineMath?.id ?? "new-inline-math"}
              onInsertTemplate={(tex) => {
                cancelInlineMathMenuClose();
                setInlineMathMenuOpen(false);
                insertInlineMath(tex, getActiveTextTarget());
                setStatusMessage(t("insert.math.added"));
              }}
              selectedInlineMath={selectedInlineMathDetails}
            />
          </div>
        </ToolbarPopover>
      </div>
  );

  const overlayTextButton = (
      <EditorToolbarIconButton
        disabled={aiDocumentWriteInProgress}
        active={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "text"}
        tooltip={commandTooltip(t("insert.text.tooltip"), "overlay.text")}
        aria-label={t("insert.text.label")}
        aria-pressed={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "text"}
        onClick={() => runOverlayCommand("text")}
      >
        <Type size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  const graphButton = (
      <EditorToolbarIconButton
        disabled={aiDocumentWriteInProgress}
        active={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "graph"}
        tooltip={commandTooltip(t("insert.graph.tooltip"), "overlay.graph")}
        aria-label={t("insert.graph.label")}
        aria-pressed={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "graph"}
        onClick={() => runOverlayCommand("graph")}
      >
        <ChartSpline size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  const graph3DButton = (
      <EditorToolbarIconButton
        disabled={aiDocumentWriteInProgress}
        active={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "graph3d"}
        tooltip={{ label: t("insert.graph3d.tooltip") }}
        aria-label={t("insert.graph3d.label")}
        aria-pressed={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "graph3d"}
        onClick={() => runOverlayCommand("graph3d")}
      >
        <Cuboid size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  const tableButton = (
      <EditorToolbarIconButton
        disabled={aiDocumentWriteInProgress}
        active={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "table"}
        tooltip={commandTooltip(t("insert.table.tooltip"), "overlay.table")}
        aria-label={t("insert.table.label")}
        aria-pressed={activeOverlayTool.kind === "insert" && activeOverlayTool.command === "table"}
        onClick={() => runOverlayCommand("table")}
      >
        <Rows3 size={EDITOR_TOOLBAR_ICON_SIZE} />
      </EditorToolbarIconButton>
  );

  const shapeMenuControl = (
      <div className="shape-menu-anchor">
        <EditorToolbarMenuButton
          buttonRef={shapeMenuButtonRef}
          disabled={aiDocumentWriteInProgress}
          active={shapeMenuOpen || (activeOverlayTool.kind === "insert" && isShapeMenuCommand(activeOverlayTool.command))}
          tooltip={{ label: t("insert.shape.tooltip") }}
          aria-label={t("insert.shape.label")}
          aria-haspopup="menu"
          aria-expanded={shapeMenuOpen}
          onClick={() => {
            setActiveMenu(null);
            setBoxedTextMenuOpen(false);
            setLineHeightMenuOpen(false);
            setTextAlignMenuOpen(false);
            setLineDashMenuOpen(false);
            setColorStylePanel(null);
            setLineEndpointMenu(null);
            setLineToolMenuOpen(false);
            setShapeMenuOpen((current) => !current);
          }}
        >
          <Square size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
          <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
        </EditorToolbarMenuButton>
        <ToolbarPopover
          open={shapeMenuOpen}
          anchorRef={shapeMenuButtonRef}
          onClose={() => setShapeMenuOpen(false)}
          className="shape-menu shape-gallery"
          role="menu"
        >
          {shapeGallerySections.map((section) => (
            <div className="shape-gallery-section" key={section.id}>
              <div className="shape-gallery-section-label">{section.label}</div>
              <div className="shape-gallery-grid">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive =
                    item.action === "command" &&
                    activeOverlayTool.kind === "insert" &&
                    activeOverlayTool.command === item.command;
                  return (
                    <button
                      key={item.command ?? item.label}
                      type="button"
                      role="menuitem"
                      title={item.label}
                      aria-label={item.label}
                      className={isActive ? "active" : ""}
                      onClick={() => {
                        if (item.action === "image") {
                          setShapeMenuOpen(false);
                          setLineToolMenuOpen(false);
                          imageInputRef.current?.click();
                          return;
                        }
                        runOverlayCommand(item.command!);
                      }}
                    >
                      <Icon size={18} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </ToolbarPopover>
      </div>
  );

  const lineToolControl = (
      <div className="shape-menu-anchor">
        <EditorToolbarMenuButton
          buttonRef={lineToolMenuButtonRef}
          disabled={aiDocumentWriteInProgress}
          active={lineToolMenuOpen || (activeOverlayTool.kind === "insert" && isLineToolCommand(activeOverlayTool.command))}
          tooltip={{ label: t("insert.line.tooltip", { value: activeLineToolItem.label }) }}
          aria-label={activeLineToolItem.label}
          aria-haspopup="menu"
          aria-expanded={lineToolMenuOpen}
          onClick={() => {
            setActiveMenu(null);
            setBoxedTextMenuOpen(false);
            setLineHeightMenuOpen(false);
            setTextAlignMenuOpen(false);
            setLineDashMenuOpen(false);
            setColorStylePanel(null);
            setShapeMenuOpen(false);
            setLineEndpointMenu(null);
            setLineToolMenuOpen((current) => !current);
          }}
        >
          <ActiveLineToolIcon size={EDITOR_TOOLBAR_ICON_SIZE} />
          <ChevronDown size={EDITOR_TOOLBAR_CARET_SIZE} />
        </EditorToolbarMenuButton>
        <ToolbarPopover
          open={lineToolMenuOpen}
          anchorRef={lineToolMenuButtonRef}
          onClose={() => setLineToolMenuOpen(false)}
          className="shape-menu line-tool-menu"
          role="menu"
        >
          {lineToolItems.map(({ command, label, icon: Icon }) => {
            const isActive = activeOverlayTool.kind === "insert" && activeOverlayTool.command === command;
            return (
              <button
                key={command}
                type="button"
                role="menuitem"
                className={isActive ? "active" : ""}
                onClick={() => runOverlayCommand(command)}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            );
          })}
        </ToolbarPopover>
      </div>
  );

  const insertGroup = (
    <EditorToolbarGroup ariaLabel={t("toolbar.group.insert")}>
      {inlineMathControl}
      {overlayTextButton}
      {graphButton}
      {graph3DButton}
      {tableButton}
      {shapeMenuControl}
      {lineToolControl}
    </EditorToolbarGroup>
  );

  const strokeColorControl = (
          <div className="shape-menu-anchor">
            <EditorToolbarColorButton
              buttonRef={strokeColorButtonRef}
              active={colorStylePanel === "stroke" && canUseStrokeStyleControls}
              tooltip={{ label: t("shapeStyle.stroke.tooltip") }}
              aria-label={t("shapeStyle.stroke.label")}
              aria-haspopup="dialog"
              aria-expanded={colorStylePanel === "stroke" && canUseStrokeStyleControls}
              disabled={!canUseStrokeStyleControls}
              onClick={() => {
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel((current) => (current === "stroke" ? null : "stroke"));
              }}
            >
              <PenLine size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
            </EditorToolbarColorButton>
            <ToolbarPopover
              open={colorStylePanel === "stroke" && canUseStrokeStyleControls}
              anchorRef={strokeColorButtonRef}
              onClose={() => setColorStylePanel(null)}
              className="color-popover"
              ariaLabel={t("shapeStyle.stroke.label")}
            >
              <ColorPalette
                value={strokeColor}
                allowTransparent
                transparentLabel={t("shapeStyle.stroke.transparent")}
                onChange={(color) => {
                  if (color === null) {
                    applyOverlayStyle({ strokeOpacity: 0 });
                    setStrokeColor(null);
                  } else {
                    setStrokeColor(color);
                    applyOverlayStyle({ color, strokeOpacity: 1 });
                  }
                  setColorStylePanel(null);
                }}
              />
            </ToolbarPopover>
          </div>
  );

  const fillColorControl = (
          <div className="shape-menu-anchor">
            <EditorToolbarColorButton
              buttonRef={fillColorButtonRef}
              active={colorStylePanel === "fill" && canUseFillStyleControls}
              tooltip={{ label: t("shapeStyle.fill.tooltip") }}
              aria-label={t("shapeStyle.fill.label")}
              aria-haspopup="dialog"
              aria-expanded={colorStylePanel === "fill" && canUseFillStyleControls}
              disabled={!canUseFillStyleControls}
              onClick={() => {
                setLineToolMenuOpen(false);
                setBoxedTextMenuOpen(false);
                setLineHeightMenuOpen(false);
                setTextAlignMenuOpen(false);
                setLineDashMenuOpen(false);
                setColorStylePanel((current) => (current === "fill" ? null : "fill"));
              }}
            >
              <PaintBucket size={EDITOR_TOOLBAR_ICON_SIZE} />
            </EditorToolbarColorButton>
            <ToolbarPopover
              open={colorStylePanel === "fill" && canUseFillStyleControls}
              anchorRef={fillColorButtonRef}
              onClose={() => setColorStylePanel(null)}
              className="color-popover"
              ariaLabel={t("shapeStyle.fill.label")}
            >
              <ColorPalette
                value={selectionFillColor}
                opacity={selectionFillOpacity}
                mixed={selectionFill.kind === "mixed"}
                allowTransparent
                transparentLabel={t("shapeStyle.fill.transparent")}
                onPreview={(preview) => {
                  dispatchOverlayStylePreview(preview === null
                    ? null
                    : { fill: "solid", fillColor: preview.color, fillOpacity: preview.opacity });
                }}
                onChange={(color, nextOpacity) => {
                  // "No fill" and "a fully transparent colour" are different documents, so the
                  // null colour is decided before any opacity is looked at.
                  if (color === null) {
                    applyOverlayStyle({ fill: "none" });
                  } else {
                    applyOverlayStyle(nextOpacity === undefined
                      ? fillColorPatch(color)
                      : { fill: "solid", fillColor: color, fillOpacity: nextOpacity });
                  }
                  setColorStylePanel(null);
                }}
              />
            </ToolbarPopover>
          </div>
  );

  const lineDashButton = (
          <OverlayLineDashMenuButton
            buttonRef={lineDashButtonRef}
            currentValue={selectedOverlayLineDash}
            open={effectiveLineDashMenuOpen}
            disabled={!canUseLineStyleControls}
            onToggle={() => {
              setActiveMenu(null);
              setColorStylePanel(null);
              setShapeMenuOpen(false);
              setLineToolMenuOpen(false);
              setBoxedTextMenuOpen(false);
              setLineHeightMenuOpen(false);
              setTextAlignMenuOpen(false);
              setLineEndpointMenu(null);
              setLineWidthMenuOpen(false);
              setLineDashMenuOpen((current) => !current);
            }}
            onSelect={(value) => {
              applyOverlayStyle({ dash: value });
              setLineDashMenuOpen(false);
            }}
          />
  );

  const lineWidthButton = (
          <OverlayLineWidthMenuButton
            buttonRef={lineWidthButtonRef}
            currentValue={selectedOverlayLineSize}
            open={effectiveLineWidthMenuOpen}
            disabled={!canUseLineStyleControls}
            onToggle={() => {
              setActiveMenu(null);
              setColorStylePanel(null);
              setShapeMenuOpen(false);
              setLineToolMenuOpen(false);
              setBoxedTextMenuOpen(false);
              setLineHeightMenuOpen(false);
              setTextAlignMenuOpen(false);
              setLineEndpointMenu(null);
              setLineDashMenuOpen(false);
              setLineWidthMenuOpen((current) => !current);
            }}
            onSelect={(value) => {
              applyOverlayStyle({ size: value });
              setLineWidthMenuOpen(false);
            }}
          />
  );

  const lineStartButton = (
          <LineEndpointMenuButton
            endpoint="start"
            currentValue={overlaySelection.arrowheadStart}
            open={effectiveLineEndpointMenu === "start"}
            disabled={!canUseLineEndpointControls}
            onToggle={() => {
              setActiveMenu(null);
              setColorStylePanel(null);
              setShapeMenuOpen(false);
              setLineToolMenuOpen(false);
              setLineDashMenuOpen(false);
              setLineWidthMenuOpen(false);
              setLineEndpointMenu((current) => (current === "start" ? null : "start"));
            }}
            onSelect={(value) => {
              applyOverlayStyle({ arrowheadStart: value });
              setLineEndpointMenu(null);
            }}
          />
  );

  const lineEndButton = (
          <LineEndpointMenuButton
            endpoint="end"
            currentValue={overlaySelection.arrowheadEnd}
            open={effectiveLineEndpointMenu === "end"}
            disabled={!canUseLineEndpointControls}
            onToggle={() => {
              setActiveMenu(null);
              setColorStylePanel(null);
              setShapeMenuOpen(false);
              setLineToolMenuOpen(false);
              setLineDashMenuOpen(false);
              setLineWidthMenuOpen(false);
              setLineEndpointMenu((current) => (current === "end" ? null : "end"));
            }}
            onSelect={(value) => {
              applyOverlayStyle({ arrowheadEnd: value });
              setLineEndpointMenu(null);
            }}
          />
  );

  // Googleドキュメント風では横幅を圧迫しないアイコンボタンとして置く。
  // Word風では下の図形書式タブに同じ4操作を文字付きで置き直す。
  const arrangeFrontQuickButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("shapeStyle.arrange.frontTooltip"), "overlay.arrange.front")} aria-label={t("shapeStyle.arrange.front")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("front")}>
      <BringToFront size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );
  const arrangeForwardQuickButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("shapeStyle.arrange.forwardTooltip"), "overlay.arrange.forward")} aria-label={t("shapeStyle.arrange.forward")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("forward")}>
      <MoveUp size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );
  const arrangeBackwardQuickButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("shapeStyle.arrange.backwardTooltip"), "overlay.arrange.backward")} aria-label={t("shapeStyle.arrange.backward")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("backward")}>
      <MoveDown size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );
  const arrangeBackQuickButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("shapeStyle.arrange.backTooltip"), "overlay.arrange.back")} aria-label={t("shapeStyle.arrange.back")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("back")}>
      <SendToBack size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );

  const shapeStyleGroup = (
    <>
        <EditorToolbarSeparator />

        <EditorToolbarGroup ariaLabel={t("toolbar.group.shapeStyle")}>
          {strokeColorControl}
          {fillColorControl}
          {lineDashButton}
          {lineWidthButton}
          {lineStartButton}
          {lineEndButton}
          {arrangeFrontQuickButton}
          {arrangeForwardQuickButton}
          {arrangeBackwardQuickButton}
          {arrangeBackQuickButton}
        </EditorToolbarGroup>
      </>
  );

  const searchAnchorGroup = (
        <EditorToolbarGroup className="search-anchor" ariaLabel={t("toolbar.group.search")}>
        <EditorToolbarIconButton
          buttonRef={searchButtonRef}
          active={searchOpen}
          tooltip={commandTooltip(t("search.tooltip"), "edit.search")}
          aria-label={t("search.label")}
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((current) => !current)}
        >
          <Search size={EDITOR_TOOLBAR_ICON_SIZE} />
        </EditorToolbarIconButton>
        <ToolbarPopover
          open={searchOpen}
          anchorRef={searchButtonRef}
          onClose={() => setSearchOpen(false)}
          align="right"
          gap={8}
          className="find-widget"
          ariaLabel={t("search.label")}
        >
            <div className="find-row">
              <button
                type="button"
                className="find-disclosure"
                title={replaceOpen ? t("search.closeReplace") : t("search.openReplace")}
                aria-label={replaceOpen ? t("search.closeReplace") : t("search.openReplace")}
                aria-expanded={replaceOpen}
                onClick={() => setReplaceOpen((current) => !current)}
              >
                {replaceOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              <div className="find-input-wrap">
                <input
                  className="find-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      findNext();
                    }
                    if (event.key === "Escape") {
                      setSearchOpen(false);
                    }
                  }}
                  placeholder={t("search.find")}
                  aria-label={t("search.find")}
                  autoFocus
                />
                <span className="find-count">{searchQuery.trim() ? t("search.matchCount", { matches: searchMatchCount }) : ""}</span>
              </div>
              <button type="button" className="find-icon-button" title={t("search.previous")} aria-label={t("search.previous")} onClick={findPrevious}>
                ↑
              </button>
              <button type="button" className="find-icon-button" title={t("search.next")} aria-label={t("search.next")} onClick={findNext}>
                ↓
              </button>
              <button type="button" className="find-icon-button" title={t("search.close")} aria-label={t("search.close")} onClick={() => setSearchOpen(false)}>
                <X size={15} />
              </button>
            </div>
            {replaceOpen && (
              <div className="find-row replace-row">
                <span className="find-disclosure-spacer" />
                <input
                  className="find-input"
                  value={replaceText}
                  onChange={(event) => setReplaceText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      replaceNext();
                    }
                  }}
                  placeholder={t("search.replace")}
                  aria-label={t("search.replace")}
                />
                <button type="button" className="find-icon-button" title={t("search.replace")} aria-label={t("search.replace")} onClick={replaceNext}>
                  <Replace size={14} />
                </button>
                <button type="button" className="find-action-button" title={t("search.replaceAll")} aria-label={t("search.replaceAll")} onClick={replaceAll}>
                  {t("search.replaceAllShort")}
                </button>
              </div>
            )}
        </ToolbarPopover>
        </EditorToolbarGroup>
  );

  const searchGroup = (
    !overlayEditing && (
      <>
        <EditorToolbarSeparator />

        {searchAnchorGroup}
      </>
    )
  );

  const zoomOutButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("view.zoomOutTooltip"), "view.zoomOut")} aria-label={t("view.zoomOut")} onClick={() => applyZoom((current) => current - KEYBOARD_ZOOM_STEP)}>
      <MinusCircle size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );

  const zoomSelect = (
    <EditorToolbarSelect
      compact
      value={String(zoom)}
      options={zoomOptions.map((value) => ({ value: String(value), label: `${value}%` }))}
      onChange={(value) => applyZoom(Number(value))}
      aria-label={t("view.zoom")}
    />
  );

  const zoomInButton = (
    <EditorToolbarIconButton tooltip={commandTooltip(t("view.zoomInTooltip"), "view.zoomIn")} aria-label={t("view.zoomIn")} onClick={() => applyZoom((current) => current + KEYBOARD_ZOOM_STEP)}>
      <PlusCircle size={EDITOR_TOOLBAR_ICON_SIZE} />
    </EditorToolbarIconButton>
  );

  const viewGroup = (
    <EditorToolbarGroup push ariaLabel={t("toolbar.group.view")}>
    {zoomOutButton}
    {zoomSelect}
    {zoomInButton}
    </EditorToolbarGroup>
  );

  const importInput = (
    <input
      ref={importInputRef}
      type="file"
      accept="application/json,.sigma,.json,.tex,.latex,text/x-tex,application/x-tex"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) {
          void importDocumentFile(file);
        }
        event.currentTarget.value = "";
      }}
    />
  );

  const otherImportInput = (
    <input
      ref={otherImportInputRef}
      type="file"
      accept={POWERPOINT_IMPORT_ACCEPT}
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) {
          void importDocumentFile(file);
        }
        event.currentTarget.value = "";
      }}
    />
  );

  const imageInput = (
    <input
      ref={imageInputRef}
      data-testid="overlay-image-input"
      type="file"
      accept={SUPPORTED_OVERLAY_IMAGE_MIME_TYPES.join(",")}
      multiple
      hidden
      onChange={(event) => {
        const files = event.target.files;
        if (files && files.length > 0) {
          requestOverlayImages(files);
        }
        event.currentTarget.value = "";
      }}
    />
  );

  // ---------------------------------------------------------------------------
  // Word風リボン
  //
  // 上のパーツを **同じ element のまま** 別の並びに置き直すだけ。新しいコマンドは 1 つも
  // 足しておらず、isDesktopApp / isEmbedded の条件式も docs 側と同一のものを使う。
  // ボタンも既存の EditorToolbarIconButton (.icon-button.with-text) をそのまま使う。
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Word風リボンの「ファイル」= Backstage（編集画面を覆う全画面）
  //
  // docs 側の 設定メニュー / ファイルメニュー / 右上アクション / 問題を報告 と
  // **同じ文言・同じ条件式**のコマンドを、セクション別に並べ直したもの。
  // 「動線が消えた」の直接原因はアイコンのみのボタンだったので、ここには
  // アイコンだけのコマンドを1つも置かず、全てに文字ラベルを付ける。
  // ---------------------------------------------------------------------------

  const backstagePanelId = ribbonBackstagePanelId(ribbonIdPrefix);
  // コマンドを押したら必ず Backstage を閉じる。本アプリのダイアログは body portal +
  // inert で背面を隔離するので、開いたまま残すと Esc でダイアログを閉じた先に
  // 忘れられた全画面が現れる（Word は残すが、こちらの方が予測可能）。
  const runBackstageCommand = (command: () => void) => {
    closeBackstage();
    command();
  };

  const ribbonBackstage = !backstageOpen ? null : (
    // 左ナビは role="tab" にしない。「ホーム」がリボンタブと同名になり、
    // getByRole("tab", { name: "ホーム" }) が strict mode で落ちる。
    // Backstage 自体は「ファイルタブのパネル」なので role="tabpanel" が意味的にも正しい
    // （背面を隔離していないので aria-modal は名乗らない）。
    <div
      className="ribbon-backstage"
      id={backstagePanelId}
      role="tabpanel"
      aria-labelledby={ribbonTabElementId(ribbonIdPrefix, "file")}
    >
      <nav className="ribbon-backstage-nav" aria-label={t("backstage.nav")}>
        <button
          type="button"
          className="ribbon-backstage-back"
          title={t("backstage.back")}
          aria-label={t("backstage.back")}
          onClick={closeBackstage}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        {BACKSTAGE_SECTIONS.map((sectionId) => (
          <button
            key={sectionId}
            type="button"
            className="ribbon-backstage-nav-item"
            aria-label={t(`backstage.sections.${sectionId}`)}
            aria-current={backstage.section === sectionId ? "page" : undefined}
            onClick={() => selectBackstageSection(sectionId)}
          >
            {t(`backstage.sections.${sectionId}`)}
          </button>
        ))}
      </nav>

      <div className="ribbon-backstage-pane">
        <h2 className="ribbon-backstage-title">{t(`backstage.sections.${backstage.section}`)}</h2>

        {backstage.section === "home" && (
          <>
            <div className="ribbon-backstage-group">
              {!isEmbedded && (
                <button type="button" className="ribbon-backstage-command" title={t("actions.workspace")} aria-label={t("actions.workspace")} onClick={() => runBackstageCommand(() => void openWorkspaceScreen())}>
                  <Building2 size={18} aria-hidden="true" />
                  <span>{t("actions.workspace")}</span>
                </button>
              )}
              <button type="button" className="ribbon-backstage-command" title={t("tabs.library")} aria-label={t("tabs.library")} disabled={isEmbedded} onClick={() => runBackstageCommand(() => void openDocumentListDialog())}>
                <Library size={18} aria-hidden="true" />
                <span>{t("tabs.library")}</span>
              </button>
            </div>
            <div className="ribbon-backstage-group">
              <h3 className="ribbon-backstage-group-label">{t("backstage.openDocuments")}</h3>
              {/* 教材タブ行と同じ集合。タイトルは数式を含みうるので、
                  docs 側のタブと同じく DocumentTitleText で描く。aria-label は付けない
                  （コマンドではなく現在開いている教材のリストなので、到達性の集合に
                  教材名が混ざらないようにする）。 */}
              <div className="ribbon-backstage-doc-list">
                {openDocumentTabs.map((tab) => (
                  <button
                    key={tab.fileId}
                    type="button"
                    className="ribbon-backstage-doc"
                    title={tab.title}
                    aria-current={tab.fileId === activeFileId ? "true" : undefined}
                    onClick={() => runBackstageCommand(() => {
                      if (tab.fileId !== activeFileId) {
                        void openDocumentInWorkspace(tab.fileId);
                      }
                    })}
                  >
                    <FileText size={16} aria-hidden="true" />
                    <span><DocumentTitleText title={tab.title} nodes={tab.fileId === activeFileId ? documentTitle.nodes : undefined} /></span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {backstage.section === "new" && (
          <div className="ribbon-backstage-group">
            <button type="button" className="ribbon-backstage-command" title={t("tabs.newBlank")} aria-label={t("tabs.newBlank")} disabled={isEmbedded} onClick={() => runBackstageCommand(() => void createDocumentTab())}>
              <FilePlus size={18} aria-hidden="true" />
              <span>{t("tabs.newBlank")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("tabs.newWhiteboard")} aria-label={t("tabs.newWhiteboard")} disabled={isEmbedded} onClick={() => runBackstageCommand(() => void createWhiteboardDocumentTab())}>
              <Square size={18} aria-hidden="true" />
              <span>{t("tabs.newWhiteboard")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("tabs.newFromTemplate")} aria-label={t("tabs.newFromTemplate")} disabled={isEmbedded} onClick={() => runBackstageCommand(() => setTemplateGalleryOpen(true))}>
              <LayoutTemplate size={18} aria-hidden="true" />
              <span>{t("tabs.newFromTemplate")}</span>
            </button>
          </div>
        )}

        {backstage.section === "open" && (
          <div className="ribbon-backstage-group">
            <button type="button" className="ribbon-backstage-command" title={t("tabs.library")} aria-label={t("tabs.library")} disabled={isEmbedded} onClick={() => runBackstageCommand(() => void openDocumentListDialog())}>
              <Library size={18} aria-hidden="true" />
              <span>{t("tabs.library")}</span>
            </button>
            {!isEmbedded && (
              <button type="button" className="ribbon-backstage-command" title={t("actions.workspace")} aria-label={t("actions.workspace")} onClick={() => runBackstageCommand(() => void openWorkspaceScreen())}>
                <Building2 size={18} aria-hidden="true" />
                <span>{t("actions.workspace")}</span>
              </button>
            )}
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.import")} aria-label={t("appMenu.file.import")} onClick={() => runBackstageCommand(openImportDialog)}>
              <FolderOpen size={18} aria-hidden="true" />
              <span>{t("appMenu.file.import")}</span>
            </button>
            {(
              <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.importOther")} aria-label={t("appMenu.file.importOther")} onClick={() => runBackstageCommand(openOtherImportDialog)}>
                <FolderOpen size={18} aria-hidden="true" />
                <span>{t("appMenu.file.importOther")}</span>
              </button>
            )}
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.importText")} aria-label={t("appMenu.file.importText")} onClick={() => runBackstageCommand(openTextImportDialog)}>
              <ClipboardPaste size={18} aria-hidden="true" />
              <span>{t("appMenu.file.importText")}</span>
            </button>
          </div>
        )}

        {backstage.section === "info" && (
          <>
            <p className="ribbon-backstage-doc-title">
              <DocumentTitleText title={resolvedDocumentTitle} nodes={documentTitle.nodes} />
            </p>
            <div className="ribbon-backstage-group">
              <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.duplicate")} aria-label={t("appMenu.file.duplicate")} disabled={isEmbedded} onClick={() => runBackstageCommand(duplicateActiveDocument)}>
                <Copy size={18} aria-hidden="true" />
                <span>{t("appMenu.file.duplicate")}</span>
              </button>
              <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.delete")} aria-label={t("appMenu.file.delete")} disabled={isEmbedded || documentMetadatas.length <= 1} onClick={() => runBackstageCommand(() => void deleteActiveDocument())}>
                <Trash2 size={18} aria-hidden="true" />
                <span>{t("appMenu.file.delete")}</span>
              </button>
            </div>
          </>
        )}

        {backstage.section === "export" && (
          <div className="ribbon-backstage-group">
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.exportJson")} aria-label={t("appMenu.file.exportJson")} onClick={() => runBackstageCommand(() => void exportJson())}>
              <Download size={18} aria-hidden="true" />
              <span>{t("appMenu.file.exportJson")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.exportPdf")} aria-label={t("appMenu.file.exportPdf")} onClick={() => runBackstageCommand(openPrintPreview)}>
              <Download size={18} aria-hidden="true" />
              <span>{t("appMenu.file.exportPdf")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.file.copyText")} aria-label={t("appMenu.file.copyText")} onClick={() => runBackstageCommand(() => void copyDocumentText())}>
              <ClipboardCopy size={18} aria-hidden="true" />
              <span>{t("appMenu.file.copyText")}</span>
            </button>
          </div>
        )}

        {backstage.section === "options" && (
          <div className="ribbon-backstage-group">
            {!isEmbedded && (
              <button type="button" className="ribbon-backstage-command" title={t("appMenu.settings.appSettings")} aria-label={t("appMenu.settings.appSettings")} onClick={() => runBackstageCommand(() => setDesktopSettingsOpen(true))}>
                <AppWindow size={18} aria-hidden="true" />
                <span>{t("appMenu.settings.appSettings")}</span>
              </button>
            )}
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.settings.shortcuts")} aria-label={t("appMenu.settings.shortcuts")} onClick={() => runBackstageCommand(openCommandSettings)}>
              <Keyboard size={18} aria-hidden="true" />
              <span>{t("appMenu.settings.shortcuts")}</span>
              {renderMenuShortcut("settings.commands")}
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.settings.texReference")} aria-label={t("appMenu.settings.texReference")} onClick={() => runBackstageCommand(() => setTexCommandReferenceOpen(true))}>
              <SquareFunction size={18} aria-hidden="true" />
              <span>{t("appMenu.settings.texReference")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.settings.texEnvironment")} aria-label={t("appMenu.settings.texEnvironment")} onClick={() => runBackstageCommand(() => setTexEnvironmentSettingsOpen(true))}>
              <Braces size={18} aria-hidden="true" />
              <span>{t("appMenu.settings.texEnvironment")}</span>
            </button>
            <button type="button" className="ribbon-backstage-command" title={t("appMenu.settings.pageSettings")} aria-label={t("appMenu.settings.pageSettings")} onClick={() => runBackstageCommand(() => setPageSettingsOpen(true))}>
              <FileCog size={18} aria-hidden="true" />
              <span>{t("appMenu.settings.pageSettings")}</span>
              {renderMenuShortcut("settings.page")}
            </button>
          </div>
        )}

        {backstage.section === "help" && (
          <div className="ribbon-backstage-group">
            <button type="button" className="ribbon-backstage-command" title={t("actions.reportIssueTooltip")} aria-label={t("actions.reportIssue")} onClick={() => runBackstageCommand(reportIssue)}>
              <FileQuestion size={18} aria-hidden="true" />
              <span>{t("actions.reportIssue")}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // docs が既定レイアウトなので、リボンの element ツリーは word のときしか作らない
  // （EditorShell は毎キーストローク再レンダーされる）。Backstage が開いている間は
  // リボン本体ごと隠れるので、グループの組み立て自体も丸ごと省く。
  // 条件で中身が消えるグループは、グループごと落とす（Word も空グループは描かない）。
  const arrangeFrontButton = (
    <EditorToolbarIconButton withText tooltip={commandTooltip(t("shapeStyle.arrange.frontTooltip"), "overlay.arrange.front")} aria-label={t("shapeStyle.arrange.front")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("front")}>
      <BringToFront size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
      <span>{t("shapeStyle.arrange.front")}</span>
    </EditorToolbarIconButton>
  );
  const arrangeForwardButton = (
    <EditorToolbarIconButton withText tooltip={commandTooltip(t("shapeStyle.arrange.forwardTooltip"), "overlay.arrange.forward")} aria-label={t("shapeStyle.arrange.forward")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("forward")}>
      <MoveUp size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
      <span>{t("shapeStyle.arrange.forward")}</span>
    </EditorToolbarIconButton>
  );
  const arrangeBackwardButton = (
    <EditorToolbarIconButton withText tooltip={commandTooltip(t("shapeStyle.arrange.backwardTooltip"), "overlay.arrange.backward")} aria-label={t("shapeStyle.arrange.backward")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("backward")}>
      <MoveDown size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
      <span>{t("shapeStyle.arrange.backward")}</span>
    </EditorToolbarIconButton>
  );
  const arrangeBackButton = (
    <EditorToolbarIconButton withText tooltip={commandTooltip(t("shapeStyle.arrange.backTooltip"), "overlay.arrange.back")} aria-label={t("shapeStyle.arrange.back")} disabled={!canArrangeOverlayShapes} onClick={() => arrangeOverlayShapes("back")}>
      <SendToBack size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
      <span>{t("shapeStyle.arrange.back")}</span>
    </EditorToolbarIconButton>
  );
  const ribbonTabGroups: Record<RibbonPanelTabId, readonly RibbonGroupDefinition[]> | null = uiLayoutPreference.mode !== "word" || backstageOpen || ribbonBodyHidden ? null : {
    home: [
      // 「元に戻す」グループはタイトル行の QAT へ移した (Word 365 2023+ と同じで、
      // ホームタブには undo/redo が無い)。
      {
        key: "font",
        label: t("ribbon.group.font"),
        rows: [
          <Fragment key="font-1">{fontFamilyControl}{fontSizeSelect}{boxedTextControl}</Fragment>,
          <Fragment key="font-2">{boldButton}{italicButton}{underlineButton}{textColorControl}{textBackgroundControl}</Fragment>,
        ],
      },
      {
        key: "paragraph",
        label: t("ribbon.group.paragraph"),
        rows: [
          <Fragment key="paragraph-1">{paragraphStyleSelect}{textAlignControl}</Fragment>,
          <Fragment key="paragraph-2">{lineHeightControl}{blockStyleControls}</Fragment>,
        ],
      },
      // 検索置換は docs 側でも overlayEditing 中は消える（同じ条件式）。
      ...(overlayEditing ? [] : [{ key: "edit", label: t("ribbon.group.edit"), rows: [<Fragment key="edit-1">{searchAnchorGroup}</Fragment>] }]),
      // AIメニューは埋め込みでは丸ごと出さない（docs 側と同じ条件式）。
      ...(isEmbedded ? [] : [{
        key: "ai",
        label: "AI",
        large: aiChatLargeButton,
        rows: isDesktopApp
          ? [(
            <Fragment key="ai-1">
              <EditorToolbarIconButton withText title={t("actions.aiSettings")} aria-label={t("actions.aiSettings")} onClick={() => setAiSettingsOpen(true)}>
                <SlidersHorizontal size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
                <span>{t("actions.aiSettings")}</span>
              </EditorToolbarIconButton>
            </Fragment>
          )]
          : [],
      }]),
    ],
    insert: [
      { key: "table", label: t("ribbon.group.table"), large: tableButton },
      {
        key: "figure",
        label: t("ribbon.group.figure"),
        rows: [
          <Fragment key="figure-1">{shapeMenuControl}{lineToolControl}</Fragment>,
          <Fragment key="figure-2">
            <EditorToolbarIconButton title={t("appMenu.insert.image")} aria-label={t("appMenu.insert.image")} onClick={() => imageInputRef.current?.click()}>
              <ImageIcon size={EDITOR_TOOLBAR_ICON_SIZE} />
            </EditorToolbarIconButton>
            {graphButton}
            {graph3DButton}
          </Fragment>,
        ],
      },
      {
        key: "text",
        label: t("ribbon.group.text"),
        rows: [
          <Fragment key="text-1">
            <EditorToolbarIconButton withText title={t("appMenu.insert.paragraph")} aria-label={t("appMenu.insert.paragraph")} onClick={() => addBlock("paragraph")}>
              <FileText size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span>{t("appMenu.insert.paragraph")}</span>
            </EditorToolbarIconButton>
            <EditorToolbarIconButton withText title={t("appMenu.insert.heading")} aria-label={t("appMenu.insert.heading")} onClick={() => addBlock("heading")}>
              <ListPlus size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span>{t("appMenu.insert.heading")}</span>
            </EditorToolbarIconButton>
            <EditorToolbarIconButton withText title={t("appMenu.insert.problem")} aria-label={t("appMenu.insert.problem")} onClick={() => addBlock("problem")}>
              <FileQuestion size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span>{t("appMenu.insert.problem")}</span>
            </EditorToolbarIconButton>
          </Fragment>,
          <Fragment key="text-2">{overlayTextButton}{materialButton}</Fragment>,
        ],
      },
      { key: "symbol", label: t("ribbon.group.symbol"), large: inlineMathControl },
    ],
    layout: [
      {
        key: "pageSetup",
        label: t("ribbon.group.pageSetup"),
        large: (
          <EditorToolbarIconButton large title={t("ribbon.pageSetup")} aria-label={t("ribbon.pageSetup")} onClick={() => setPageSettingsOpen(true)}>
            <FileCog size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
            <span>{t("ribbon.pageSetup")}</span>
          </EditorToolbarIconButton>
        ),
        // ランチャーは「同じダイアログを開く」ものにだけ付ける。押しても何も起きない
        // ランチャーは作らない。大ボタンと同名にすると strict mode で衝突するので、
        // アクセシブル名は「…ダイアログを開く」にして区別する。
        launcher: { label: t("ribbon.pageSetupLauncher"), onClick: () => setPageSettingsOpen(true) },
      },
      {
        key: "columns",
        label: t("ribbon.group.columns"),
        rows: [
          <Fragment key="columns-1">
            {[2, 3, 4].map((count) => (
              <EditorToolbarIconButton
                key={count}
                withText
                active={columnCommand.currentColumnCount === count}
                title={t("ribbon.columnsApply", { columns: count })}
                aria-label={t("ribbon.columnsApply", { columns: count })}
                aria-pressed={columnCommand.currentColumnCount === count}
                disabled={!columnCommand.enabled}
                onClick={() => applyColumnCommand(count)}
              >
                <Columns3 size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
                <span>{t("ribbon.columnsApply", { columns: count })}</span>
              </EditorToolbarIconButton>
            ))}
          </Fragment>,
          /* 解除が無いとリボンから段組を作ったあと元に戻せない（右クリック
             メニューにある既存の「段組を解除」を同じ場所へ置き直したもの）。 */
          <Fragment key="columns-2">
            <EditorToolbarIconButton
              withText
              title={t("ribbon.columnsClear")}
              aria-label={t("ribbon.columnsClear")}
              disabled={columnCommand.sectionId === null}
              onClick={() => applyColumnCommand(1)}
            >
              <Rows3 size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span>{t("ribbon.columnsClear")}</span>
            </EditorToolbarIconButton>
          </Fragment>,
        ],
      },
    ],
    view: [
      {
        key: "show",
        label: t("ribbon.group.view"),
        rows: [
          <Fragment key="show-1">
            <EditorToolbarIconButton withText title={t("ribbon.outlineTooltip")} aria-label={t("ribbon.outlineTooltip")} onClick={() => setOutlineDialogOpen(true)}>
              <ListTree size={EDITOR_TOOLBAR_TEXT_ICON_SIZE} />
              <span>{t("ribbon.outline")}</span>
            </EditorToolbarIconButton>
          </Fragment>,
          <Fragment key="show-2">{commentsToggleButton}</Fragment>,
        ],
      },
      { key: "zoom", label: t("ribbon.group.zoom"), rows: [<>{zoomOutButton}{zoomSelect}{zoomInButton}</>] },
    ],
    shapeFormat: [
      { key: "shapeStyle", label: t("ribbon.group.shapeStyle"), rows: [<>{strokeColorControl}{fillColorControl}</>] },
      {
        key: "line",
        label: t("ribbon.group.line"),
        rows: [
          <Fragment key="line-1">{lineDashButton}{lineWidthButton}</Fragment>,
          <Fragment key="line-2">{lineStartButton}{lineEndButton}</Fragment>,
        ],
      },
      {
        key: "arrange",
        label: t("ribbon.group.arrange"),
        rows: [
          <Fragment key="arrange-1">{arrangeFrontButton}{arrangeForwardButton}</Fragment>,
          <Fragment key="arrange-2">{arrangeBackwardButton}{arrangeBackButton}</Fragment>,
        ],
      },
    ],
  };

  const visibleRibbonTabs = getVisibleRibbonTabs(contextualTabVisible);
  // タブが消えた直後の1レンダーだけ active が不可視のままになりうる（state の更新は effect
  // なので1フレーム遅れる）。戻り先は lastExplicit（必ず可視タブ）に合わせて、
  // 1フレームだけ別のタブが見える瞬きを作らない。
  const activeRibbonTab = visibleRibbonTabs.includes(ribbonTabState.active)
    ? ribbonTabState.active
    : ribbonTabState.lastExplicit;
  const ribbonPanelId = `${ribbonIdPrefix}ribbon-panel`;

  // タブ行は Backstage が開いていても残る（Word と同じで、ファイルタブから戻れる）。
  // タブの並び (role="tablist") と右端のアクションは別の要素にする — tablist の直下に
  // タブでないボタンを置くと、role の意味と矢印キーの走査対象がずれる。
  const ribbonTabBar = uiLayoutPreference.mode !== "word" ? null : (
    <div className="ribbon-tabs-row">
      {/* 教材タブ（aria-label="教材タブ"）と名前が衝突しないこと。既存 e2e が
          getByRole("tab") で教材タブを掴んでいる。 */}
      <div className="ribbon-tabs" role="tablist" aria-label={t("ribbon.tablist")}>
        {visibleRibbonTabs.map((tabId, index) => (
          <button
            key={tabId}
            id={ribbonTabElementId(ribbonIdPrefix, tabId)}
            type="button"
            role="tab"
            className="ribbon-tab"
            data-contextual={tabId === "shapeFormat" ? "true" : undefined}
            // ファイルタブは Backstage の開閉そのもの。開いている間はリボン本体を
            // 描かないので、パネルを持つタブ側の aria-selected も同時に降ろす。
            aria-selected={tabId === "file" ? backstageOpen : !backstageOpen && tabId === activeRibbonTab}
            // 描かれていないパネルを指し続けない。折りたたみ中 (本体なし) は
            // aria-expanded={false} で「開けば中身が出る」ことだけを伝える。
            aria-controls={tabId === "file"
              ? (backstageOpen ? backstagePanelId : undefined)
              : (backstageOpen || ribbonBodyHidden ? undefined : ribbonPanelId)}
            aria-expanded={tabId === "file" || !ribbonCollapse.collapsed ? undefined : ribbonCollapse.overlayOpen}
            tabIndex={(tabId === "file" ? backstageOpen : !backstageOpen && tabId === activeRibbonTab) ? 0 : -1}
            onClick={() => (tabId === "file" ? toggleBackstage() : selectRibbonTab(tabId))}
            // Word はタブのダブルクリックでもリボンを開閉する。ファイルタブは
            // Backstage の開閉なので対象外 (2回押すと開いて閉じるだけ)。
            onDoubleClick={tabId === "file" ? undefined : () => toggleRibbonCollapse()}
            onKeyDown={(event) => {
              const nextIndex = resolveTabsKeyboardIndex(visibleRibbonTabs.map(() => false), index, event.key);
              if (nextIndex === null) {
                return;
              }
              event.preventDefault();
              const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']");
              tabs?.[nextIndex]?.focus();
              const nextTab = visibleRibbonTabs[nextIndex];
              // 矢印キーでファイルへ移ったときはフォーカスを移すだけにする。Backstage は
              // 開いた瞬間にフォーカスを自分の中へ奪うので、自動で開くとタブ行を
              // 矢印キーで通り抜けられなくなる（Enter / Space で開ける）。
              if (nextTab !== "file") {
                selectRibbonTab(nextTab);
              }
            }}
          >
            {t(`ribbon.tabs.${tabId}`)}
          </button>
        ))}
      </div>
      {ribbonTabActions}
      {/* 折りたたみ中の復帰導線。Word はタブ行の右端に置く。 */}
      {ribbonCollapse.collapsed && !backstageOpen && (
        <button
          type="button"
          className="ribbon-expand-button"
          title={t("ribbon.expand")}
          aria-label={t("ribbon.expand")}
          onClick={toggleRibbonCollapse}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  const ribbonBody = ribbonTabGroups === null ? null : (
    // 折りたたみ中にタブを押したときは、本体を «浮かせて» 出す (.is-overlay)。
    // クローム高さトークンは変えないので本文はその場から動かない。
    <div
      id={ribbonPanelId}
      className={`ribbon-body${ribbonCollapse.collapsed ? " is-overlay" : ""}`}
      role="tabpanel"
      aria-labelledby={ribbonTabElementId(ribbonIdPrefix, activeRibbonTab)}
    >
      {ribbonTabGroups[activeRibbonTab].map((group) => (
        <div className="ribbon-group" data-group={group.key} key={group.key}>
          <div className="ribbon-group-controls">
            {group.large && <div className="ribbon-group-large">{group.large}</div>}
            {group.rows && group.rows.length > 0 && (
              <div className="ribbon-group-rows">
                {group.rows.map((row, index) => (
                  // 段は定義順に固定で、並べ替えも出し入れもしない (index キーで安全)。
                  <div className="ribbon-group-row" key={index}>{row}</div>
                ))}
              </div>
            )}
          </div>
          <div className="ribbon-group-footer">
            <div className="ribbon-group-label">{group.label}</div>
            {group.launcher && (
              <button
                type="button"
                className="ribbon-group-launcher"
                title={group.launcher.label}
                aria-label={group.launcher.label}
                onClick={group.launcher.onClick}
              >
                <ArrowDownRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      ))}
      {/* Word と同じくリボン本体の右端。浮かせている間は「展開」がタブ行側に出るので
          こちらは出さない (同じ操作のボタンを2つ見せない)。 */}
      {!ribbonCollapse.collapsed && (
        <button
          type="button"
          className="ribbon-collapse-button"
          title={t("ribbon.collapse")}
          aria-label={t("ribbon.collapse")}
          onClick={toggleRibbonCollapse}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Word風のステータスバー (画面下端)
  //
  // Word は左に「ページ N / M」、右にズーム。ズームは表示タブと同じ element を
  // そのまま置き直す (Word も表示タブとステータスバーの両方にズームを持つ)。
  // role="status" にはしない — スクロールのたびにページ番号が変わるので、
  // ライブリージョンにすると読み上げが鳴り続ける。
  // Backstage 表示中は描かない (見えていない本文へズームが効かないように)。
  // ---------------------------------------------------------------------------
  const ribbonStatusBar = uiLayoutPreference.mode !== "word" || backstageOpen ? null : (
    <footer
      className="ribbon-statusbar"
      aria-label={t("statusBar.aria")}
      inert={versionHistoryPreviewActive || undefined}
    >
      {/* activePageNumber はスクロールでしか更新されない。AI 編集などでページが
          «スクロールせずに» 減ると N > M の一瞬が出るので、表示側で丸める。 */}
      <div className="ribbon-statusbar-pages">{t("statusBar.pages", { current: Math.min(activePageNumber, pageCount), total: pageCount })}</div>
      <div className="ribbon-statusbar-zoom">
        {zoomOutButton}
        {zoomSelect}
        {zoomInButton}
      </div>
    </footer>
  );

  const parts: EditorChromeParts = {
    documentIcon,
    documentTitleRow,
    fileMenu,
    insertMenu,
    aiMenu,
    settingsMenu,
    documentTabsRow,
    saveStateBadge,
    versionHistoryButton,
    reportIssueButton,
    menubarRightActions,
    editingGroup,
    formatGroup,
    insertGroup,
    shapeStyleGroup,
    searchGroup,
    viewGroup,
    importInput,
    otherImportInput,
    imageInput,
    ribbonTabBar,
    ribbonBody,
    ribbonBackstage,
    ribbonQat,
    ribbonTitlebarActions,
    ribbonStatusBar,
    appMenuInert: chrome.shared.versionHistoryPreviewActive,
    editingSurfaceInert: chrome.shared.versionHistoryPreviewActive,
  };

  return uiLayoutPreference.mode === "word"
    ? renderRibbonComposition(parts)
    : renderDocsComposition(parts, t);
}

function getTitleUpdateButtonLabel(state: DesktopUpdateState | null, t: Translate<"chrome">): string {
  if (state?.phase === "downloaded") {
    return t("update.restart");
  }
  if (state?.phase === "downloading") {
    return t("update.downloading", { percent: Math.round(state.progress?.percent ?? 0) });
  }
  return t("update.update");
}

function getTitleUpdateButtonTitle(state: DesktopUpdateState | null, t: Translate<"chrome">): string {
  if (state?.phase === "downloaded") {
    return t("update.restartTooltip");
  }
  if (state?.phase === "downloading") {
    return t("update.downloadingTooltip");
  }
  return state?.availableVersion
    ? t("update.available", { version: state.availableVersion })
    : t("update.update");
}
