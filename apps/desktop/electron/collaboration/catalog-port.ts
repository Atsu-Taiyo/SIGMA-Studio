import type { CatalogSessionsPort } from "./catalog";
import type { CollaborationSessions } from "./sessions";

/** What the shared catalog reaches of the document sessions. `main.ts` and the tests wire it the same way. */
export function catalogSessionsPort(sessions: CollaborationSessions): CatalogSessionsPort {
  return {
    actorId: () => sessions.actorId(),
    request: (route, body) => sessions.request(route, body),
    bindings: () => sessions.bindings(),
    has: id => sessions.has(id),
    open: (id, sharedId) => sessions.openCatalogDocument(id, sharedId),
    export: async (id, sharedId) => {
      await sessions.openCatalogDocument(id, sharedId);
      return sessions.exportDocument(id);
    },
    previewVersion: id => sessions.previewVersion(id),
    preview: (id, sharedId, options) => sessions.previewCatalogDocument(id, sharedId, options),
    initialize: (id, sharedId, operationId, document, staged) => sessions.initializeCatalogDocument(id, sharedId, operationId, document, staged),
    activate: ids => sessions.activateCatalogDocuments(ids),
    start: (id, document) => sessions.start(id, document),
    flush: id => sessions.flush(id, true),
    recoverLocked: () => sessions.recoverLocked(),
    retainLocal: id => sessions.retainLocal(id),
    restrict: allowed => sessions.restrictCatalog(allowed),
  };
}
