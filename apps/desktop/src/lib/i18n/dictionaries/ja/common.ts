/** WI-1 が所有する汎用語。どの画面からも参照してよい唯一の namespace。 */
export const common = {
  actions: {
    ok: "OK",
    cancel: "キャンセル",
    close: "閉じる",
    save: "保存",
    delete: "削除",
    add: "追加",
    edit: "編集",
    apply: "適用",
    retry: "再試行",
    back: "戻る",
    next: "次へ",
    details: "詳細",
  },
  /** ツールチップのショートカット表記 (`components/ui/Tooltip.tsx`)。 */
  shortcutAria: "ショートカット {{shortcut}}",
  /**
   * 色パレット / カラーピッカーの文言。本文ツールバー・図形ダイアログ・表ダイアログの
   * どこからも同じ部品が出るので、特定の面の namespace ではなくここに置く。
   */
  color: {
    paletteAria: "色を選択",
    standard: "標準カラー",
    custom: "カスタム",
    customEmpty: "未登録",
    create: "色を作成",
    createWithOpacity: "色と不透明度を作成",
    transparent: "透明",
    presetSimpleLight: "シンプル（明）",
    mixed: "混在",
    noFill: "塗りなし",
    opacityPercent: "不透明度 {{percent}}%",
    hue: "色相",
    saturationValue: "彩度と明度",
    saturationValueText: "彩度 {{saturation}}%、明度 {{value}}%",
    opacity: "不透明度",
    opacityInput: "不透明度 (%)",
    hex: "色コード",
    red: "赤",
    green: "緑",
    blue: "青",
  },
  status: {
    loading: "読み込み中…",
    saving: "保存中…",
    saved: "保存しました",
    error: "エラーが発生しました",
  },
} as const;
