import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * ネイティブ undo / redo が ProseMirror 所有の DOM を書き換えるのを構造的に止める。
 *
 * PM は `undoRedo: false` で作っていて履歴は SigmaDoc 側にあるので、Blink の
 * `historyUndo` を誰も止めていなかった。`UndoStep::Unapply()` は編集ホストへ
 * `beforeinput` (`inputType: "historyUndo"`) を **cancelable で**投げてから undo を
 * 適用するので、ここで `preventDefault()` すればネイティブ undo が PM 所有 DOM を
 * 触ることは原理的に無くなる。IME 合成中も含め、**止めるのは無条件**。
 *
 * **位置づけ: WI-1 (メニューの ⌘Z を自前 click へ配る) が主で、これは多層防御。**
 * 右クリックのコンテキストメニュー、トラックパッドの 3 本指スワイプ、支援技術、
 * 将来 main プロセスから `webContents.undo()` を呼ぶコード —— 入口はメニュー以外にも
 * 残るので、本文側でも受け止める。
 *
 * **限界 (これだけでは足りない理由)**: Blink の UndoStep は打鍵時点の DOM Position を
 * 保持する。PM が `setContent` でノードを作り直したあとの UndoStep は**切り離された
 * ノード**を指しており、その場合 `beforeinput` は生きた editing host に届かない。
 * つまりここが救えるのは「PM の DOM がまだ生きているケース」だけ。
 *
 * **合成分岐の限界 (実装は変えない — 変換中に文書を差し替えない判断のほうが重要)**:
 * - `view.composing` は `compositionend` の約 20ms 後に非同期でクリアされる。その窓に
 *   入ったネイティブ undo は **止まるが何も起こさない** (IME 確定直後の 1 回が黙って
 *   飲まれる)。
 * - 合成中の分岐は何のフィードバックも出さない。他の undo 経路が `status.undone` /
 *   `status.nothingToUndo` を出すのに対し、ここだけ無音になる。
 *
 * 受け渡しは window の CustomEvent で行い、**`components/editor` を import しない**
 * (`components/tiptap` → `components/editor` の逆流を作らない)。
 * 先例は `inline-math-extension.tsx` の `requestInlineMathEdit`。
 */
export const NATIVE_HISTORY_COMMAND_EVENT = "sigma-studio:native-history-command";

export type NativeHistoryDirection = "undo" | "redo";

export interface NativeHistoryCommandDetail {
  direction: NativeHistoryDirection;
}

export interface NativeHistoryGuardOptions {
  /**
   * 止めたネイティブ履歴操作の振り向け先。
   *
   * 既定は `NATIVE_HISTORY_COMMAND_EVENT` を window へ投げる (受け口は `EditorShell`)。
   * 自前の履歴を持つ面 (`BoxTitleEditor`) だけ `editor.commands.undo()` へ差し替える。
   *
   * **共通エンジンを通る面で差し替えたいときは、2 つ目を積まずに配列の中身を置き換える。**
   * `PluginKey` が重複するとエディタ生成時に "Adding different instances of a keyed plugin"
   * で落ちる (キーを外して黙って先勝ちにするより、その場で気づけるほうがよい)。
   *
   * **戻り値は `preventDefault()` を左右しない。** ネイティブ undo は常に止める —
   * 戻す先が無いときに素通しすると、PM 所有の DOM を外から書き換えられるという
   * 塞ぎたい穴がそのまま残るため。戻り値が決めるのは ProseMirror へ「処理済み」と
   * 返すかどうかだけ。
   */
  onHistoryCommand: (direction: NativeHistoryDirection, editor: Editor) => boolean;
}

/**
 * `Map` を使うのは、オブジェクトリテラルの添字引きだと `inputType` が `"constructor"` や
 * `"toString"` のときに **prototype の値が truthy で返ってしまう**から
 * (`inputType` はイベント側から来る文字列なので、素通しできない)。
 */
const HISTORY_INPUT_TYPES = new Map<string, NativeHistoryDirection>([
  ["historyUndo", "undo"],
  ["historyRedo", "redo"],
]);

const nativeHistoryGuardKey = new PluginKey("nativeHistoryGuard");

export const NativeHistoryGuardExtension = Extension.create<NativeHistoryGuardOptions>({
  name: "nativeHistoryGuard",

  addOptions() {
    return {
      onHistoryCommand: (direction: NativeHistoryDirection) => {
        if (typeof window === "undefined") {
          return false;
        }
        window.dispatchEvent(new CustomEvent<NativeHistoryCommandDetail>(
          NATIVE_HISTORY_COMMAND_EVENT,
          { detail: { direction } },
        ));
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const onHistoryCommand = this.options.onHistoryCommand;
    return [
      new Plugin({
        key: nativeHistoryGuardKey,
        props: {
          handleDOMEvents: {
            // PM の `initInput` は自前の handler より先に `runCustomHandler` を通すので、
            // ここが `beforeinput` の最初の受け口になる。
            beforeinput: (view, event) => {
              const inputEvent = event as InputEvent;
              const direction = HISTORY_INPUT_TYPES.get(inputEvent.inputType);
              if (!direction) {
                return false;
              }
              // **合成中でもネイティブ undo は必ず止める。** ここを素通しすると
              // `UndoStep::Unapply()` が PM 所有 DOM を裏で書き換え、この拡張が存在する
              // 理由そのものの穴が「合成中だけ」開く。
              inputEvent.preventDefault();
              // ただし未確定の合成があるうちは振り向けない (合成中に文書を差し替えると
              // 合成セッションごと壊れる)。**止めるが、何もしない**に倒す。
              //
              // 合成判定に `InputEvent.isComposing` は使えない — あれは Blink が合成中に
              // 生成した input イベントにしか立たず、OS 由来の historyUndo には立たない。
              // PM 自身の合成状態を見る (先例: `TextFlowEditor.tsx` の `editor.view.composing`)。
              if (view.composing) {
                return true;
              }
              return onHistoryCommand(direction, editor);
            },
          },
        },
      }),
    ];
  },
});
