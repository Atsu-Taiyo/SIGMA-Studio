// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import type { Graph2DSpec } from "@/features/document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import { setInlineMathInputMode } from "@/lib/inline-math-mode";

/** `vitest.setup.ts` と同じキー。表示言語をここでも ja に固定するために持つ。 */
const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";

vi.mock("mathlive", () => ({}));
vi.mock("@/features/rendering/adapters/react", () => {
  // 実物は context の値なので描画をまたいで同じオブジェクト。毎回作ると入力欄の effect が
  // 描画のたびに走り直し、実機に無い値の書き戻しが起きる。
  const mathEnvironment = { macroSet: { mathLiveMacros: {} }, typesetStyle: "displaystyle" };
  return {
    InlineMathPreview: ({ tex, className }: { tex: string; className?: string }) => (
      <span className={`inline-math-node ${className ?? ""}`}>
        <span className="math-preview math-preview-inline">{tex}</span>
      </span>
    ),
    MathPreview: ({ tex, className }: { tex: string; className?: string }) => <span className={`math-preview ${className ?? ""}`}>{tex}</span>,
    useMathEnvironment: () => mathEnvironment,
  };
});

let GraphExpressionMathInput: typeof import("@/components/editor/EditorSettings").GraphExpressionMathInput;
let OverlayGraphSettings: typeof import("@/components/editor/EditorSettings").OverlayGraphSettings;
let MathExpressionInput: typeof import("./MathExpressionInput").MathExpressionInput;

class TestMathFieldElement extends HTMLElement {
  #value = "";
  position = 0;
  /** 外 (React 側) から `value` へ書き込まれた値。MathLive は書き込みのたびに式を読み直す。 */
  valueWrites: string[] = [];
  commands: string[] = [];

  constructor() {
    super();
    this.tabIndex = 0;
  }

  get value() {
    return this.#value;
  }

  set value(next: string) {
    this.#value = next;
    this.position = next.length;
    this.valueWrites.push(next);
  }

  executeCommand(command: string) {
    this.commands.push(command);
  }

  insert(text: string) {
    this.value += text;
    this.position = this.value.length;
  }

