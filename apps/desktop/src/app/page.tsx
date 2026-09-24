import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { DesktopEditor } from "@/features/collaboration/renderer/DesktopEditor";
import { StartupSplash } from "@/components/StartupSplash";
import { GitHubStarDialog } from "@/components/community/GitHubStarDialog";

export default function Home() {
  return (
    <>
      <StartupSplash />
      <GitHubStarDialog />
      <AppErrorBoundary>
        <DesktopEditor />
      </AppErrorBoundary>
    </>
  );
}
