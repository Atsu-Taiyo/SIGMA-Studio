// Word風リボンの「ファイル」タブ = Backstage ビューの開閉とセクション遷移。
//
// ribbon-tabs.ts と同じ方針で、React から切り離した純関数として持つ。Backstage は
// リボンのタブパネルではなく編集画面全体を覆う別の面なので、タブ状態
// (RibbonTabState) とは一切混ぜない — こうしておくと「Backstage を閉じたら直前に
// 自分で選んだタブへ戻る」が構造的に満たされる（戻り先を覚える処理が要らない）。

export type BackstageSectionId =
  | "home"
  | "new"
  | "open"
  | "info"
  | "export"
  | "options"
  | "help";

/** 左ナビの並び。Word 365 の Backstage（ホーム → 新規 → 開く → 情報 → …）に合わせる。 */
export const BACKSTAGE_SECTIONS: readonly BackstageSectionId[] = [
  "home",
  "new",
  "open",
  "info",
  "export",
  "options",
  "help",
];

// 表示ラベルはここには置かない。`chrome` namespace の `backstage.sections.<id>` が持ち、
// このモジュールは純粋な開閉・セクション遷移ロジックのままにする。

export interface BackstageState {
  /** Backstage が編集画面を覆っているか。 */
  open: boolean;
  /** 右側に出しているセクション。 */
  section: BackstageSectionId;
}

export const DEFAULT_BACKSTAGE_STATE: BackstageState = { open: false, section: "home" };

function keepIfUnchanged(current: BackstageState, next: BackstageState): BackstageState {
  // 参照が毎回変わると useState の bail-out が効かず、何も起きていないのに再レンダーが
  // 続く（ribbon-tabs.ts の同名関数と同じ理由）。
  return current.open === next.open && current.section === next.section ? current : next;
}

/** ファイルタブを押して開く。開き直しは必ずホームセクションから。 */
export function openBackstage(current: BackstageState): BackstageState {
  return keepIfUnchanged(current, { open: true, section: "home" });
}

/** Esc / ← / ファイルタブ再クリック / コマンド実行で閉じる。 */
export function closeBackstage(current: BackstageState): BackstageState {
  return keepIfUnchanged(current, DEFAULT_BACKSTAGE_STATE);
}

export function toggleBackstage(current: BackstageState): BackstageState {
  return current.open ? closeBackstage(current) : openBackstage(current);
}

/** 左ナビの項目を押したときの遷移。開閉は変えない。 */
export function selectBackstageSection(
  current: BackstageState,
  section: BackstageSectionId,
): BackstageState {
  return keepIfUnchanged(current, { open: current.open, section });
}

/**
 * レイアウトが Word風を離れたら閉じる。これが無いと、Backstage を開いたまま
 * Googleドキュメント風へ切り替えて戻ってきたときに全画面が残る。
 */
export function resolveBackstageStateForLayout(
  current: BackstageState,
  mode: string,
): BackstageState {
  return mode === "word" ? current : closeBackstage(current);
}

/**
 * Backstage パネルの DOM id。EditorShell 側のフォーカス移動が getElementById で
 * 同じ id を引くので、組み立て方はここだけに置く（接頭辞は useId 由来で、SDK が
 * 1ページに EditorShell を2つ埋め込んでも衝突しない）。
 */
export function ribbonBackstagePanelId(prefix: string): string {
  return `${prefix}ribbon-backstage`;
}
