import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";
import type { SigmaDocument } from "@/features/document";
import { ORDERED_INLINE_MATH_TEMPLATE_GROUPS } from "@/lib/inline-math-templates";

const APP_ROOT = path.resolve(__dirname, "../..");

async function launch(extra: SigmaDocument["content"] = []): Promise<{ app: ElectronApplication; page: Page; fileId: string; profile: string }> {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-type-ahead-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await (await app.browserWindow(page)).evaluate(window => window.setContentSize(1200, 850));
  await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
  const source: SigmaDocument = {
    version: "2.0", docId: "math_type_ahead",
    metadata: { title: "数式の先打ち", styleUnits: { fontSize: "pt" } },
    content: [
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "paragraph" as const, id: `p${index}`, children: [{ type: "text" as const, text: `段落${index}` }],
      })),
      ...extra,
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const fileId = await page.evaluate(async document => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
    await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
    return file.fileId;
  }, source);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  return { app, page, fileId, profile };
}

async function caretAtParagraphEnd(page: Page, id: string): Promise<Locator> {
  const paragraph = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
  await paragraph.click();
  // macOS の合成 Meta+ArrowRight は当てにならないので、DOM の選択を直接置く。
  await paragraph.evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    while (walker.nextNode()) last = walker.currentNode;
    getSelection()!.collapse(last, last!.textContent!.length);
  });
  return paragraph;
}

async function editingState(paragraph: Locator) {
  return paragraph.evaluate(el => {
    const field = el.querySelector("math-field") as MathfieldElement | null;
    const frame = el.querySelector(".inline-math-node")!.getBoundingClientRect();
    return {
      value: field?.value ?? null,
      prompts: field?.shadowRoot?.querySelectorAll(".ML__prompt").length ?? null,
      width: Math.round(frame.width),
      height: Math.round(frame.height),
    };
  });
}

/** MathLive は値を変えた次のタスクで input を出し、そこで枠 (静的な式) が追従する。それを待って測る。 */
async function settledEditingState(paragraph: Locator) {
  await paragraph.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return editingState(paragraph);
}

async function textOutsideMath(paragraph: Locator) {
  return paragraph.evaluate(el => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".inline-math-node").forEach(node => node.remove());
    return copy.textContent!.replace(/\u200b/g, "");
  });
}

async function savedParagraphs(page: Page, fileId: string) {
  const saved = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
  return Object.fromEntries((saved?.content ?? []).map(block => [
    block.id,
    block.type === "paragraph" ? block.children.map(run => run.type === "mathInline" ? `$${run.tex}$` : run.type === "text" ? run.text : "").join("") : "",
  ]));
}

