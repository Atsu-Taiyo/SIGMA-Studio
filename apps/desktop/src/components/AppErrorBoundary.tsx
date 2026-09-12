"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { AppCrashScreen } from "@/components/AppCrashScreen";
import { describeAppCrash, type AppCrashReport } from "@/components/app-crash-report";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  report: AppCrashReport | null;
}

/**
 * レンダー中の例外でアプリのツリー全体が消えるのを止める最後の砦。
 *
 * 素のままだと React は例外時にツリーを丸ごと破棄するため、Electron では
 * 「真っ白な画面 + タイトルバーに index.html」だけが残り、ユーザーには
 * 何が起きたのか一切分からない (document.title もツリーごと消えるため、
 * ウィンドウタイトルがファイル名へフォールバックする)。ここで受け止めて
 * 原因とAIへ渡せるプロンプトを画面に出す。
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { report: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      report: describeAppCrash(error, undefined, typeof window === "undefined" ? undefined : window.location.href),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[sigma] application render failed", error, info.componentStack);
    this.setState((current) => ({
      report: {
        ...(current.report ?? describeAppCrash(error)),
        componentStack: info.componentStack ?? undefined,
      },
    }));
  }

  render(): ReactNode {
    const { report } = this.state;
    if (!report) {
      return this.props.children;
    }
    return (
      <AppCrashScreen
        report={report}
        onReload={() => {
          window.location.reload();
        }}
      />
    );
  }
}
