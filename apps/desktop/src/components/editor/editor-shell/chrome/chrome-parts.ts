import type { ReactNode } from "react";

/**
 * クロームを構成する「生成済みの element」の入れ物。
 *
 * 中身は renderEditorChrome が1回の render pass でまとめて作ったもので、composition 側は
 * 並べるだけです。両クロームで同じ element を共有するための器なので、ここに関数を置かないこと
 * （関数にすると生成が別 pass に散り、overlay スタイルの描画が壊れます）。
 */
export interface EditorChromeParts {
  documentIcon: ReactNode;
  documentTitleRow: ReactNode;
  fileMenu: ReactNode;
  insertMenu: ReactNode;
  aiMenu: ReactNode;
  settingsMenu: ReactNode;
  documentTabsRow: ReactNode;
  saveStateBadge: ReactNode;
  versionHistoryButton: ReactNode;
  reportIssueButton: ReactNode;
  menubarRightActions: ReactNode;
  editingGroup: ReactNode;
  formatGroup: ReactNode;
  insertGroup: ReactNode;
  shapeStyleGroup: ReactNode;
  searchGroup: ReactNode;
  viewGroup: ReactNode;
  importInput: ReactNode;
  otherImportInput: ReactNode;
  imageInput: ReactNode;
  /** Word風リボンのタブバー（role="tablist"）。docs では描かれない。 */
  ribbonTabBar: ReactNode;
  /** Word風リボンの本体（選択中タブのグループ列）。docs では描かれない。 */
  ribbonBody: ReactNode;
  /** Word風リボンのファイルタブ = Backstage。閉じているとき・docs では null。 */
  ribbonBackstage: ReactNode;
  /** Word風のクイックアクセスツールバー（保存状態 / 元に戻す / やり直す）。docs では null。 */
  ribbonQat: ReactNode;
  /** Word風のタイトル行右端の常設アクション（ワークスペース）。docs では null。 */
  ribbonTitlebarActions: ReactNode;
  /** Word風の画面下端のステータスバー（ページ数・ズーム）。docs では null。 */
  ribbonStatusBar: ReactNode;
  appMenuInert: boolean;
  editingSurfaceInert: boolean;
}
