import path from "node:path";

import ts from "typescript";

/** Compile an external consumer against this package's freshly emitted declarations. */
export function checkPublicTypeConsumer(
  packageRoot: string,
  source: string,
  resolution: "Bundler" | "NodeNext",
): string[] {
  const configPath = path.join(packageRoot, "tsconfig.build.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return formatErrors([configFile.error]);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot, {}, configPath);
  const declarations = new Map<string, string>();
  const buildProgram = ts.createProgram(config.fileNames, config.options);
  const emitted = buildProgram.emit(undefined, (fileName, text) => {
    if (fileName.endsWith(".d.ts")) declarations.set(path.resolve(fileName), text);
  });
  const buildErrors = formatErrors([
    ...config.errors,
    ...ts.getPreEmitDiagnostics(buildProgram),
    ...emitted.diagnostics,
  ]);
  if (buildErrors.length) return buildErrors;

  // A package self-reference uses its actual package.json exports, just like an
  // installed consumer. Only generated declaration contents are supplied in
  // memory; TypeScript owns all package and relative-specifier resolution.
  const consumerPath = path.join(packageRoot, "__public_type_consumer__.mts");
  const sources = new Map(declarations).set(consumerPath, source);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2021,
    module: resolution === "Bundler" ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: resolution === "Bundler"
      ? ts.ModuleResolutionKind.Bundler
      : ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => sources.get(path.resolve(fileName)) ?? readFile(fileName);
  host.fileExists = (fileName) => sources.has(path.resolve(fileName)) || fileExists(fileName);
  host.directoryExists = (directoryName) => (
    [...sources.keys()].some((fileName) => fileName.startsWith(`${path.resolve(directoryName)}${path.sep}`))
    || directoryExists?.(directoryName) === true
  );
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(path.resolve(fileName));
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };

  const consumerProgram = ts.createProgram([consumerPath], options, host);
  const errors = formatErrors(ts.getPreEmitDiagnostics(consumerProgram));
  const entryPath = path.join(packageRoot, "dist/index.d.ts");
  if (consumerProgram.getSourceFile(entryPath)?.text !== declarations.get(entryPath)) {
    errors.push("The consumer did not load the freshly emitted public entrypoint declarations.");
  }
  return errors;
}

function formatErrors(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      return diagnostic.file ? `${diagnostic.file.fileName}: ${message}` : message;
    });
}