  /** MathLive 自身の編集 (打鍵・Backspace) を真似る。値は欄の中で変わり、`input` だけが外へ出る。 */
  editInside(latex: string) {
    this.#value = latex;
    this.position = latex.length;
    this.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

let container: HTMLDivElement;
let root: Root;

/** React の onChange まで届くように、値の記録を迂回する本来の setter で書いてから input を出す。 */
function typeIntoTextarea(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAsyncEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  document.open();
  document.write("<!doctype html><html><head></head><body></body></html>");
  document.close();
  // `vitest.setup.ts` は happy-dom の `navigator.language` ("en-US") を打ち消すために
  // `sigma-studio:ui-locale` を ja で仕込む。ここで localStorage を丸ごと差し替えると
  // **その仕込みごと消えて、このファイルだけ英語で描かれる**。同じ値を持たせておく。
  const storage = new Map<string, string>([[UI_LOCALE_STORAGE_KEY, "ja"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  if (!customElements.get("math-field")) {
    customElements.define("math-field", TestMathFieldElement);
  }
  const [inspectorModule, mathExpressionModule] = await Promise.all([
    import("@/components/editor/EditorSettings"),
    import("./MathExpressionInput"),
  ]);
  GraphExpressionMathInput = inspectorModule.GraphExpressionMathInput;
  OverlayGraphSettings = inspectorModule.OverlayGraphSettings;
  MathExpressionInput = mathExpressionModule.MathExpressionInput;
});

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, "ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("MathExpressionInput", () => {
  it("TeXモードでは本文と同じTeXエディタで入力して確定する", async () => {
    setInlineMathInputMode("tex");
    const onCommit = vi.fn();
    await act(async () => {
      root.render(
        <MathExpressionInput
          tex="x"
          ariaLabel="グラフの式"
          ariaDescribedBy="graph-error"
          data-testid="expression"
          onCommit={onCommit}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="expression"]')?.click();
      await flushAsyncEffects();
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="expression-field"]');
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("aria-label")).toBe("グラフの式");
    expect(textarea?.getAttribute("aria-describedby")).toBe("graph-error");
    if (!textarea) return;

    await act(async () => {
      textarea.value = "\\frac{x}{2}";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await flushAsyncEffects();
    });
    const updatedTextarea = document.querySelector<HTMLTextAreaElement>('[data-testid="expression-field"]');
    await act(async () => {
      updatedTextarea?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await flushAsyncEffects();
    });

    expect(onCommit).toHaveBeenCalledWith("\\frac{x}{2}");
  });

  it("共通の入力枠とmath-field設定を維持して表示する", async () => {
    await act(async () => {
      root.render(
        <MathExpressionInput
          tex="x^2"
          ariaLabel="式"
          data-testid="expression"
          onCommit={() => {}}
        />,
      );
    });

    const shell = container.querySelector<HTMLElement>(".math-expression-input");
    expect(shell?.querySelector(".math-preview")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="expression"]')?.click();
      await flushAsyncEffects();
    });

    expect(container.querySelector(".math-expression-input")).toBe(shell);
    const field = container.querySelector<TestMathFieldElement>('[data-testid="expression-field"]');
    expect(field?.classList.contains("inline-math-field")).toBe(true);
    expect(field?.getAttribute("environment-popover-policy")).toBe("off");
    expect(field?.getAttribute("math-mode-space")).toBe("\\ ");
  });

  it("確定後に非編集表示のボタンへフォーカスを戻す", async () => {
    const onCommit = vi.fn();
    await act(async () => {
      root.render(
        <MathExpressionInput
          tex="x"
          ariaLabel="式"
          data-testid="expression"
          onCommit={onCommit}
        />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="expression"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await flushAsyncEffects();
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    });

    const field = container.querySelector<TestMathFieldElement>('[data-testid="expression-field"]');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);

    if (!field) {
      return;
    }
    field.value = "x+1";
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flushAsyncEffects();
    });

    const restoredButton = container.querySelector<HTMLButtonElement>('[data-testid="expression"]');
    expect(onCommit).toHaveBeenCalledWith("x+1");
    expect(document.activeElement).toBe(restoredButton);
  });

  it("外部のtex更新時にグラフ式の不正なdraftを破棄する", async () => {
    const onCommitExpression = vi.fn();
    const renderInput = (tex: string) => (
      <GraphExpressionMathInput
        tex={tex}
        ariaLabel="グラフ式"
        dataTestId="graph-expression"
        onCommitExpression={onCommitExpression}
      />
    );

    await act(async () => root.render(renderInput("x")));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="graph-expression"]')?.click();
      await flushAsyncEffects();
    });

    const field = container.querySelector<TestMathFieldElement>('[data-testid="graph-expression-field"]');
    expect(field).not.toBeNull();
    if (!field) {
      return;
    }
    field.value = "\\frac{";
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flushAsyncEffects();
    });
    expect(container.querySelector(".math-expression-input")?.classList.contains("is-invalid")).toBe(true);
    const inlineError = container.querySelector<HTMLElement>(".graph-expression-error");
    expect(inlineError?.textContent).toBe("式を読み取れません。括弧や演算記号を確認してください。");
    expect(inlineError?.parentElement?.classList.contains("graph-expression-field")).toBe(true);
    expect(
      container.querySelector('[data-testid="graph-expression"]')?.getAttribute("aria-describedby"),
    ).toBe(inlineError?.id);

    await act(async () => {
      root.render(renderInput("x+2"));
      await flushAsyncEffects();
    });
    expect(container.querySelector(".math-expression-input")?.classList.contains("is-invalid")).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="graph-expression"]')?.click();
      await flushAsyncEffects();
    });
    expect(
      container.querySelector<TestMathFieldElement>('[data-testid="graph-expression-field"]')?.value,
    ).toBe("x+2");
  });

  describe("リアルタイム表示でグラフの式を消して打ち直す", () => {
    async function openLiveGraphExpression(onCommitExpression: (expression: string, tex: string) => void) {
      await act(async () => {
        root.render(
          <GraphExpressionMathInput
            tex={"\\sin(x)"}
            ariaLabel="関数 1 の式"
            dataTestId="graph-expression"
            live
            onCommitExpression={onCommitExpression}
          />,
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="graph-expression"]')?.click();
        await flushAsyncEffects();
        await new Promise((resolve) => window.setTimeout(resolve, 60));
      });
      const field = container.querySelector<TestMathFieldElement>('[data-testid="graph-expression-field"]');
      expect(field).not.toBeNull();
      return field!;
    }

    async function editInside(field: TestMathFieldElement, latex: string) {
      await act(async () => {
        field.editInside(latex);
        await flushAsyncEffects();
        await new Promise((resolve) => window.setTimeout(resolve, 60));
      });
    }

    it("入力のたびに値を入力欄へ書き戻さず、途中の式が書き出しと読み直しの往復で変わらない", async () => {
      setInlineMathInputMode("mathlive");
      const onCommitExpression = vi.fn();
      const field = await openLiveGraphExpression(onCommitExpression);
      // 開いたときの 1 回だけ。
      expect(field.valueWrites).toEqual(["\\sin(x)"]);
      expect(field.commands.filter((command) => command === "moveToMathfieldEnd")).toHaveLength(1);

      // 実機の MathLive で sin(x) を末尾から Backspace したときに書き出される値の列。
      // 閉じ括弧を消すと `\sin(x.` になる。これを欄へ書き戻すと MathLive が `.` を文字として読み直し、
      // キャレットも末尾 (括弧の外) へ送られて、次の Backspace でまた `.` が増えていた。
      const seen: string[] = [];
      for (const latex of ["\\sin(x.", "\\sin(.", "\\sin", ""]) {
        await editInside(field, latex);
        seen.push(field.value);
      }
      expect(seen).toEqual(["\\sin(x.", "\\sin(.", "\\sin", ""]);
      expect(field.valueWrites).toEqual(["\\sin(x)"]);
      expect(field.commands.filter((command) => command === "moveToMathfieldEnd")).toHaveLength(1);
      expect(container.querySelector('[data-testid="graph-expression-field"]')).toBe(field);
      expect(container.querySelector(".graph-expression-error")?.textContent)
        .toBe("数値や変数を使った式を入力してください。");

      await editInside(field, "x^2");
      expect(field.valueWrites).toEqual(["\\sin(x)"]);
      expect(onCommitExpression).toHaveBeenLastCalledWith("x^2", "x^2");
      expect(container.querySelector(".graph-expression-error")?.textContent).toBe("");
    });

    it("全部消した入力欄で Backspace を押しても閉じず、続けて打った式がグラフへ届く (リアルタイム表示)", async () => {
      setInlineMathInputMode("mathlive");
      const onCommitExpression = vi.fn();
      const field = await openLiveGraphExpression(onCommitExpression);

      await editInside(field, "");
      // MathLive は Backspace を先に処理する。消し終えた欄 (先頭・空) で押された Backspace が届く。
      for (let index = 0; index < 3; index += 1) {
        await act(async () => {
          field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
          await flushAsyncEffects();
        });
      }
      expect(container.querySelector('[data-testid="graph-expression-field"]')).toBe(field);
      expect(document.activeElement).toBe(field);

      await editInside(field, "x");
      expect(onCommitExpression).toHaveBeenLastCalledWith("x", "x");
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await flushAsyncEffects();
      });
      expect(container.querySelector('[data-testid="graph-expression-field"]')).toBeNull();
      expect(onCommitExpression).toHaveBeenLastCalledWith("x", "x");
    });

    it("TeXモードでも、空の入力欄の Backspace で閉じず続けて入力できる", async () => {
      setInlineMathInputMode("tex");
      const onCommitExpression = vi.fn();
      await act(async () => {
        root.render(
          <GraphExpressionMathInput
            tex="x"
            ariaLabel="関数 1 の式"
            dataTestId="graph-expression"
            live
            onCommitExpression={onCommitExpression}
          />,
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="graph-expression"]')?.click();
        await flushAsyncEffects();
      });
      const textarea = () => document.querySelector<HTMLTextAreaElement>('[data-testid="graph-expression-field"]');
      expect(textarea()).not.toBeNull();

      await act(async () => {
        typeIntoTextarea(textarea()!, "");
        await flushAsyncEffects();
      });
      await act(async () => {
        textarea()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
        await flushAsyncEffects();
      });
      expect(textarea()).not.toBeNull();

      await act(async () => {
        typeIntoTextarea(textarea()!, "x+1");
        await flushAsyncEffects();
      });
      expect(onCommitExpression).toHaveBeenLastCalledWith("x+1", "x+1");
      expect(textarea()?.value).toBe("x+1");
    });
  });

  it("同一バッチのグラフ設定更新を最新specへ順番に合成する", async () => {
    const onSpecChange = vi.fn();
    const spec = createGraph2DSpecPreset("line");
    const selectedOverlayGraph: SelectedOverlayGraph = {
      shapeId: "graph_test",
      spec,
      axisLabelShapeIdsByKey: {},
      axisLabelTextsByKey: {},
      formulaLabelShapeIds: [],
      formulaLabelShapeIdsByCurveId: {},
      pickingOrigin: false,
      pickingFill: false,
      onSpecChange,
      onAxisLabelChange: () => {},
      onAxisLabelTextChange: () => {},
      onFormulaLabelChange: () => {},
      onStartCrop: () => {},
      onStartOriginPick: () => {},
      onStartFillPick: () => {},
      onClose: () => {},
    };

    await act(async () => {
      root.render(<OverlayGraphSettings selectedOverlayGraph={selectedOverlayGraph} />);
    });
    const displayRangeButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".editor-settings-accordion-header"),
    ).find((button) => button.textContent?.includes("表示範囲"));
    await act(async () => {
      displayRangeButton?.click();
      await flushAsyncEffects();
    });
    const axisToggles = container.querySelectorAll<HTMLInputElement>(
      ".graph-checkbox-grid input[type='checkbox']",
    );
    const xAxisToggle = axisToggles[0];
    const yAxisToggle = axisToggles[1];
    expect(xAxisToggle?.checked).toBe(true);
    expect(yAxisToggle?.checked).toBe(true);

    await act(async () => {
      xAxisToggle?.click();
      yAxisToggle?.click();
      await flushAsyncEffects();
    });

    const lastSpec = onSpecChange.mock.calls.at(-1)?.[0] as Graph2DSpec | undefined;
    expect(onSpecChange).toHaveBeenCalledTimes(2);
    expect(lastSpec?.axes.showX).toBe(false);
    expect(lastSpec?.axes.showY).toBe(false);
  });
});
