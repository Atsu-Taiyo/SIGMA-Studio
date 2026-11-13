/** Desktop authoring memory contract. No document or rendering core depends on it. */
export interface AuthoringStyleProfile {
  workspaceId: string | null;
  enabled: boolean;
  userContent: string;
  generatedContent: string;
  userPath: string;
  generatedPath: string;
  revision: string;
  generatedEdited: boolean;
  exampleCount: number;
  evidenceRevision: string;
  needsSynthesis: boolean;
}

export interface AuthoringStyleAPI {
  read(workspaceId: string | null): Promise<AuthoringStyleProfile>;
  save(input: { workspaceId: string | null; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile>;
  setEnabled(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile>;
  reset(workspaceId: string | null): Promise<AuthoringStyleProfile>;
}

export const AUTHORING_STYLE_NOTE_LIMIT = 3000;
