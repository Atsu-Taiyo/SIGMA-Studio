import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../../tests/helpers/source-dependencies";

const shellUrl = new URL("../EditorShell.tsx", import.meta.url);
const shell = ts.createSourceFile("EditorShell.tsx", readFileSync(shellUrl, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function callNamed(name: string): ts.CallExpression {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(shell);
  expect(calls, name).toHaveLength(1);
  return calls[0];
}

function property(object: ts.Node, name: string): ts.Expression {
  expect(ts.isObjectLiteralExpression(object)).toBe(true);
  if (!ts.isObjectLiteralExpression(object)) throw new Error("Expected an explicit host port object");
  const value = object.properties.find((entry) => entry.name?.getText(shell) === name);
  expect(value, name).toBeDefined();
  if (value && ts.isShorthandPropertyAssignment(value)) return value.name;
  if (value && ts.isPropertyAssignment(value)) return value.initializer;
  throw new Error(`Expected an explicit ${name} port`);
}

describe("command routing ownership", () => {
  it("publishes one command route shared by keyboard, native menu and palette", () => {
    const imports = getModuleSpecifiers(shell.text, { resolveFrom: {
      sourceFile: fileURLToPath(shellUrl),
      sourceRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    } });
    expect(imports).toEqual(expect.arrayContaining([
      "@/components/editor/editor-shell/use-editor-command-routing",
      "@/components/editor/editor-shell/use-command-palette",
      "@/components/editor/editor-shell/use-desktop-menu-actions",
    ]));
    for (const name of ["useEditorCommandRouting", "useCommandPalette", "useDesktopMenuActions"]) {
      expect(property(callNamed(name).arguments[0], "runShortcutCommandRef").getText(shell)).toBe("runShortcutCommandRef");
    }
    const keyboard = property(callNamed("useEditorCommandRouting").arguments[0], "keyboard");
    expect(property(keyboard, "isModalSurfaceOpen").getText(shell)).toBe("isModalSurfaceOpen");
    expect(property(callNamed("useDesktopMenuActions").arguments[0], "isModalSurfaceOpen").getText(shell)).toBe("isModalSurfaceOpen");
  });

  it("passes host operations unchanged and projects selection policy without reading feature stores", () => {
    const routing = callNamed("useEditorCommandRouting").arguments[0];
    const actions = property(routing, "actions");
    for (const group of ["text", "overlay", "menus", "application"]) {
      const ports = property(actions, group);
      expect(ts.isObjectLiteralExpression(ports)).toBe(true);
      if (!ts.isObjectLiteralExpression(ports)) throw new Error("Expected explicit action ports");
      for (const port of ports.properties) {
        const name = port.name?.getText(shell);
        expect(name).toBeDefined();
        expect(property(ports, name!).getText(shell), `${group}.${name}`).toBe(name);
      }
    }
    const keyboard = property(routing, "keyboard");
    expect(property(keyboard, "uiLayoutMode").getText(shell)).toBe("uiLayoutPreference.mode");
    expect(property(keyboard, "overlaySelectionLocked").getText(shell)).toBe("overlaySelection.locked");
    expect(property(keyboard, "blockedOverlaySelection").getText(shell)).toBe("aiLockedOverlaySelection");
  });
});