test("keys typed right after Ctrl+M land inside the new formula and keep their order through save/reload", async () => {
  const { app, page, fileId, profile } = await launch();
  try {
    const paragraph = await caretAtParagraphEnd(page, "p0");
    // 入力欄が焦点を取るまで (MathLive は focus() の 60ms 後) に打つ。待たずに続けて打つのが本題。
    await page.keyboard.press("Control+m");
    await page.keyboard.type("ab");
    await expect.poll(() => editingState(paragraph).then(state => state.value)).toBe("ab");
    expect(await textOutsideMath(paragraph)).toBe("段落0");
    await page.keyboard.press("Enter");
    await expect(paragraph.locator("math-field")).toHaveCount(0);
    await page.keyboard.type("c");

    // 確定 (Enter) を挟んでも、預かったキーは順番どおりに数式と本文へ届く。
    const fast = await caretAtParagraphEnd(page, "p1");
    await page.keyboard.press("Control+m");
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await page.keyboard.type("yz");
    await expect(fast.locator(".inline-math-node")).toHaveAttribute("data-tex", "x");
    await expect(fast).toContainText("yz");

    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => savedParagraphs(page, fileId)).toMatchObject({ p0: "段落0$ab$c", p1: "段落1$x$yz" });
    await page.reload();
    await expect(page.locator('.page-flow [data-sigma-doc-id="p0"] .inline-math-node').first()).toHaveAttribute("data-tex", "ab");
  } finally {
    await app.close();
    // 閉じた直後の Electron がまだ profile に書いていることがある。
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

for (const { name, key, keys, tex } of [
  { name: "log", key: "Control+l", keys: ["x"], tex: String.raw`\log x` },
  // 分数は分母から入る。↑で分子へ移る。
  { name: "fraction", key: "Control+/", keys: ["y", "ArrowUp", "x"], tex: String.raw`\frac{x}{y}` },
] as const) {
  test(`${name} shortcut from body text behaves like the same shortcut inside math`, async () => {
    const { app, page, fileId, profile } = await launch();
    try {
      const typeKeys = async () => {
        for (const item of keys) {
          if (item.length === 1) await page.keyboard.type(item);
          else await page.keyboard.press(item);
        }
      };

      // 本文から押して、待たずに中身を打つ。
      const fromBody = await caretAtParagraphEnd(page, "p2");
      await page.keyboard.press(key);
      await typeKeys();
      await expect.poll(() => editingState(fromBody).then(state => state.value)).toBe(tex);
      const bodyEditing = await settledEditingState(fromBody);
      await page.keyboard.press("Enter");

      // 比較の基準: Ctrl+M で数式に入ってから同じショートカットを押す。
      const insideMath = await caretAtParagraphEnd(page, "p3");
      await page.keyboard.press("Control+m");
      await expect(insideMath.locator("math-field")).toBeFocused();
      await page.keyboard.press(key);
      await typeKeys();
      await expect.poll(() => editingState(insideMath).then(state => state.value)).toBe(tex);
      const mathEditing = await settledEditingState(insideMath);
      await page.keyboard.press("Enter");

      // 空欄は枠付きの prompt にならず、本文から押しても同じ幅・高さで組まれる。
      expect(bodyEditing).toEqual(mathEditing);
      expect(bodyEditing.prompts).toBe(0);

      await page.keyboard.press("ControlOrMeta+s");
      await expect.poll(() => savedParagraphs(page, fileId)).toMatchObject({ p2: `段落2$${tex}$`, p3: `段落3$${tex}$` });
      await page.reload();
      await expect(page.locator('.page-flow [data-sigma-doc-id="p2"] .inline-math-node').first()).toHaveAttribute("data-tex", tex);
    } finally {
      await app.close();
      // 閉じた直後の Electron がまだ profile に書いていることがある。
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}

function mathParagraph(id: string, tex: string): SigmaDocument["content"][number] {
  return {
    type: "paragraph", id, children: [
      { type: "text", text: "前" }, { type: "mathInline", id: `m_${id}`, tex, display: "inline" }, { type: "text", text: "後" },
    ],
  };
}

test("keys typed right after entering an existing formula stay in it, and a clicked blank takes them without a prompt frame", async () => {
  const { app, page, fileId, profile } = await launch([
    mathParagraph("arrow", "x+1"),
    mathParagraph("click", "x+1"),
    mathParagraph("blank", String.raw`\frac{\placeholder{}}{\placeholder{}}`),
    mathParagraph("legacy", String.raw`\log\placeholder{x}`),
  ]);
  try {
    // → で数式へ入って待たずに打つ。本文へ届くと、選択中の数式ごと文字に置き換わっていた。
    const arrow = page.locator('.page-flow [data-sigma-doc-id="arrow"]').first();
    await arrow.click();
    await arrow.evaluate(el => {
      const before = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
      const host = el.closest<HTMLElement>(".ProseMirror") as (HTMLElement & {
        editor?: { view: { posAtDOM(node: Node, offset: number): number; focus(): void };
          commands: { setTextSelection(position: number): boolean } };
      }) | null;
      const editor = host?.editor;
      if (!editor) throw new Error("The text editor is required");
      editor.commands.setTextSelection(editor.view.posAtDOM(before, before.textContent!.length));
      editor.view.focus();
    });
    // 操作前のカーソル位置を確定する (取り込む前の → は前の位置から動く)。
    await expect.poll(() => arrow.evaluate(el => {
      const host = el.closest<HTMLElement>(".ProseMirror") as (HTMLElement & {
        editor?: { state: { selection: { empty: boolean; $from: { parentOffset: number; parent: { attrs: Record<string, unknown> } } } } };
      }) | null;
      const selection = host?.editor?.state.selection;
      return Boolean(selection?.empty && selection.$from.parentOffset === 1
        && selection.$from.parent.attrs.sigmaDocId === "arrow");
    })).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("y");
    await expect.poll(() => editingState(arrow).then(state => state.value)).toBe("yx+1");
    await page.keyboard.press("Escape");
    expect(await textOutsideMath(arrow)).toBe("前後");

    // クリックして待たずに打つ。焦点が入力欄へ移る前の文字が消えていた。
    const click = page.locator('.page-flow [data-sigma-doc-id="click"]').first();
    const formula = (await click.locator(".inline-math-node").boundingBox())!;
    await page.mouse.click(formula.x + formula.width - 2, formula.y + formula.height / 2);
    await page.keyboard.type("y");
    await expect.poll(() => editingState(click).then(state => state.value)).toBe("x+1y");
    await page.keyboard.press("Escape");

    // 空欄をクリックすると、その空欄を選んだ状態になる (枠付きの prompt にしない)。
    const blank = page.locator('.page-flow [data-sigma-doc-id="blank"]').first();
    const staticWidth = await blank.locator(".inline-math-node").evaluate(el => Math.round(el.getBoundingClientRect().width));
    const square = (await blank.locator(".inline-math-node .ML__prompt-atom").first().boundingBox())!;
    await page.mouse.click(square.x + square.width / 2, square.y + square.height / 2);
    await expect(blank.locator("math-field")).toBeFocused();
    const opened = await editingState(blank);
    expect(opened.prompts).toBe(0);
    expect(opened.width).toBe(staticWidth);
    await page.keyboard.type("7");
    await expect.poll(() => editingState(blank).then(state => state.value)).toBe(String.raw`\frac{7}{\placeholder{}}`);
    await page.keyboard.press("Escape");

    // 0.511.0 が保存した「中身入りの空欄」は、開いて閉じると中身だけに戻る。
    const legacy = page.locator('.page-flow [data-sigma-doc-id="legacy"]').first();
    const legacyBox = (await legacy.locator(".inline-math-node").boundingBox())!;
    await page.mouse.click(legacyBox.x + legacyBox.width - 2, legacyBox.y + legacyBox.height / 2);
    await expect(legacy.locator("math-field")).toBeFocused();
    await page.keyboard.press("Escape");

    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => savedParagraphs(page, fileId)).toMatchObject({
      arrow: "前$yx+1$後",
      click: "前$x+1y$後",
      blank: String.raw`前$\frac{7}{\placeholder{}}$後`,
      // 中身は波括弧のまとまりで残る (`\logx` のように命令名へ繋がらないように)。見た目は \log x と同じ。
      legacy: String.raw`前$\log{x}$後`,
    });
  } finally {
    await app.close();
    // 閉じた直後の Electron がまだ profile に書いていることがある。
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Control shortcuts reach math on macOS instead of ⌘ commands, the AI prompt or MathLive's Emacs keys", async () => {
  test.skip(process.platform !== "darwin", "macOS だけ ⌃ と ⌘ が別のキー");
  const { app, page, profile } = await launch();
  try {
    // ⌃I/⌃G/⌃U/⌃B/⌃D/⌃- は ⌘ のコマンド (斜体・グループ化・下線・アウトライン・複製・縮小)、⌃K は AI に取られていた。
    const cases = [
      ["Control+i", String.raw`\int\placeholder{}`],
      ["Control+g", String.raw`\sum_{\placeholder{}}^{\placeholder{}}\placeholder{}`],
      ["Control+k", String.raw`\tan\placeholder{}`],
      ["Control+u", String.raw`\lim_{\placeholder{}\to\placeholder{}}`],
      ["Control+b", String.raw`\boxed{\placeholder{}}`],
      ["Control+-", String.raw`\ne`],
    ] as const;
    for (const [index, [key, tex]] of cases.entries()) {
      const paragraph = await caretAtParagraphEnd(page, `p${index}`);
      await page.keyboard.press(key);
      await expect.poll(() => editingState(paragraph).then(state => state.value), { message: key }).toBe(tex);
      expect(await page.locator(".ai-inline-catcher").count(), key).toBe(0);
      await page.keyboard.press("Escape");
      await expect(paragraph.locator("math-field")).toHaveCount(0);
    }

    // 数式の中で ⌃H (sin)・⌃D (行列) を押しても、MathLive の削除が先に走らない。
    const inside = await caretAtParagraphEnd(page, "p8");
    await page.keyboard.press("Control+m");
    await expect(inside.locator("math-field")).toBeFocused();
    await page.keyboard.type("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+h");
    await page.keyboard.type("x");
    await page.keyboard.press("Control+d");
    await expect.poll(() => editingState(inside).then(state => state.value))
      .toBe(String.raw`a\sin x\begin{pmatrix}\placeholder{} & \placeholder{}\\ \placeholder{} & \placeholder{}\end{pmatrix}b`);
    await page.keyboard.press("Escape");
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("math palette templates go in like the same shortcut pressed inside math", async () => {
  const { app, page, fileId, profile } = await launch();
  try {
    const templates = ORDERED_INLINE_MATH_TEMPLATE_GROUPS.flatMap(group => group.templates);
    const fraction = page.locator(".inline-math-template-button").nth(templates.findIndex(template => template.id === "fraction"));
    const palette = page.getByRole("button", { name: "数式", exact: true }).first();

    // 本文から: キャレットが末尾 (分数の外) に出て、枠も分数の高さに追従していなかった。
    const fromBody = await caretAtParagraphEnd(page, "p0");
    await palette.hover();
    await fraction.click();
    await expect(fromBody.locator("math-field")).toBeFocused();
    await page.keyboard.type("x");
    await expect.poll(() => editingState(fromBody).then(state => state.value)).toBe(String.raw`\frac{\placeholder{}}{x}`);
    const bodyEditing = await settledEditingState(fromBody);
    await page.keyboard.press("Escape");

    const inside = await caretAtParagraphEnd(page, "p1");
    await page.keyboard.press("Control+m");
    await expect(inside.locator("math-field")).toBeFocused();
    await page.keyboard.press("Control+/");
    await page.keyboard.type("x");
    await expect.poll(() => editingState(inside).then(state => state.value)).toBe(String.raw`\frac{\placeholder{}}{x}`);
    expect(bodyEditing).toEqual(await settledEditingState(inside));
    await page.keyboard.press("Escape");

    // 数式を編集中に押すと、キャレットの位置に入って最初の空欄へ進む。
    const editing = await caretAtParagraphEnd(page, "p2");
    await page.keyboard.press("Control+m");
    await expect(editing.locator("math-field")).toBeFocused();
    await page.keyboard.type("a");
    await palette.hover();
    await fraction.click();
    await page.keyboard.type("x");
    await expect.poll(() => editingState(editing).then(state => state.value)).toBe(String.raw`a\frac{\placeholder{}}{x}`);
    await page.keyboard.press("Escape");

    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => savedParagraphs(page, fileId)).toMatchObject({
      p0: String.raw`段落0$\frac{\placeholder{}}{x}$`,
      p2: String.raw`段落2$a\frac{\placeholder{}}{x}$`,
    });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
