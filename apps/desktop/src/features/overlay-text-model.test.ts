import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What an overlay text shape is, pinned by absence.
 *
 * Its width is chosen by whoever made it and its height is a cache of what the browser measured.
 * The model it replaced fitted the box to its content instead, and that model reached a long way:
 * a DOM-free estimator with its own idea of where lines break, a `maxWidth` that meant "wrap here
 * but keep measuring", an `autoSize` flag deciding which of the two rules applied, and every tool
 * argument and prompt sentence that told an author or an agent to use them.
 *
 * Deleting the code is not enough on its own. What made that model expensive was that it kept
 * being reintroduced — a caller re-adding a `maxWidth` argument, a prompt still teaching an agent
 * to ask for auto-sizing, a second estimator growing back beside the first and drifting from it
 * until stored figure positions moved. So the names are banned outright, and the few places
 * allowed to still say them are listed here by name with the reason.
 */

const DELETED_MEASUREMENT_MODULES = [
  "overlay-text-measure",
  "overlay-text-line-model",
  "overlay-math-metrics-port",
  "register-math-metrics",
];

/** Identifiers of the props the overlay text model no longer has. */
const REMOVED_TEXT_SHAPE_PROPS = ["autoSize", "maxWidth"];

interface Exemption {
  /** Why this file is allowed to say the name at all. */
  reason: string;
  /** The only lines in it that may. A line that does not match is a regression. */
  lines: RegExp;
}

/**
 * Where these names may still be written, line by line.
 *
 * A file-level exemption is not enough for the files that matter most: `sigma-doc-mcp-server-core`
 * has to name both props in order to refuse them, and is also exactly where a
 * `maxWidth: z.number().optional()` would go if someone re-added the argument. So each exemption
 * also says which *lines* may carry the name — a refusal, an assertion that the surface no longer
 * offers it, or a local variable that happens to be called "how wide this may be".
 */
