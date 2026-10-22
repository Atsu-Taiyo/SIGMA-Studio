"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LogOut, RefreshCw, Search } from "lucide-react";
import { EditorShell } from "@/components/editor/EditorShell";
import { Button } from "@/components/ui/Button";
import { APP_READY_EVENT } from "@/components/StartupSplash";
import { useT } from "@/lib/i18n/react";
import type { DocumentSessionHost } from "@/features/document-session/contracts";
import type { CollaborationProfile, SessionInfo } from "../model/bridge";
import type { CatalogNode } from "../model/catalog";
import { RendererDocumentSession } from "../renderer/session";
import { BrowserSharedClient, webRequest } from "./client";
import styles from "./SharedWebApp.module.css";

function locationName(node: CatalogNode, nodes: CatalogNode[]): string {
  const result: string[] = [], seen = new Set([node.id]);
  let parent = node.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const item = nodes.find(item => item.id === parent);
    if (!item) break;
    result.unshift(item.name); parent = item.parentId;
  }
  return result.join(" / ");
}

export function SharedWebApp() {
  const t = useT("workspace");
  const [client, setClient] = useState<BrowserSharedClient | null>(null);
  const clientRef = useRef<BrowserSharedClient | null>(null);
  const [nodes, setNodes] = useState<CatalogNode[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<{ info: SessionInfo; session: RendererDocumentSession } | null>(null);
  const openedRef = useRef(opened);
  useEffect(() => { openedRef.current = opened; }, [opened]);

  useEffect(() => {
    let active = true;
    void webRequest<{ user: CollaborationProfile }>("/api/auth/session").then(async result => {
      if (!active) return;
      const next = new BrowserSharedClient(result.user);
      clientRef.current = next; setClient(next);
      try { const catalog = await next.catalog(); if (active) setNodes(catalog); }
      catch (error) {
        // Report only a machine code/type, never catalog data or credentials.
        console.error("Shared catalog request failed", error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : error instanceof Error ? error.name : "UNKNOWN_ERROR");
        if (active) setError(t("webShared.loadFailed"));
      }
    }).catch((error: unknown) => {
      if (active && !(error instanceof Error && error.message === "AUTH_REQUIRED"))
        setError(t(error instanceof Error && error.message === "WEB_NOT_CONFIGURED" ? "webShared.notConfigured" : "webShared.loadFailed"));
    }).finally(() => { if (active) { setBusy(false); window.dispatchEvent(new Event(APP_READY_EVENT)); } });
    return () => {
      active = false;
      const session = openedRef.current?.session, current = clientRef.current;
      clientRef.current = null;
      current?.visible(null);
      void (async () => {
        try { await session?.flush(); }
        finally { session?.destroy(); await current?.close(); }
      })().catch(() => {});
    };
  }, [t]);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); }
    catch (error) { setError(t(error instanceof Error && error.message === "DOCUMENT_ALREADY_OPEN" ? "webShared.alreadyOpen" : error instanceof Error && /EPOCH/.test(error.message) ? "webShared.epochChanged" : "webShared.actionFailed")); }
    finally { setBusy(false); }
  }, [t]);
  const refresh = () => void run(async () => { if (client) setNodes(await client.catalog()); });
  const login = () => void run(async () => {
    const result = await webRequest<{ url: string }>("/api/auth/login", {}), url = new URL(result.url);
    if (url.pathname !== "/auth/v1/authorize" || url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw new Error("INVALID_AUTH_URL");
    location.assign(url.href);
  });
  const leave = () => void run(async () => {
    if (!client || !opened) return;
    await opened.session.flush(); client.visible(null); opened.session.destroy(); await client.release(opened.info.binding.localFileId); setOpened(null); setNodes(await client.catalog());
  });
  const logout = () => void run(async () => {
    if (opened) { await opened.session.flush(); await client?.flush(opened.info.binding.localFileId, true); }
    await webRequest("/api/auth/logout", {});
    opened?.session.destroy(); await client?.close(); clientRef.current = null;
    setOpened(null); setClient(null); setNodes([]);
  });
  const open = (node: CatalogNode) => void run(async () => {
    if (!client || !node.sharedDocumentId) return;
    const info = await client.open(node.sharedDocumentId);
    setOpened({ info, session: new RendererDocumentSession(info, client.bridge) });
  });
  useEffect(() => {
    if (!client || !opened) return;
    return client.bridge.onEvent(event => opened.session.receive(event));
  }, [client, opened]);
  useEffect(() => {
    if (!client) return;
    const visible = () => client.visible(document.visibilityState === "hidden" ? null : opened?.info.binding.localFileId ?? null);
    const hide = () => client.visible(null);
    const compositionStart = () => opened?.session.composition(true);
    const compositionEnd = () => opened?.session.composition(false);
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible); window.addEventListener("pagehide", hide);
    window.addEventListener("compositionstart", compositionStart, true); window.addEventListener("compositionend", compositionEnd, true);
    visible();
    return () => {
      client.visible(null); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); window.removeEventListener("pagehide", hide);
      window.removeEventListener("compositionstart", compositionStart, true); window.removeEventListener("compositionend", compositionEnd, true);
    };
  }, [client, opened]);
  const host = useMemo<DocumentSessionHost>(() => ({
    get: file => opened?.info.binding.localFileId === file ? opened.session : undefined,
    isReadOnly: file => opened?.info.binding.localFileId !== file,
  }), [opened]);
  const initialDocument = useMemo(() => opened?.session.project(), [opened]);
  const files = nodes.filter(node => node.kind === "document" && `${node.name} ${locationName(node, nodes)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (opened && client) return <div className={styles.editor}>
    <div className={styles.editorNavigation}><Button size="sm" onClick={leave} disabled={busy}><ArrowLeft size={14} />{t("webShared.back")}</Button>{error && <span role="alert">{error}</span>}</div>
    <EditorShell key={opened.info.binding.sharedDocumentId} sessionHost={host}
      embeddedHost={{ document: initialDocument!, onChange: () => {}, onSave: () => opened.session.flush() }}
      commentIdentity={{ userId: client.user.actorId, name: client.user.displayName || client.user.email || client.user.actorId }} />
  </div>;
  return <main className={styles.page}>
    <header className={styles.header}><div><div className={styles.brand}>Σ Studio</div><h1>{t("webShared.title")}</h1></div>
      {client && <div className={styles.actions}><span>{client.user.displayName || client.user.email}</span>
        <Button onClick={refresh} disabled={busy}><RefreshCw size={16} />{t("webShared.refresh")}</Button>
        <Button onClick={logout} disabled={busy}><LogOut size={16} />{t("webShared.logout")}</Button></div>}</header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!client ? <section className={styles.login}><p>{t("webShared.loginHelp")}</p><Button tone="primary" onClick={login} disabled={busy}>{t(busy ? "webShared.loading" : "webShared.login")}</Button></section> : <>
      <label className={styles.search}><Search size={16} /><input type="search" aria-label={t("webShared.search")} placeholder={t("webShared.search")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <p className={styles.help}>{t("webShared.help")}</p>
      {busy ? <div className={styles.skeleton} aria-label={t("webShared.loading")} /> : files.length ?
        <table className={styles.table}><thead><tr><th>{t("webShared.name")}</th><th>{t("webShared.location")}</th><th>{t("webShared.permission")}</th></tr></thead>
          <tbody>{files.map(node => <tr key={node.id}><td><button type="button" onClick={() => open(node)}>{node.name}</button></td><td>{locationName(node, nodes)}</td><td>{t(node.role === "viewer" ? "webShared.viewer" : "webShared.editor")}</td></tr>)}</tbody></table>
        : <p className={styles.help}>{t("webShared.empty")}</p>}
    </>}
  </main>;
}
