import { readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";
import postcss from "postcss";

import { createBuildOptions, runtimeAliases } from "./build-options.mjs";

await build(createBuildOptions());

const stylesOutputPath = new URL("../dist/styles.css", import.meta.url).pathname;
await build({
  entryPoints: { styles: new URL("../src/styles.css", import.meta.url).pathname },
  outdir: new URL("../dist", import.meta.url).pathname,
  alias: runtimeAliases,
  assetNames: "assets/[name]-[hash]",
  bundle: true,
  entryNames: "[name]",
  logLevel: "info",
  minify: true,
  loader: {
    ".eot": "file",
    ".ttf": "file",
    ".woff": "file",
    ".woff2": "file",
  },
});

const bundledCss = await readFile(stylesOutputPath, "utf8");
const scopedCss = await postcss([{
  postcssPlugin: "sigma-viewer-css-scope",
  Rule(rule) {
    if (isInsideKeyframes(rule)) {
      return;
    }
    rule.selectors = rule.selectors.map(scopeSelector);
  },
}]).process(bundledCss, { from: stylesOutputPath, map: false });

const unscopedSelectors = [];
scopedCss.root.walkRules((rule) => {
  if (isInsideKeyframes(rule)) {
    return;
  }
  for (const selector of rule.selectors) {
    if (!isViewerScopedSelector(selector)) {
      unscopedSelectors.push(selector);
    }
  }
});
if (unscopedSelectors.length > 0) {
  throw new Error(`Viewer CSS contains unscoped selectors: ${unscopedSelectors.join(", ")}`);
}
await writeFile(stylesOutputPath, scopedCss.css);

function scopeSelector(selector) {
  const trimmed = selector.trim();
  if (isViewerScopedSelector(trimmed)) {
    return trimmed;
  }

  if (/^(?:html|body|:root)(?=$|[\s>+~.#:[\]])/i.test(trimmed)) {
    return trimmed
      .replace(/^(?:html|body|:root)/i, ".sigma-viewer")
      .replace(/^(\.sigma-viewer)\s+(?:html|body|:root)(?=$|[\s>+~.#:[\]])/i, "$1");
  }

  return `.sigma-viewer ${trimmed}`;
}

function isViewerScopedSelector(selector) {
  return /^\.sigma-viewer(?=$|[\s>+~.#:[\]])/.test(selector.trim());
}

function isInsideKeyframes(rule) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}
