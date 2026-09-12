import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// UI選択オンボーディングは再検討まで公開しない。画面だけ外してEditorShell側の
// 「開いている」判定を残すと、見えないモーダルによって全ショートカットが止まるため、
// 表示側と抑止側のどちらにも経路が残っていないことを固定する。
const source = readFileSync(
  new URL("../editor/EditorShell.tsx", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const routingSource = readFileSync(
  new URL("../editor/editor-shell/use-editor-command-routing.ts", import.meta.url),
  "utf8",
);

/** 対象リスナーを登録している useEffect の本文 (条件式 + 依存配列) を切り出す。 */
function shortcutEffectSource(handlerName: string): string {
  const handlerSource = handlerName === "handleCommandShortcut" ? routingSource : source;
  const start = handlerSource.indexOf(`const ${handlerName} = (`);
  const removal = handlerSource.indexOf(`window.removeEventListener("keydown", ${handlerName}`, start);
  const end = handlerSource.indexOf("]);", removal);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return handlerSource.slice(start, end);
}

describe("EditorShell のショートカット抑止", () => {
  it("UI選択オンボーディングを描画しない", () => {
    expect(pageSource).not.toContain("UiLayoutOnboardingDialog");
  });

  it.each(["handleCommandShortcut", "handleInlineShortcut"])(
    "%s に見えないオンボーディング抑止を残さない",
    (handlerName) => {
      const effect = shortcutEffectSource(handlerName);
      expect(effect).not.toContain("uiLayoutOnboardingOpen");
    },
  );
});
