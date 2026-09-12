// クロームの「並べ方」だけを持つファイル。
//
// ここに来る時点で各パーツの JSX は **すでに生成済みの element** です（renderEditorChrome が
// ローカル const として1回だけ作る）。この関数が作るのは <header> / .menubar-row / <nav> /
// EditorToolbar といったラッパだけで、パーツの JSX は一切作りません。
// WI-4 のリボンはこのファイルに renderRibbonComposition を足し、同じ parts を別の並びで置きます。

import { EditorToolbar, EditorToolbarSeparator } from "@/components/editor/EditorToolbar";
import type { Translate } from "@/lib/i18n";

import type { EditorChromeParts } from "./chrome-parts";

/** Googleドキュメント風。DOM・class・aria・順序は現行と同一（WI-2 の署名 e2e が固定）。 */
export function renderDocsComposition(parts: EditorChromeParts, t: Translate<"chrome">) {
  return (
    <header className="editor-menubar">
      <div className="menubar-row">
        <div className="brand">
          {parts.documentIcon}
          {parts.documentTitleRow}
          <nav
            className="app-menu-list"
            aria-label={t("appMenu.aria")}
            inert={parts.appMenuInert || undefined}
          >
            {parts.fileMenu}
            {parts.insertMenu}
            {parts.aiMenu}
            {parts.settingsMenu}
          </nav>

          {parts.documentTabsRow}
        </div>

        {parts.saveStateBadge}

        {parts.versionHistoryButton}

        {parts.reportIssueButton}

        {parts.menubarRightActions}
      </div>

      <EditorToolbar ariaLabel={t("toolbar.aria")} inert={parts.editingSurfaceInert || undefined}>
        {parts.editingGroup}
        {parts.formatGroup}

        <EditorToolbarSeparator />

        {parts.insertGroup}
        {parts.shapeStyleGroup}
        {parts.searchGroup}
        {parts.viewGroup}
      </EditorToolbar>

      {parts.importInput}
      {parts.otherImportInput}
      {parts.imageInput}
    </header>
  );
}

/**
 * Word風リボン。
 *
 * タイトル行は Word 365 の並びに組み直す: 左端アイコン → クイックアクセスツールバー
 * （保存状態 / 元に戻す / やり直す）→ 中央に教材タイトル → 右端に常設アクション
 * （ワークスペース）。中身の element は docs と同じものをそのまま置き直しているだけで、
 * 新しいボタンは作っていない。その下の1段ツールバーはタブバー + リボン本体に差し替える。
 *
 * アプリメニューと「問題を報告」は描かない — Backstage（ファイルタブ）へ置き直してある。
 * 一方 ワークスペース は Word のタイトルバー常設アクションとして **意図的に**
 * Backstage（ホーム / 開く）と二重に置いている（Word 自身が同じコマンドを Backstage と
 * リボンの両方に置く）。同時に可視にならないよう、Backstage を開いている間はタイトル行・
 * タブ行のコマンドを出さない（editor-chrome.tsx の backstageOpen ガード）。
 * Word風の e2e は必ず .ribbon-qat / .ribbon-titlebar-actions / .ribbon-tab-actions /
 * .ribbon-body / .ribbon-backstage のいずれかでスコープすること。
 *
 * Backstage は <header> の外・`.app-shell` の中に置く（`position: fixed` で編集画面を覆う）。
 * body portal へ出すと ribbon-chrome.css のセレクタ（すべて .app-shell[data-ui-layout="word"]
 * 始まり）が1つも当たらない。
 */
// Word 風の並びは aria-label を持たないので t は要らない (文言は parts 側で解決済み)。
export function renderRibbonComposition(parts: EditorChromeParts) {
  return (
    <>
      <header className="editor-menubar">
        <div className="menubar-row">
          {/* .brand は display: contents なので、この中身がそのまま .menubar-row の
              grid item になる（配置は ribbon-chrome.css の word スコープで決める）。
              保存状態バッジは QAT の中へ入れ子にしたので、ここには直接置かない。 */}
          <div className="brand">
            {parts.documentIcon}
            {parts.ribbonQat}
            {parts.documentTitleRow}

            {parts.documentTabsRow}
          </div>

          {parts.ribbonTitlebarActions}
        </div>

        <div className="ribbon-editing-surface" inert={parts.editingSurfaceInert || undefined}>
          {parts.ribbonTabBar}
          {parts.ribbonBody}
        </div>

        {parts.importInput}
        {parts.otherImportInput}
        {parts.imageInput}
      </header>

      {parts.ribbonBackstage}

      {/* 画面下端。`.app-shell` の3本目のトラックに置く (CSS で grid-row: 3 を明示)。
          DOM 順は header → backstage → statusbar → main だが、行を明示してあるので
          自動配置で main が押し出されることはない。 */}
      {parts.ribbonStatusBar}
    </>
  );
}
