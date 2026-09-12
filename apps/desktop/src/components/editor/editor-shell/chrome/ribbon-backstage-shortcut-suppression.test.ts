import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Backstage は編集画面を覆うが、フォーカスが載るのは <button> なので
// OverlayCanvasEditorClient の window keydown（bubble）から見ると「本文でも入力欄でもない」
// 状態になり、Delete や矢印キーが図形へ素通りする。EditorShell 側の2つのショートカット
// リスナーも同じ穴を持つ（ダイアログの open フラグを1つずつ列挙して塞ぐ方式）。
// 実挙動は e2e で見るが、抑止条件・依存配列・capture ガードが揃っていることはここで固定する。
// onboarding-shortcut-suppression.test.ts と同じ形。
const source = readFileSync(
  new URL("../../EditorShell.tsx", import.meta.url),
  "utf8",
);
const routingSource = readFileSync(new URL("../use-editor-command-routing.ts", import.meta.url), "utf8");

// window の capture リスナーは「同じ window に付いた別の capture リスナー」を
// 止められない（止められるのは stopImmediatePropagation だけで、それは他人の
// リスナーまで巻き添えにする）。<main inert> も window レベルには効かない。
// したがって window capture に張っている本文側のショートカットは、フラグを
// 受け取って自分で降りる必要がある。
const pageCanvasEditorSource = readFileSync(
  new URL("../../PageCanvasEditor.tsx", import.meta.url),
  "utf8",
);

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

describe("EditorShell の Backstage 中のキー入力抑止", () => {
  it("Backstage のフラグが共有の抑止条件に入っている", () => {
    // WI-5 で、`handleCommandShortcut` の列挙は `isModalSurfaceOpen` へまとめた
    // (**ネイティブメニュー経路と同じ抑止を使うため**)。フラグはそちらに載っていればよい。
    const guard = source.slice(
      source.indexOf("const isModalSurfaceOpen ="),
      source.indexOf(";", source.indexOf("const isModalSurfaceOpen =")),
    );
    expect(guard).toContain("ribbonBackstageOpen");
  });

  it.each(["handleCommandShortcut", "handleInlineShortcut"])(
    "%s の抑止条件と依存配列に Backstage が入っている",
    (handlerName) => {
      const effect = shortcutEffectSource(handlerName);
      // 条件式で1回、依存配列で1回。並び順や整形には依存させない。
      // `handleCommandShortcut` は共有ガード越しなので、その名前で同じことを見る。
      const flag = handlerName === "handleCommandShortcut" ? "isModalSurfaceOpen" : "ribbonBackstageOpen";
      expect(effect.split(flag).length - 1).toBeGreaterThanOrEqual(2);
    },
  );

  it("本文側の window capture ショートカットもフラグで降りる", () => {
    // 条件式で1回、依存配列で1回。
    const start = pageCanvasEditorSource.indexOf("const handleShortcutKeyDown = (");
    expect(start).toBeGreaterThan(-1);
    const effect = pageCanvasEditorSource.slice(
      start,
      pageCanvasEditorSource.indexOf("]);", start),
    );
    expect(effect).toContain('window.addEventListener("keydown", handleShortcutKeyDown, true)');
    expect(effect.split("shortcutsSuppressed").length - 1).toBeGreaterThanOrEqual(2);
    // EditorShell が実際に渡していること（prop を足しただけで配線し忘れる事故を落とす）。
    expect(source).toContain("shortcutsSuppressed={ribbonBackstageOpen}");
  });

  it("Backstage 表示中は window の capture フェーズで Escape 以外を止める", () => {
    // capture は window → target → bubble の順なので、window の capture で止めれば
    // bubble 側の handleOverlayKeyboard には届かない。preventDefault はしない
    // （Tab によるフォーカス移動を殺さないため）。
    const start = source.indexOf("const guardBackstageKeys = (");
    expect(start).toBeGreaterThan(-1);
    const guard = source.slice(start, source.indexOf("]);", start));
    expect(guard).toContain('event.key === "Escape"');
    expect(guard).toContain("event.stopPropagation()");
    expect(guard).not.toContain("preventDefault");
    expect(guard).toContain('window.addEventListener("keydown", guardBackstageKeys, true)');
  });
});
