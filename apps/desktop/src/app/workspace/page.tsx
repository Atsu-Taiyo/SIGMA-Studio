import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { WorkspaceManager } from "@/components/workspace/WorkspaceManager";
import { AppEntry } from "@/features/collaboration/browser/AppEntry";

export default function WorkspacePage() {
  return (
    <AppErrorBoundary>
      <AppEntry desktop={<WorkspaceManager />} />
    </AppErrorBoundary>
  );
}
