import type {
  Dispatch,
  ReactElement,
  RefObject,
  SetStateAction,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { SelectedInlineMath } from "@/components/editor/EditorSettings";
import type { FontFamilyGroup } from "@/components/editor/editor-shell/constants";
import type { DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import type {
  BlockStyleCommandValue,
  BlockStyleToolbarState,
} from "@/components/editor/editor-shell/toolbar-formatting";
import type { ColorStylePanel, EditorMenu } from "@/components/editor/editor-shell/types";
import type { ShapeGallerySection } from "@/components/editor/overlay-canvas/shape-gallery";
import type { SharedFillState } from "@/components/editor/overlay-canvas/style-patch";
import type { OverlayPoint, OverlayTool } from "@/components/editor/overlay-canvas/types";
import type { OverlayArrangeAction, OverlayCommand, OverlaySelectionStylePatch, OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import type { TooltipContent } from "@/components/ui/Tooltip";
import type { BoxedVariant, InlineNode, SigmaBlock, SigmaDocument, TextAlign } from "@/features/document";
import type { OverlayDash, OverlayTextSize } from "@/features/document/overlay-model";
import type { ResolvedDocumentTitle } from "@/lib/document-title";
import type { Translate } from "@/lib/i18n";
import type { EditorCommandId } from "@/lib/editor-command-shortcuts";
import type { Graph2DPreset } from "@/lib/graph2d";
import type { DocumentMetadata } from "@/lib/storage";
import type { UiLayoutPreference } from "@/lib/ui-layout-preference";
import type { DesktopUpdateState } from "@/types/desktop";
import type { LucideIcon } from "lucide-react";

import type { ColumnCommandState } from "./layout-commands";
import type { BackstageSectionId, BackstageState } from "./ribbon-backstage";
import type { RibbonCollapseState, RibbonPanelTabId, RibbonTabState } from "./ribbon-tabs";

/**
 * EditorShell のクロームが必要とする state / ref / ハンドラを、バケットに束ねて渡すための型。
 *
 * フィールド名は EditorShell 内のローカル変数名と一致させてある。組み立て側で shorthand が効き、
 * リネーム由来の取り違えが起きないため。値は毎レンダー素の object literal で作る（useMemo は使わない）。
 */

/** ツールチップとショートカット表示。全グループが使う。 */
export interface EditorChromeCommands {
  commandTooltip: (label: string, commandId: EditorCommandId) => TooltipContent;
  renderMenuShortcut: (commandId: EditorCommandId) => ReactElement | null;
}

/** 「他のポップオーバーを閉じる」setter 群。呼び出し箇所ごとに閉じる集合が違う（例: 囲み文字は font-family と line-width を閉じない）ため、
   * 束ねるだけで統一はしない。統一は挙動変更になるので follow-up。 */
export interface EditorChromeToolbarMenus {
  setActiveMenu: Dispatch<SetStateAction<EditorMenu>>;
  setBoxedTextMenuOpen: Dispatch<SetStateAction<boolean>>;
  setColorStylePanel: Dispatch<SetStateAction<ColorStylePanel>>;
  setBlockStyleMenuOpen: Dispatch<SetStateAction<boolean>>;
  setFontFamilyMenuOpen: Dispatch<SetStateAction<boolean>>;
  setFontSizeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLineDashMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLineEndpointMenu: Dispatch<SetStateAction<"start" | "end" | null>>;
  setLineHeightMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLineToolMenuOpen: Dispatch<SetStateAction<boolean>>;
  setLineWidthMenuOpen: Dispatch<SetStateAction<boolean>>;
  setShapeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setTextAlignMenuOpen: Dispatch<SetStateAction<boolean>>;
}

/** 2つ以上のグループから参照される値。どれか1つのバケットに置くと嘘になるのでここへ集める。 */
export interface EditorChromeShared {
  activeMenu: EditorMenu;
  /**
   * クロームの文言解決。`renderEditorChrome` は React コンポーネントではないので
   * hook を呼べず、`t` は必ずここを通して渡す (chrome namespace 固定・キーは ns 相対)。
   */
  t: Translate<"chrome">;
  /**
   * 図形ギャラリーと線ツールの一覧。**組み立て済みを受け取る。**
   * `renderEditorChrome` は打鍵ごとに走るので、ここで builder を呼ぶと
   * ポップオーバーが閉じていても毎回 29 回の辞書引きが起きる (code-review 指摘)。
   * 中身は言語が変わったときだけ変わるので、シェル側で memo 化する。
   */
  shapeGallerySections: ShapeGallerySection[];
  lineToolItems: Array<{ command: OverlayCommand; label: string; icon: LucideIcon }>;
  aiDocumentWriteInProgress: boolean;
  colorStylePanel: ColorStylePanel;
  document: SigmaDocument;
  getActiveTextTarget: () => "document" | "overlay" | "comment";
  imageInputRef: RefObject<HTMLInputElement | null>;
  insertInlineMath: (tex: string, target?: "document" | "overlay" | "comment", edit?: boolean) => void;
  isDesktopApp: boolean;
  isEmbedded: boolean;
  versionHistoryPreviewActive: boolean;
  runEditCommand: (command: "bold" | "italic" | "underline" | "boxed" | "undo" | "redo") => void;
  runOverlayCommand: (command: OverlayCommand, graphPreset?: Graph2DPreset) => void;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  toggleMenu: (menu: NonNullable<EditorMenu>) => void;
}

/** 編集グループ（元に戻す / やり直す / 素材）。 */
export interface EditorChromeEditing {
  setMaterialLibraryOpen: Dispatch<SetStateAction<boolean>>;
}

/** 書式グループ。 */
export interface EditorChromeFormat {
  ActiveTextAlignIcon: LucideIcon;
  activeFontFamilyLabel: string;
  activeTextAlignOption: { value: TextAlign; icon: LucideIcon; };
  /** 現在の実効サイズ。混在選択では先頭のサイズ。 */
  activeTextFontSize: number;
  activeTextFontSizeMixed: boolean;
  applyBoxedTextPaddingY: (paddingY: number) => void;
  applyInlineFormat: (command: "color" | "backgroundColor" | "fontFamily" | "fontSize" | "lineHeight" | "boxedPaddingY" | "boxedVariant", value: string) => void;
  applyLineHeight: (nextLineHeightValue: string, options?: { updateInput?: boolean; }) => boolean;
  applyBlockStructure: (value: BlockStyleCommandValue) => void;
  applyTextAlign: (align: TextAlign) => void;
  applyTextStyle: (style: string) => void;
  /** 箇条書き / 番号付き / 引用 / コードのトグル状態 (キャレットの居場所の写し)。 */
  blockStyleState: BlockStyleToolbarState;
  boldActive: boolean;
  boxedTextActive: boolean;
  boxedTextButtonRef: RefObject<HTMLButtonElement | null>;
  boxedTextMenuOpen: boolean;
  boxedTextPaddingY: number;
  boxedTextVariant: BoxedVariant;
  blockStyleButtonRef: RefObject<HTMLButtonElement | null>;
  blockStyleMenuOpen: boolean;
  canUseLineHeight: boolean;
  canUseTextAlign: boolean;
  canUseBlockStructure: boolean;
  canUseTextBlockStyle: boolean;
  canUseTextToolbar: boolean;
  fontFamily: string;
  fontFamilyButtonRef: RefObject<HTMLButtonElement | null>;
  fontFamilyIsKnownOption: boolean;
  fontFamilyIsMixed: boolean;
  fontFamilyMenuOpen: boolean;
  fontFamilyQuery: string;
  fontSizeButtonRef: RefObject<HTMLButtonElement | null>;
  fontSizeMenuOpen: boolean;
  fontSizeInput: string;
  fontSizeInputInvalid: boolean;
  setFontSizeInput: Dispatch<SetStateAction<string>>;
  setFontSizeInputInvalid: Dispatch<SetStateAction<boolean>>;
  handleLineHeightStepClick: (event: MouseEvent<HTMLButtonElement>, direction: "increase" | "decrease") => void;
  italicActive: boolean;
  lineHeight: string;
  lineHeightButtonRef: RefObject<HTMLButtonElement | null>;
  lineHeightCustomOpen: boolean;
  lineHeightInput: string;
  lineHeightInputError: string | null;
  lineHeightMenuOpen: boolean;
  moreBlocksMenuButtonRef: RefObject<HTMLButtonElement | null>;
  moreBlocksMenuOpen: boolean;
  setMoreBlocksMenuOpen: Dispatch<SetStateAction<boolean>>;
  orderedListMenuButtonRef: RefObject<HTMLButtonElement | null>;
  orderedListMenuOpen: boolean;
  setOrderedListMenuOpen: Dispatch<SetStateAction<boolean>>;
  saveEditorFontFamilyPreference: (nextFontFamily: string) => void;
  selectBoxedTextVariant: (variant: BoxedVariant) => void;
  selectedTextAlign: TextAlign;
  selectedTextStyle: string;
  setFontFamily: Dispatch<SetStateAction<string>>;
  setFontFamilyQuery: Dispatch<SetStateAction<string>>;
  setLineHeightCustomOpen: Dispatch<SetStateAction<boolean>>;
  setLineHeightInput: Dispatch<SetStateAction<string>>;
  setLineHeightInputError: Dispatch<SetStateAction<string | null>>;
  setTextBackgroundColor: Dispatch<SetStateAction<string | null>>;
  setTextColor: Dispatch<SetStateAction<string>>;
  setTextFontSize: Dispatch<SetStateAction<number | null>>;
  startLineHeightStepping: (event: ReactPointerEvent<HTMLButtonElement>, direction: "increase" | "decrease") => void;
  stopLineHeightStepping: () => void;
  textAlignButtonRef: RefObject<HTMLButtonElement | null>;
  textAlignMenuOpen: boolean;
  textBackgroundColor: string | null;
  textBackgroundColorButtonRef: RefObject<HTMLButtonElement | null>;
  textColor: string;
  textColorButtonRef: RefObject<HTMLButtonElement | null>;
  toggleBoxedText: () => void;
  underlineActive: boolean;
  visibleCustomFontOptions: { label: string; value: string; }[];
  visibleFontFamilyGroups: FontFamilyGroup[];
}

/** 挿入グループ。 */
export interface EditorChromeInsert {
  ActiveLineToolIcon: LucideIcon;
  activeLineToolItem: { command: OverlayCommand; label: string; icon: LucideIcon; };
  activeOverlayTool: OverlayTool;
  bodyToolbarLockedByAi: boolean;
  cancelInlineMathMenuClose: () => void;
  inlineMathButtonRef: RefObject<HTMLButtonElement | null>;
  inlineMathMenuOpen: boolean;
  lineToolMenuButtonRef: RefObject<HTMLButtonElement | null>;
  lineToolMenuOpen: boolean;
  openInlineMathMenu: () => void;
  scheduleInlineMathMenuClose: () => void;
  selectedInlineMath: SelectedInlineMath | null;
  selectedInlineMathDetails: SelectedInlineMath | null;
  setInlineMathMenuOpen: Dispatch<SetStateAction<boolean>>;
  shapeMenuButtonRef: RefObject<HTMLButtonElement | null>;
  shapeMenuOpen: boolean;
  startInlineMathFromToolbar: () => void;
}

/** 図形スタイルグループ。 */
export interface EditorChromeShapeStyle {
  applyOverlayStyle: (style: OverlaySelectionStylePatch) => void;
  arrangeOverlayShapes: (action: OverlayArrangeAction) => void;
  canArrangeOverlayShapes: boolean;
  canUseFillStyleControls: boolean;
  canUseLineEndpointControls: boolean;
  canUseLineStyleControls: boolean;
  canUseStrokeStyleControls: boolean;
  effectiveLineDashMenuOpen: boolean;
  effectiveLineEndpointMenu: "start" | "end" | null;
  effectiveLineWidthMenuOpen: boolean;
  fillColorButtonRef: RefObject<HTMLButtonElement | null>;
  fillColorPatch: (color: string) => OverlaySelectionStylePatch;
  lineDashButtonRef: RefObject<HTMLButtonElement | null>;
  lineWidthButtonRef: RefObject<HTMLButtonElement | null>;
  overlaySelection: OverlaySelectionSummary;
  selectedOverlayLineDash: OverlayDash | null;
  selectedOverlayLineSize: OverlayTextSize | null;
  selectionFill: SharedFillState;
  selectionFillColor: string | null;
  selectionFillOpacity: number;
  setStrokeColor: Dispatch<SetStateAction<string | null>>;
  strokeColor: string | null;
  strokeColorButtonRef: RefObject<HTMLButtonElement | null>;
}

/** 検索置換グループ。 */
export interface EditorChromeSearch {
  findNext: () => void;
  findPrevious: () => void;
  overlayEditing: boolean;
  replaceAll: () => void;
  replaceNext: () => void;
  replaceOpen: boolean;
  replaceText: string;
  searchButtonRef: RefObject<HTMLButtonElement | null>;
  searchMatchCount: number;
  searchOpen: boolean;
  searchQuery: string;
  setReplaceOpen: Dispatch<SetStateAction<boolean>>;
  setReplaceText: Dispatch<SetStateAction<string>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
}

/** 表示と出力グループ。 */
export interface EditorChromeView {
  applyZoom: (nextZoomInput: number | ((current: number) => number), anchor?: { clientX: number; clientY: number; }) => void;
  /** スクロール位置から導かれる現在ページ。1 始まり。 */
  activePageNumber: number;
  /** 描画されたページ総数。真値は PageCanvasEditor の layoutViewState.pageCount。 */
  pageCount: number;
  zoom: number;
  zoomOptions: readonly [10, 15, 25, 33, 50, 67, 75, 90, 100, 125, 150, 200, 300, 400, 600, 800] | number[];
}

/** メニューバー行（タイトル・アプリメニュー・教材タブ・保存状態・右側アクション・隠しinput）。 */
export interface EditorChromeAppMenu {
  activeDocumentOpenFailure: DocumentOpenFailure | null;
  activeFileId: string;
  addBlock: (type: SigmaBlock["type"]) => void;
  aiMenuButtonRef: RefObject<HTMLButtonElement | null>;
  appUpdateState: DesktopUpdateState | null;
  closeDocumentTab: (fileId: string) => Promise<void>;
  commitDocumentTitle: () => Promise<void>;
  commentsPanelOpen: boolean;
  createDocumentTab: () => Promise<void>;
  createWhiteboardDocumentTab: () => Promise<void>;
  /** 教材をクリップボードのテキストとして書き出す。 */
  copyDocumentText: () => Promise<void>;
  degradedWatcherScopes: ("library" | "mcpProposal" | "documents")[];
  deleteActiveDocument: () => Promise<void>;
  documentMetadatas: DocumentMetadata[];
  documentTitle: ResolvedDocumentTitle;
  duplicateActiveDocument: () => Promise<void>;
  exportJson: () => Promise<void>;
  exportMenuOpen: boolean;
  fileMenuButtonRef: RefObject<HTMLButtonElement | null>;
  handleTitleUpdateAction: () => Promise<void>;
  importDocumentFile: (file: File) => Promise<void>;
  importInputRef: RefObject<HTMLInputElement | null>;
  insertMenuButtonRef: RefObject<HTMLButtonElement | null>;
  loadingFileId: string | null;
  newDocButtonRef: RefObject<HTMLButtonElement | null>;
  newDocMenuOpen: boolean;
  openCommandSettings: () => void;
  openDocumentInWorkspace: (fileId: string, options?: { nextOpenFileIds?: string[]; status?: string; saveCurrent?: boolean; }) => Promise<void>;
  openDocumentListDialog: () => Promise<void>;
  openDocumentTabs: { fileId: string; title: string; updatedAt: string; }[];
  openImportDialog: () => void;
  openNewDocMenu: () => void;
  openOtherImportDialog: () => void;
  openPrintPreview: () => void;
  /** 貼り付けたテキストから教材を取り込む面を開く。 */
  openTextImportDialog: () => void;
  otherImportInputRef: RefObject<HTMLInputElement | null>;
  openWorkspaceScreen: () => Promise<void>;
  openVersionHistory: () => void;
  versionHistoryOpen: boolean;
  promoteAiToSidebar: () => void;
  reportIssue: () => void;
  requestOverlayImages: (files: ArrayLike<File> | Iterable<File>, point?: OverlayPoint) => void;
  resolvedDocumentTitle: string;
  scheduleCloseNewDocMenu: () => void;
  setAiSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setDesktopSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setExportMenuOpen: Dispatch<SetStateAction<boolean>>;
  setNewDocMenuOpen: Dispatch<SetStateAction<boolean>>;
  setOutlineDialogOpen: Dispatch<SetStateAction<boolean>>;
  setOverlayEditing: Dispatch<SetStateAction<boolean>>;
  setPageSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setTemplateGalleryOpen: Dispatch<SetStateAction<boolean>>;
  setTexCommandReferenceOpen: Dispatch<SetStateAction<boolean>>;
  setTexEnvironmentSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setTitleInputFocused: Dispatch<SetStateAction<boolean>>;
  settingsMenuButtonRef: RefObject<HTMLButtonElement | null>;
  showRichTitle: boolean;
  showTitleUpdateButton: boolean;
  titleInputValue: string;
  titleRichNodes: InlineNode[] | null;
  titleUpdateButtonDisabled: boolean;
  toggleCommentsPanel: () => void;
  uiLayoutPreference: UiLayoutPreference;
  updateMetadata: (metadata: SigmaDocument["metadata"]) => void;
  updateUiLayoutPreference: (patch: Partial<UiLayoutPreference>) => void;
}

/** Word風リボン専用。docs クロームでは1つも読まれない。 */
export interface EditorChromeRibbon {
  /** コンテキストタブ（図形の書式）を出すか。= hasOverlaySelection || overlayEditing */
  contextualTabVisible: boolean;
  ribbonTabState: RibbonTabState;
  /** タブを選ぶ。アンカーが unmount するので、開いているポップオーバーも閉じる。 */
  selectRibbonTab: (tab: RibbonPanelTabId) => void;
  /** ファイルタブ = Backstage（編集画面を覆う全画面）の状態。 */
  backstage: BackstageState;
  /** ファイルタブのクリック。開いていれば閉じる。 */
  toggleBackstage: () => void;
  /** Esc / ←、および Backstage 内のコマンド実行で閉じる。 */
  closeBackstage: () => void;
  /** 左ナビの項目を選ぶ。開閉は変えない。 */
  selectBackstageSection: (section: BackstageSectionId) => void;
  /** リボン本体の折りたたみ。collapsed は永続、overlayOpen は一時。 */
  ribbonCollapse: RibbonCollapseState;
  /** `∧` / `∨` / Ctrl+F1 / タブのダブルクリック。 */
  toggleRibbonCollapse: () => void;
  /** タブ/パネルの id 接頭辞。SDK が1ページに2つ埋め込んでも衝突しないよう useId 由来。 */
  ribbonIdPrefix: string;
  columnCommand: ColumnCommandState;
  /**
   * 選択中ブロックを columnCount 段にする。すでに段組の中なら段数を変え、
   * columnCount が 1 なら段組を解除する。
   */
  applyColumnCommand: (columnCount: number) => void;
}

export interface EditorChromeValue {
  commands: EditorChromeCommands;
  toolbarMenus: EditorChromeToolbarMenus;
  shared: EditorChromeShared;
  editing: EditorChromeEditing;
  format: EditorChromeFormat;
  insert: EditorChromeInsert;
  shapeStyle: EditorChromeShapeStyle;
  search: EditorChromeSearch;
  view: EditorChromeView;
  appMenu: EditorChromeAppMenu;
  ribbon: EditorChromeRibbon;
}
