import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { WorkspaceManager } from "@/components/workspace/WorkspaceManager";

export default function WorkspacePage() {
  return (
    <AppErrorBoundary>
      <WorkspaceManager />
    </AppErrorBoundary>
  );
}
