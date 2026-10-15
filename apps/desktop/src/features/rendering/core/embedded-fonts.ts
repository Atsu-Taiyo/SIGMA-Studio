import { documentFontReferences, type OverlaySnapshot } from "@/features/document";

/** Data-only resources travel with the document; source URLs and CSS are never accepted. */
export function embeddedDocumentFontCss(snapshot: OverlaySnapshot | undefined, applicationResources?: Readonly<Record<string, string>>): string {
  const resources = snapshot?.extensions?.["sigma.embedded-fonts"];
  const local = documentFontReferences(snapshot).flatMap(({ family, resourceId }) => {
    const source = applicationResources ? applicationResources[resourceId] : `sigma-app-font://${resourceId}/`;
    return source === `sigma-app-font://${resourceId}/`
      ? [`@font-face{font-family:"${family}";src:url("${source}");font-display:block;}`] : [];
  });
  if (!Array.isArray(resources) || resources.length > 32) return local.join("\n");
  return [...local, ...resources.flatMap((resource: unknown) => {
    if (!resource || typeof resource !== "object") return [];
    const { family, source } = resource as Record<string, unknown>;
    if (typeof family !== "string" || !/^[\p{L}\p{N} _-]{1,160}$/u.test(family)
      || typeof source !== "string" || source.length > 24*1024*1024
      || !/^data:font\/(?:ttf|otf|woff2?);base64,[A-Za-z0-9+/]+=*$/.test(source)) return [];
    return [`@font-face{font-family:"${family}";src:url("${source}");font-display:block;}`];
  })].join("\n");
}
