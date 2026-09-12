import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { EditorShell } from "@/components/editor/EditorShell";
import { StartupSplash } from "@/components/StartupSplash";

export default function Home() {
  return (
    <>
      <StartupSplash />
      <AppErrorBoundary>
        <EditorShell />
      </AppErrorBoundary>
    </>
  );
}
