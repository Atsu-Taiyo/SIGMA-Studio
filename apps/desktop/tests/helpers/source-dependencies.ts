import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import ts from "typescript";

export interface SourceDependency {
  kind: "import" | "export" | "dynamic-import" | "require" | "import-equals" | "import-type";
  specifier: string | null;
  typeOnly: boolean;
}

export interface SourceDependencyResolution {
  sourceFile: string;
  sourceRoot: string;
}

/** Give equivalent local spellings one identity before applying a layer's dependency rules. */
function resolveModuleSpecifier(specifier: string, { sourceFile, sourceRoot }: SourceDependencyResolution): string {
  const target = specifier.startsWith("@/")
    ? resolve(sourceRoot, specifier.slice(2))
    : specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(dirname(sourceFile), specifier)
      : null;
  if (target === null) return specifier;

  // Resolution is lexical: a forbidden edge must be caught even before its target exists.
  // Keep an escaping `../` in the canonical result, so it cannot look like an allowed source root.
  const localPath = relative(resolve(sourceRoot), target).split(sep).join("/")
    .replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "")
    .replace(/(?:^|\/)index$/, "");
  return `@/${localPath}`;
}

const dependencyCache = new Map<string, readonly SourceDependency[]>();
const MAX_CACHED_SOURCES = 256;

function parseSource(source: string): ts.SourceFile {
  const failures: string[] = [];
  for (const kind of [ts.ScriptKind.TS, ts.ScriptKind.TSX]) {
    const parsed = ts.createSourceFile("boundary", source, ts.ScriptTarget.Latest, false, kind);
    // createSourceFile always records parser diagnostics, but SourceFile's public
    // declaration omits them. Never walk a recovered tree: TSX recovery can consume
    // the rest of a valid .ts file as JSX text after a generic arrow or type assertion.
    const diagnostics = (parsed as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[];
    }).parseDiagnostics;
    if (diagnostics.length === 0) return parsed;
    failures.push(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " "));
  }
  throw new Error(`Cannot parse source dependencies as TypeScript or TSX: ${failures.join(" / ")}`);
}

/** Inspect syntax, so comments, strings, and type-only bindings cannot masquerade as runtime edges. */
export function getSourceDependencies(
  source: string,
  resolution?: SourceDependencyResolution,
): readonly SourceDependency[] {
  if (resolution) {
    return getSourceDependencies(source).map((dependency) => ({
      ...dependency,
      specifier: dependency.specifier === null
        ? null
        : resolveModuleSpecifier(dependency.specifier, resolution),
    }));
  }
  const cached = dependencyCache.get(source);
  if (cached) return cached;
  const parsed = parseSource(source);
  const dependencies: SourceDependency[] = [];
  const add = (kind: SourceDependency["kind"], expression: ts.Node | undefined, typeOnly: boolean) => {
    dependencies.push({
      kind,
      specifier: expression && ts.isStringLiteralLike(expression) ? expression.text : null,
      typeOnly,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || Boolean(
        clause && !clause.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly),
      );
      add("import", node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const bindings = node.exportClause;
      const typeOnly = node.isTypeOnly || Boolean(
        bindings && ts.isNamedExports(bindings) && bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly),
      );
      add("export", node.moduleSpecifier, typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add("import-equals", node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add("import-type", node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add("dynamic-import", node.arguments[0], false);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("require", node.arguments[0], false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (dependencyCache.size >= MAX_CACHED_SOURCES) {
    dependencyCache.delete(dependencyCache.keys().next().value!);
  }
  dependencyCache.set(source, dependencies);
  return dependencies;
}

/** Boundary checks must account for every edge, including re-exports and deferred imports. */
export function getModuleSpecifiers(
  source: string,
  options: { allowComputed?: boolean; resolveFrom?: SourceDependencyResolution } = {},
): string[] {
  return getSourceDependencies(source, options.resolveFrom).flatMap((dependency) => {
    if (dependency.specifier === null) {
      if (options.allowComputed) return [];
      throw new Error(`Cannot verify a computed ${dependency.kind} dependency in an architecture boundary.`);
    }
    return [dependency.specifier];
  });
}
