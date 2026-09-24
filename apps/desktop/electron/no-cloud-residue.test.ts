import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const BINARY_EXTENSIONS = new Set([
  ".bin",
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".otf",
  ".pdf",
  ".png",
  ".pptx",
  ".pyc",
  ".svg",
  ".ttf",
  ".wmf",
  ".woff",
  ".woff2",
  ".zip",
]);

const RESIDUE_PATTERNS = [
  { label: "Supabase package import", pattern: /@supabase\//u },
  { label: "Supabase reference", pattern: /\bsupabase\b/iu },
  { label: "Supabase build environment", pattern: /SIGMA_STUDIO_SUPABASE_/u },
  { label: "cloud workspace IPC", pattern: /cloud-workspace:/u },
  { label: "includeCloud", pattern: /\bincludeCloud\b/u },
  { label: "cloudState", pattern: /\bcloudState\b/u },
  { label: "remoteRevision", pattern: /\bremoteRevision\b/u },
  { label: "WorkspaceKind", pattern: /\bWorkspaceKind\b/u },
  { label: "cloudWorkspace", pattern: /\bcloudWorkspace\b/u },
  { label: "cloud files visibility", pattern: /\b(?:cloudFilesVisible|resolveCloudFilesVisible)\b/u },
  { label: "cloud conversion", pattern: /converted-to-cloud/u },
  { label: "removed custom protocol", pattern: /sigmastudio:\/\//u },
  { label: "removed auth redirect IPC", pattern: /auth:get-redirect-url/u },
  { label: "removed auth external-open IPC", pattern: /auth:open-external/u },
] as const;

// Optional per-document adapters may reference their identity provider. Legacy
// workspace APIs and public/core imports remain forbidden everywhere.
const OPTIONAL_COLLABORATION_PATHS = [
  /^\.github\/workflows\/collaboration-experiment\.yml$/u,
  /^apps\/collaboration\/.*$/u,
  /^apps\/desktop\/(electron|src\/features)\/collaboration\/.*$/u,
  /^supabase\/.*$/u,
  /^docs\/collaboration.*$/u,
  /^\.env\.example$/u,
  /^docs\/adr\/001-optional-collaboration\.md$/u,
  /^scripts\/collaboration-.*$/u,
  /^apps\/desktop\/tests\/electron\/collaboration.*$/u,
  /^apps\/desktop\/tests\/electron\/workspace-hierarchy-sharing\.spec\.ts$/u,
] as const;

// These exact lines either reject legacy ledger keys or prove that removed bridge
// fields are ignored. Keeping the allowlist line-scoped makes any real reuse fail.
const ALLOWED_LEGACY_ASSERTIONS: Readonly<Record<string, readonly RegExp[]>> = {
  "packages/editor/src/package-boundary.test.ts": [
    /^\s*expect\(inputs\.filter\(input => .*\)\)\.toEqual\(\[\]\);$/u,
  ],
  ".gitignore": [
    /^\/supabase\/$/u,
    /^supabase\/\.(?:temp|branches)\/$/u,
  ],
  "apps/desktop/electron/local-library-record.test.ts": [
    /^\s*files: \[\{ cloudState: null \}\],$/u,
    /^\s*\{ path: "files\[0\]\.cloudState", reason: \{ kind: "forbiddenField", field: "cloudState" \}, expected: null, received: "null" \},$/u,
  ],
  "apps/desktop/electron/local-sigma-doc-store.test.ts": [
    /^\s*expect\(record\)\.not\.toHaveProperty\("(?:cloudState|remoteRevision)"\);$/u,
  ],
  "apps/desktop/electron/no-cloud-residue.test.ts": [
    // This file is scanned too. Only complete pattern-definition and line-scoped
    // assertion-definition lines may contain the tokens that the guard detects.
    /^\s*\{ label: "[^"]+", pattern: \/.+\/[iu]+ \},$/u,
    /^\s*\/\^.*\$\/u,$/u,
  ],
  "apps/desktop/electron/preload-surface.test.ts": [
    /^\s*expect\(preloadSource\)\.not\.toMatch\(\/(?:cloud-workspace:|cloudWorkspace)\/u\);$/u,
  ],
  "apps/desktop/src/lib/i18n/dictionaries/en/error.ts": [
    /^\s*task3: "3\. Remove the deprecated fields \(kind \/ cloudState \/ remoteRevision \/ role \/ memberCount \/ remoteId\) from every row in workspaces and files\.",$/u,
  ],
  "apps/desktop/src/lib/i18n/dictionaries/ja/error.ts": [
    /^\s*task3: "3\. 廃止されたフィールド \(kind \/ cloudState \/ remoteRevision \/ role \/ memberCount \/ remoteId\) を workspaces と files の各行から削除してください。",$/u,
  ],
  "apps/desktop/src/components/ledger/ledger-schema-failure.ts": [
    /^\s*"3\. 廃止されたフィールド \(kind \/ cloudState \/ remoteRevision \/ role \/ memberCount \/ remoteId\) を workspaces と files の各行から削除してください。",$/u,
  ],
  "apps/desktop/src/lib/library-schema.test.ts": [
    /^\s*\["files", "cloudState", "files\[0\]\.cloudState"\],$/u,
    /^\s*\["files", "remoteRevision", "files\[0\]\.remoteRevision"\],$/u,
  ],
  "apps/desktop/src/lib/library-schema.ts": [
    /^const FORBIDDEN_FILE_FIELDS = \["kind", "cloudState", "remoteRevision"\] as const;$/u,
  ],
  "apps/desktop/src/lib/runtime/desktop-runtime.test.ts": [
    /^\s*expect\(Object\.keys\(runtime\?\.capabilities \?\? \{\}\)\)\.not\.toContain\("cloudWorkspace"\);$/u,
    /^\s*cloudWorkspace: \{ getStatus: vi\.fn\(\) \},$/u,
  ],
};

function repositoryTextFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPOSITORY_DIR,
    encoding: "utf8",
  });

  return output
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase()))
    .map((relativePath) => path.join(REPOSITORY_DIR, relativePath))
    // A tracked file intentionally deleted in the current worktree is already absent residue.
    .filter((absolutePath) => existsSync(absolutePath));
}

describe("cloud removal boundary", () => {
  it("keeps removed cloud APIs and dependencies out of repository sources", () => {
    const violations: string[] = [];

    scanFiles(repositoryTextFiles(), RESIDUE_PATTERNS, violations);

    expect(violations, `撤去済みcloud機能の残存: ${violations.join(", ")}`).toEqual([]);
  });
});

function scanFiles(
  absolutePaths: readonly string[],
  patterns: readonly { label: string; pattern: RegExp }[],
  violations: string[],
): void {
  for (const absolutePath of absolutePaths) {
    const relativePath = path.relative(REPOSITORY_DIR, absolutePath);
    const allowedLines = ALLOWED_LEGACY_ASSERTIONS[relativePath] ?? [];
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/u);

    lines.forEach((line, index) => {
      for (const { label, pattern } of patterns) {
        if (label === RESIDUE_PATTERNS[1].label && OPTIONAL_COLLABORATION_PATHS.some(allowed => allowed.test(relativePath))) continue;
        if (pattern.test(line) && !allowedLines.some((allowed) => allowed.test(line))) {
          violations.push(`${relativePath}:${index + 1} (${label})`);
        }
      }
    });
  }
}
