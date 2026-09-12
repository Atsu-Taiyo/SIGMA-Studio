import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * コマンドパレットが開いている間は、本文側のショートカットを止める。
 *
 * パレットは検索欄に文字を打ち込む面なので、止めないと `b` や `p` のような
 * 単キーコマンドが**入力しながら発火する**。EditorShell の 2 つの keydown リスナーは
 * 「前に出ている面の open フラグを 1 つずつ列挙して降りる」方式なので、
 * 列挙とその依存配列の両方に載っているかをここで固定する
 * (`ribbon-backstage-shortcut-suppression.test.ts` と同じ形)。
 */
const source = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
const routingSource = readFileSync(new URL("./editor-shell/use-editor-command-routing.ts", import.meta.url), "utf8");
const paletteSource = readFileSync(new URL("./editor-shell/use-command-palette.tsx", import.meta.url), "utf8");

/** 対象リスナーを登録している useEffect の本文 (条件式 + 依存配列) を切り出す。 */
function shortcutEffectSource(handlerName: string): string {
  const owner = handlerName === "handleCommandShortcut" ? routingSource : source;
  const start = owner.indexOf(`const ${handlerName} = (`);
  const removal = owner.indexOf(`window.removeEventListener("keydown", ${handlerName}`, start);
  const end = owner.indexOf("]);", removal);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return owner.slice(start, end);
}

describe("EditorShell のコマンドパレット中のキー入力抑止", () => {
  it("パレットのフラグが共有の抑止条件に入っている", () => {
    // WI-5 で、`handleCommandShortcut` の列挙は `isModalSurfaceOpen` へまとめた
    // (**ネイティブメニュー経路と同じ抑止を使うため** — 片方だけに書くと、メニューが
    // パレットを飛び越えて背後の文書を戻す)。フラグはそちらに載っていればよい。
    const guard = source.slice(
      source.indexOf("const isModalSurfaceOpen ="),
      source.indexOf(";", source.indexOf("const isModalSurfaceOpen =")),
    );
    expect(guard).toContain("commandPaletteOpen");
  });

  it.each(["handleCommandShortcut", "handleInlineShortcut"])(
    "%s の抑止条件と依存配列にパレットが入っている",
    (handlerName) => {
      const effect = shortcutEffectSource(handlerName);
      // 条件式で1回、依存配列で1回。並び順や整形には依存させない。
      // `handleCommandShortcut` は共有ガード越しなので、その名前で同じことを見る。
      const flag = handlerName === "handleCommandShortcut" ? "isModalSurfaceOpen" : "commandPaletteOpen";
      expect(effect.split(flag).length - 1).toBeGreaterThanOrEqual(2);
    },
  );

  it("パレットを開くコマンドがパレット自身の候補には出ない", () => {
    // 開いている状態でもう一度「コマンドパレット」が並ぶのは無意味なうえ、
    // Enter で自分を開き直して閉じられなくなる。
    expect(paletteSource).toContain('hiddenCommandIds: ["view.commandPalette"]');
  });

  it("パレットから設定へ飛ぶときは WI-3 の配線を使う", () => {
    // `focusEntryId` を渡すだけでスクロールとハイライトが動く。
    expect(paletteSource).toContain("setSettingsFocusEntryId(entry.id)");
    expect(source).toContain("focusEntryId={settingsFocusEntryId}");
    // anchor id を EditorShell が直接知り始めたら、カタログを唯一の索引源にした意味が消える
    // (`.page-settings-dialog` のような **class** セレクタは別物なので id 形だけを見る)。
    expect(source).not.toMatch(/id="(?:desktop-settings|page-settings|ai-settings|command-shortcuts|custom-command|tex-preamble)-/u);
  });
});
