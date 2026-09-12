import { describe, expect, it } from "vitest";
import { readStylesheet as readFileSync } from "../../../tests/helpers/read-stylesheet";

import { SPACE_TOKENS } from "./layout";

describe("design tokens", () => {
  it("defines every typed spacing token in the global theme", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    for (const token of SPACE_TOKENS) {
      expect(css).toContain(`--space-${token}:`);
    }
  });

  it("defines the shared surface tokens documented by the UI system", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    for (const token of [
      "radius-control",
      "radius-round",
      "radius-panel",
      "radius-dialog",
      "shadow-floating",
      "z-modal",
      "z-modal-nested",
      "z-tooltip",
    ]) {
      expect(css).toContain(`--${token}:`);
    }
  });

  it("keeps icon-only buttons circular through the shared round token", () => {
    const buttonCss = readFileSync(new URL("./Button.module.css", import.meta.url), "utf8");
    const globalCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    expect(buttonCss).toMatch(
      /\.button\[data-icon-only="true"\]\s*\{[^}]*border-radius:\s*var\(--radius-round\);/,
    );
    expect(globalCss).toMatch(
      /\.ai-chat-icon-button,\s*\.ai-chat-send-button\s*\{[^}]*border-radius:\s*var\(--radius-round\);/,
    );
  });

  it("wraps an exclusive choice in a soft grey face rather than a heavier border", () => {
    // `docs/design-rules.md`: 選択中は濃い枠線でなく薄いグレーの面。A thicker border on selection
    // would also move the card, since the unselected state already reserves 1px.
    const css = readFileSync(new URL("./ChoiceGroup.module.css", import.meta.url), "utf8");
    const selected = /\.option\[data-selected="true"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(selected).toContain("background: var(--surface-muted);");
    expect(selected).not.toMatch(/border-width|border:\s/);
    // The face is not the only signal: the card also takes a border colour and a text-colour step,
    // so the state survives being seen without colour.
    expect(selected).toContain("border-color: var(--border-subtle);");
    expect(selected).toContain("color: var(--text-primary);");
  });

  it("keeps the choice card's resting label readable and its focus ring visible", () => {
    const css = readFileSync(new URL("./ChoiceGroup.module.css", import.meta.url), "utf8");
    const base = /\.option\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const focus = /\.option:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    // `--text-muted` (#8a8a8a) at 11px is ~3:1 — below the 4.5:1 AA floor for the primary label of
    // an interactive control. `--text-secondary` (#555) is what the sibling pickers use.
    expect(base).toContain("color: var(--text-secondary);");
    // A ring mixed down to a pale tint cannot carry the focus indicator on its own, and arrow keys
    // move focus onto the already-grey selected card — so it has to be a solid accent.
    expect(focus).toMatch(/outline:\s*2px solid var\(--accent\);/);
  });

  it("wraps a long choice label instead of clipping it", () => {
    // 300px panel / 4 columns leaves ~56px per card: `折れ線グラフ` and `Scatter plot` both need
    // more, and `docs/design-rules.md` prescribes wrapping rather than an ellipsis.
    const css = readFileSync(new URL("./ChoiceGroup.module.css", import.meta.url), "utf8");
    const label = /\.label\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(label).not.toContain("text-overflow");
    expect(label).not.toContain("nowrap");
  });

  it("keeps the choice card on shared spacing and radius tokens, with no shadow", () => {
    const css = readFileSync(new URL("./ChoiceGroup.module.css", import.meta.url), "utf8");
    const option = /\.option\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(option).toContain("border-radius: var(--radius-control);");
    expect(option).toMatch(/padding:\s*var\(--space-[a-z0-9]+\)/);
    expect(css).not.toContain("box-shadow");
  });

  it("leaves no chart settings rule reaching for a token the theme never defines", () => {
    // `var(--color-text-muted, #6b7280)` reads as a token but always falls through to the literal,
    // which is a different grey from `--text-muted` and outside the monochrome scale.
    const globalCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

    // Scoped to the chart-settings rules this WI touched, and to *reads* of the name: a whole-file
    // ban would also fire the day someone legitimately defines such a token.
    for (const rule of [".chart-settings-source", ".chart-settings-source.broken", ".chart-settings-hint"]) {
      const body = new RegExp(`\\${rule}\\s*\\{([^}]*)\\}`).exec(globalCss)?.[1] ?? "";
      expect(body, rule).not.toMatch(/var\(--color-[a-z-]+/);
      expect(body, rule).toMatch(/color:\s*var\(--(text-secondary|danger)\);/);
    }
  });

  it("gives the chart title input exactly one focus treatment", () => {
    // A second `:focus-visible` block at the same specificity does not replace the first, it wins
    // per-property: the later `outline` overrode `outline: none` and the field drew a ring *and*
    // an outline at once. Counting the rule is what catches that, since both blocks look fine
    // read on their own.
    const globalCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const blocks = [...globalCss.matchAll(/\.chart-settings-text-input:focus-visible\s*\{([^}]*)\}/g)];

    expect(blocks).toHaveLength(1);
    // The house idiom for this family of inputs (`.graph-number-input`): move the border to the
    // accent and add a soft ring, rather than painting a separate outline.
    expect(blocks[0][1]).toContain("border-color: var(--accent);");
    expect(blocks[0][1]).toContain("outline: none;");
  });

  it("keeps modal stacking on shared tokens instead of feature-level overrides", () => {
    const globalCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const modalCss = readFileSync(new URL("./Modal.module.css", import.meta.url), "utf8");

    expect(modalCss).toContain("z-index: var(--z-modal);");
    expect(modalCss).toContain("z-index: var(--z-modal-nested);");
    expect(globalCss).toMatch(
      /\.table-settings-backdrop\s*\{[^}]*z-index:\s*var\(--z-modal\);/,
    );
    expect(globalCss).not.toMatch(/\.ai-chat-room-dialog-backdrop[^{}]*\{[^}]*z-index:/);
  });

  it("keeps portalled tooltips above shared modal layers", () => {
    const tooltipCss = readFileSync(new URL("./Tooltip.module.css", import.meta.url), "utf8");

    expect(tooltipCss).toContain("z-index: var(--z-tooltip);");
  });

  it("dismisses shared and legacy app modals from pointer input on their backdrop", () => {
    const modalSource = readFileSync(new URL("./Modal.tsx", import.meta.url), "utf8");
    expect(modalSource).toContain("onPointerDown={handlePointerDown}");
    expect(modalSource).toContain("event.target === event.currentTarget");

    for (const path of [
      "../editor/PageSettingsDialog.tsx",
      "../editor/TableSettingsDialog.tsx",
      "../editor/EditorShell.tsx",
      "../editor/editor-shell/material-dialogs.tsx",
      "../templates/TemplateGallery.tsx",
      "../print/PdfExportSuccessDialog.tsx",
      "../workspace/WorkspaceCreateDialog.tsx",
      "../workspace/WorkspaceDeleteDialog.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain('data-modal-backdrop=""');
      expect(source).toContain("onPointerDown");
    }
  });

  it("keeps interactive popovers inside a modal's isolation and focus scope", () => {
    const modalSource = readFileSync(new URL("./Modal.tsx", import.meta.url), "utf8");
    const popoverSource = readFileSync(new URL("../editor/ToolbarPopover.tsx", import.meta.url), "utf8");
    const tableDialogSource = readFileSync(new URL("../editor/TableSettingsDialog.tsx", import.meta.url), "utf8");

    expect(popoverSource).toContain('closest<HTMLElement>("[data-modal-backdrop]")');
    expect(popoverSource).toContain('data-toolbar-popover=""');
    expect(popoverSource).toContain('event.key !== "Escape"');
    expect(modalSource).toContain("getFocusableElements(backdrop)");
    expect(modalSource).toContain("backdrop.contains(event.target as Node)");
    expect(tableDialogSource).toContain('data-modal-backdrop=""');
  });
});
