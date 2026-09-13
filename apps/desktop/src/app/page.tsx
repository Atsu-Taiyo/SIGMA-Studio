import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { EditorShell } from "@/components/editor/EditorShell";
import { StartupSplash } from "@/components/StartupSplash";
import { GitHubStarDialog } from "@/components/community/GitHubStarDialog";

export default function Home() {
  return (
    <>
      <StartupSplash />
      <GitHubStarDialog />
      <AppErrorBoundary>
        <EditorShell />
      </AppErrorBoundary>
    </>
  );
}
