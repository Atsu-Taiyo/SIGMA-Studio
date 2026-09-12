import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppCrashScreen } from "./AppCrashScreen";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { buildAppCrashPrompt, describeAppCrash } from "./app-crash-report";
import { createTranslator } from "@/lib/i18n";

describe("AppErrorBoundary", () => {
  // 実際の catch は client render でしか起きない (SSRのrenderToStaticMarkupは
  // error boundary を通さない) ので、境界が捨てるはずのツリーの代わりに何を出すか
  // — getDerivedStateFromError の結果と、その描画 — を直接確かめる。
  it("turns a thrown error into the crash screen instead of an empty tree", () => {
    const { report } = AppErrorBoundary.getDerivedStateFromError(
      new Error("Cannot read properties of undefined (reading 'forEach')"),
    );
    expect(report).not.toBeNull();

    const html = renderToStaticMarkup(<AppCrashScreen report={report!} onReload={() => {}} />);

    expect(html).toContain("画面を表示できませんでした");
    expect(html).toContain("Cannot read properties of undefined");
    expect(html).toContain("プロンプトをコピー");
    expect(html).toContain("再読み込み");
  });

  it("passes children through untouched while nothing throws", () => {
    const html = renderToStaticMarkup(
      <AppErrorBoundary>
        <p>本文</p>
      </AppErrorBoundary>,
    );

    expect(html).toBe("<p>本文</p>");
  });
});

describe("buildAppCrashPrompt", () => {
  it("directs the AI to repair persisted SigmaDoc data without requiring an app update", () => {
    const prompt = buildAppCrashPrompt(describeAppCrash(
      Object.assign(new Error("boom"), { stack: "Error: boom\n    at getMeasurementLines (some-module.ts:136)" }),
      "\n    at EditorShell",
      "file:///app/out/index.html?fileId=file_1",
    ));

    expect(prompt).toContain("boom");
    expect(prompt).toContain("at getMeasurementLines");
    expect(prompt).toContain("at EditorShell");
    expect(prompt).toContain("file:///app/out/index.html?fileId=file_1");
    expect(prompt).toContain("保存済みのSigmaDoc JSONデータ");
    expect(prompt).toContain("アプリのソースコードを変更したり");
    expect(prompt).toContain("対象データをバックアップ");
    expect(prompt).toContain("提案履歴・チャット履歴・復旧データ");
    expect(prompt).toContain("アプリをアップデートせずに");
  });

  it("keeps working when a non-Error value is thrown and no stack exists", () => {
    const prompt = buildAppCrashPrompt(describeAppCrash("文字列が投げられた"));

    expect(prompt).toContain("文字列が投げられた");
    expect(prompt).not.toContain("## スタックトレース");
  });

  it("localizes the repair instructions while preserving diagnostic values", () => {
    const t = createTranslator("en", "error");
    const report = describeAppCrash(new Error("生のエラー"), "at RawComponent", "file:///raw/path", t);
    const prompt = buildAppCrashPrompt(report, t);

    expect(prompt).toContain("## Stack trace");
    expect(prompt).toContain("生のエラー");
    expect(prompt).toContain("file:///raw/path");
    expect(prompt).toContain("Do not change the application source");
    expect(prompt).not.toContain("## やってほしいこと");
  });
});
