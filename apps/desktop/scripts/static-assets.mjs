import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import postcss from "postcss";

function normalizeMediaUrl(url, cssFile, exportDirectory) {
  // Next's desktop assetPrefix is relative to the HTML entry point. CSS asset
  // URLs must instead be relative to the stylesheet that contains them.
  const match = /^(?:\.\/)?(_next\/static\/media\/[^?#]+)([?#].*)?$/.exec(url);
  if (!match || match[1].split("/").some((segment) => segment === "." || segment === "..")) return url;
  const target = path.join(exportDirectory, ...match[1].split("/"));
  return path.relative(path.dirname(cssFile), target).split(path.sep).join("/") + (match[2] ?? "");
}

function normalizeValueUrls(value, cssFile, exportDirectory) {
  let index = 0, copiedThrough = 0, rewrittenUrls = 0;
  const pieces = [];
  while (index < value.length) {
    if (value.startsWith("/*", index)) {
      const end = value.indexOf("*/", index + 2);
      index = end < 0 ? value.length : end + 2;
      continue;
    }
    if (value[index] === "'" || value[index] === '"') {
      const quote = value[index++];
      while (index < value.length) {
        if (value[index] === "\\") index += 2;
        else if (value[index++] === quote) break;
      }
      continue;
    }
    const match = /^(?:url)\((\s*)(?:(["'])([^"'\\]*)\2|([^"'()\\]*?))(\s*)\)/i.exec(value.slice(index));
    if (match && (index === 0 || !/[\w-]/.test(value[index - 1]))) {
      const url = match[3] ?? match[4].trim();
      const normalized = normalizeMediaUrl(url, cssFile, exportDirectory);
      if (normalized !== url) {
        pieces.push(value.slice(copiedThrough, index), match[0].replace(url, () => normalized));
        copiedThrough = index + match[0].length;
        rewrittenUrls++;
      }
      index += match[0].length;
    } else index++;
  }
  pieces.push(value.slice(copiedThrough));
  return { value: pieces.join(""), rewrittenUrls };
}

/** Preserve valid URLs, strings, comments and CSS formatting while fixing media paths. */
export function normalizeExportedCssAssetUrls(css, { cssFile, exportDirectory }) {
  const stylesheet = postcss.parse(css, { from: cssFile });
  let rewrittenUrls = 0;
  const normalize = (node, property) => {
    const result = normalizeValueUrls(node[property], cssFile, exportDirectory);
    node[property] = result.value;
    rewrittenUrls += result.rewrittenUrls;
  };
  stylesheet.walkDecls((node) => normalize(node, "value"));
  stylesheet.walkAtRules((node) => normalize(node, "params"));
  return { css: rewrittenUrls ? stylesheet.toString() : css, rewrittenUrls };
}

/** Called only for a completed static build; development watch leaves out untouched. */
export async function normalizeExportedCssAssets(exportDirectory) {
  let entries;
  try {
    entries = await readdir(exportDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { rewrittenFiles: 0, rewrittenUrls: 0 };
    throw error;
  }
  let rewrittenFiles = 0, rewrittenUrls = 0;
  const visit = async (directory, children) => {
    for (const entry of children) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename, await readdir(filename, { withFileTypes: true }));
      else if (entry.isFile() && entry.name.endsWith(".css")) {
        const css = await readFile(filename, "utf8");
        const result = normalizeExportedCssAssetUrls(css, { cssFile: filename, exportDirectory });
        if (result.rewrittenUrls) {
          await writeFile(filename, result.css);
          rewrittenFiles++;
          rewrittenUrls += result.rewrittenUrls;
        }
      }
    }
  };
  await visit(exportDirectory, entries);
  return { rewrittenFiles, rewrittenUrls };
}
