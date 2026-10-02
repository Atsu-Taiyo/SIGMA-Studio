"use client";

import { type SigmaDocument } from "@/features/document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { ensureEditableBody } from "@/lib/document-tree";
import { useCallback,useEffect,useRef } from "react";
import { documentHistoryKey } from "./document-history-key";
import type { EmbeddedEditorHost } from "./document-lifecycle-types";

interface EmbeddedDocumentPorts {
  embeddedHost?: EmbeddedEditorHost;
  document: SigmaDocument;
  initialDocument: SigmaDocument;
  currentDocument: () => SigmaDocument;
  acceptDocument: (document: SigmaDocument) => void;
}
export function useEmbeddedDocumentSync({ embeddedHost, document, initialDocument, currentDocument, acceptDocument }: EmbeddedDocumentPorts) {
  const lastEmbeddedInputRef = useRef(embeddedHost?.document);
  const lastEmittedEmbeddedDocumentRef = useRef(document);
  // ホストのonSaveがawait後に古いスナップショットをonChange経由で送り返す(エコー)
  // ことがある。それを外部更新と誤認してresetEditorDocumentを呼ぶと、再度dirty化
  // →自動保存→再エコー…と自走するループになる(スピナーが止まらない/入力が
  // フリッカーする不具合の原因)。ここではエディタ自身がembeddedHost.onChangeへ
  // 渡した文書のdocumentHistoryKeyを直近MAX_EMBEDDED_ECHO_KEYS件だけ覚えておき、
  // 同じdocId内でそのキーが戻ってきたらエコーとして無視する。docIdが変わる本物の
  // ドキュメント切替はこの記録に関わらず常に受け入れる。
  const MAX_EMBEDDED_ECHO_KEYS = 50;
  const emittedEchoKeysRef = useRef<Set<string>>(
    new Set(embeddedHost ? [documentHistoryKey(initialDocument)] : []),
  );
  const rememberEmittedEchoKey = useCallback((key: string) => {
    const seen = emittedEchoKeysRef.current;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (seen.size > MAX_EMBEDDED_ECHO_KEYS) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
  }, []);

  useEffect(() => {
    const nextInput = embeddedHost?.document;
    if (!nextInput || nextInput === lastEmbeddedInputRef.current) {
      return;
    }
    lastEmbeddedInputRef.current = nextInput;

    // ホストが本文の空な文書を送り続けても往復しないよう、比較は「直したあと」で行う
    // (`ensureEditableBody` は冪等・id 固定なので、直した結果は毎回同じ値になる)。
    const nextDocument = ensureEditableBody(nextInput).document;
    if (
      nextDocument === currentDocument()
      || areSigmaDocumentsEquivalent(nextDocument, currentDocument())
    ) {
      return;
    }

    const isGenuineDocumentSwitch = nextInput.docId !== currentDocument().docId;
    if (!isGenuineDocumentSwitch && emittedEchoKeysRef.current.has(documentHistoryKey(nextInput))) {
      return;
    }

    lastEmittedEmbeddedDocumentRef.current = nextInput;
    acceptDocument(nextDocument);
  }, [embeddedHost?.document, currentDocument, acceptDocument]);

  useEffect(() => {
    if (!embeddedHost || document === lastEmittedEmbeddedDocumentRef.current) {
      return;
    }
    lastEmittedEmbeddedDocumentRef.current = document;
    rememberEmittedEchoKey(documentHistoryKey(document));
    embeddedHost.onChange(document);
  }, [document, embeddedHost, rememberEmittedEchoKey]);

 }
