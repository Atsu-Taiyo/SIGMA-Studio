interface LatexIssue {
  code: string;
  arg?: string;
}

// MathLive touches DOM globals at module load time, which crashes Electron's main process.
// Desktop AI-edit validation still runs structural SigmaDoc checks; renderer-side TeX validation keeps using MathLive.
export function validateLatex(tex: string): LatexIssue[] {
  void tex;
  return [];
}

export function convertLatexToMarkup(tex: string): string {
  return tex;
}