const EXEMPTIONS = new Map<string, Exemption>([
  // The existing WebMCP schema still advertises this legacy field. Preserve that public
  // contract during internal refactors; the characterization below verifies that accepting
  // the argument at transport discovery never restores it to the canonical text model.
  ["src/lib/webmcp-tools.ts", {
    reason: "preserves the legacy public schema field without restoring text sizing behavior",
    lines: /^autoSize: \{ type: "boolean" \}, locked: \{ type: "boolean" \}, hidden: \{ type: "boolean" \},$/,
  }],
  ["src/lib/webmcp-tools.test.ts", {
    reason: "characterizes the existing public field being discarded by canonical normalization",
    lines: /toHaveProperty\("autoSize", \{ type: "boolean" \}\)|not\.toHaveProperty\("autoSize"\)|autoSize: true,$/,
  }],
  // The tool layer refuses the removed arguments by name instead of dropping them silently, which
  // is the only way an agent that still asks for one finds out it is gone.
  ["mcp/sigma-doc-mcp-server-core.ts", {
    reason: "refuses the removed props with a message naming them",
    lines: /^(?:maxWidth|autoSize),$|!== undefined|throw new Error/,
  }],
  ["mcp/sigma-doc-mcp-server.test.ts", {
    reason: "asserts the tool surface no longer offers them",
    lines: /not\.toHaveProperty/,
  }],
  ["src/lib/ai/sigma-doc-agent-tools.test.ts", {
    reason: "asserts the removed argument is refused",
    lines: /maxWidth: \d+,$/,
  }],
  ["src/lib/ai/mcp-edit-prompt.test.ts", {
    reason: "asserts the shape guide no longer teaches them",
    lines: /not\.toContain/,
  }],
  // Both boundaries that used to accept an older shape now refuse it, and each builds one to prove
  // the refusal.
  ["src/lib/sigma-doc-schema.test.ts", {
    reason: "pins that a legacy document fails to parse",
    lines: /autoSize: true,$/,
  }],
  ["src/lib/editor-clipboard.test.ts", {
    reason: "pins that a pasted legacy shape is refused",
    lines: /autoSize: true,$/,
  }],
  // `maxWidth` is also an ordinary English name for "how wide this may be". These own one as a
  // local or a CSS property, and none of them is about a text shape's box.
  ["src/features/drawing/graph-label-layout.ts", {
    reason: "a local: the widest of a graph's stacked labels",
    lines: /const maxWidth = |canvasSize\.width|props\.w - maxWidth/,
  }],
  ["src/features/drawing/image-insertion.ts", {
    reason: "a parameter: the width budget of a row of images",
    lines: /maxWidth: number,$|maxWidth <= 0|availableImageWidth = maxWidth/,
  }],
  ["src/components/editor/EditorShell.tsx", {
    reason: "a local: the outline pane's width clamp",
    lines: /const maxWidth = Math\.min|Math\.min\(maxWidth,/,
  }],
  ["src/components/editor/AiEditPanel.tsx", {
    reason: "the CSS property, and a local scaling a preview thumbnail",
    lines: /maxWidth: "100%"|const maxWidth = \d+;|maxWidth \/ safeWidth/,
  }],
  ["packages/viewer/src/SigmaDocViewer.tsx", {
    reason: "the CSS property, sizing the page to its container",
    lines: /maxWidth: `/,
  }],
]);

describe("the removed overlay text sizing model", () => {
  it("has no module left anywhere that measures overlay text without a DOM", () => {
    expect(mentions(everySourceFile(), DELETED_MEASUREMENT_MODULES)).toEqual([]);
  });

  it("has no prop left that fits a text box to its content", () => {
    const offenders = mentions(everySourceFile(), REMOVED_TEXT_SHAPE_PROPS)
      .filter((hit) => !EXEMPTIONS.get(hit.file)?.lines.test(hit.line));

    expect(offenders).toEqual([]);
  });

  /**
   * The documentation is part of the surface: `docs/mcp-local-app.md` is what a reader consults
   * before calling these tools, and it taught the removed arguments for as long as they existed.
   */
  it("has no documentation left that teaches the removed props", () => {
    expect(mentions(documentationFiles(), [...REMOVED_TEXT_SHAPE_PROPS, ...DELETED_MEASUREMENT_MODULES]))
      .toEqual([]);
  });

  it("keeps the exemption list honest: every listed file still names one", () => {
    const naming = new Set(mentions(everySourceFile(), REMOVED_TEXT_SHAPE_PROPS).map((hit) => hit.file));

    expect([...EXEMPTIONS.keys()].filter((file) => !naming.has(file))).toEqual([]);
  });
});

interface Mention {
  file: string;
  line: string;
}

function mentions(files: readonly string[], names: readonly string[]): Mention[] {
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\b`);
  return files.flatMap((file) => (
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => ({ file: relativeToDesktop(file), line: line.trim() }))
  ));
}

/** Every source file of the desktop app and the published viewer, tests included. */
function everySourceFile(): string[] {
  return [
    ...collect(new URL("../", import.meta.url)),
    ...collect(new URL("../../mcp/", import.meta.url)),
    ...collect(new URL("../../electron/", import.meta.url)),
    ...collect(new URL("../../../../packages/viewer/src/", import.meta.url)),
  ].filter((file) => !file.endsWith("overlay-text-model.test.ts"));
}

/** The Markdown under `docs/`, which describes the same tool surface in prose. */
function documentationFiles(): string[] {
  const root = new URL("../../../../docs/", import.meta.url);
  return collect(root, /\.md$/);
}

function collect(directory: URL, match = /\.tsx?$/): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return collect(new URL(`${entry.name}/`, directory), match);
    }
    return entry.isFile() && match.test(entry.name)
      ? [fileURLToPath(new URL(entry.name, directory))]
      : [];
  });
}

const DESKTOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** `src/...` and `mcp/...` for the desktop app, `packages/viewer/src/...` for the viewer. */
function relativeToDesktop(file: string): string {
  if (file.startsWith(DESKTOP_ROOT)) {
    return file.slice(DESKTOP_ROOT.length);
  }
  return file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length) : file;
}
