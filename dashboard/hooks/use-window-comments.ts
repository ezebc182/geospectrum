/**
 * Hilo de conversación de la ventana analizada (espejo de use-signal-picks:
 * las TRES invariantes de React del proyecto aplican acá igual).
 *
 * Colaborativo: la lista trae los mensajes de TODOS los usuarios; el borrado
 * solo funciona sobre los propios (el backend responde 404 para lo ajeno).
 */

import { useEffect, useRef, useState } from 'react';

import { seismicAPI, type WindowCommentRecord } from '@/lib/api';
import type { TimeWindow } from '@/lib/waveform-scale';

export interface WindowComment {
  id: string;
  body: string;
  authorEmail: string;
  createdAt: string;
  /** Instante anclado en la onda; null = mensaje común del hilo. */
  anchorTimeMs: number | null;
}

export type CommentsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseWindowCommentsResult {
  comments: WindowComment[];
  status: CommentsStatus;
  addComment: (body: string, anchorTimeMs?: number | null) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
}

function toComment(record: WindowCommentRecord): WindowComment {
  return {
    id: record.id,
    body: record.body,
    authorEmail: record.author_email,
    createdAt: record.created_at,
    anchorTimeMs: record.anchor_time === null ? null : Date.parse(record.anchor_time),
  };
}

export function useWindowComments(
  channel: string,
  window: TimeWindow | null,
): UseWindowCommentsResult {
  // INVARIANTE 1 — arranca vacío y se siembra por efecto: la ventana llega
  // de un fetch del helicorder, un useState(derivado) quedaría clavado.
  const [comments, setComments] = useState<WindowComment[]>([]);
  const [status, setStatus] = useState<CommentsStatus>('idle');

  // INVARIANTE 3 — el AbortController vive en un ref pero se USA dentro del
  // mismo efecto que lo crea.
  const abortRef = useRef<AbortController | null>(null);

  // Deps por NÚMERO, no por objeto (misma regla que use-wave-window).
  const startMs = window?.startMs;
  const endMs = window?.endMs;

  useEffect(() => {
    if (startMs === undefined || endMs === undefined) {
      setComments([]);
      setStatus('idle');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      try {
        const response = await seismicAPI.getWindowComments(channel, { startMs, endMs });
        if (cancelled || controller.signal.aborted) return;
        setComments(response.comments.map(toComment));
        setStatus('ready');
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setStatus('error');
      }
    };

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [channel, startMs, endMs]);

  const addComment = async (body: string, anchorTimeMs?: number | null) => {
    if (startMs === undefined || endMs === undefined) return;
    const created = await seismicAPI.createWindowComment(
      channel,
      { startMs, endMs },
      body,
      anchorTimeMs ?? null,
    );
    // Al FINAL: el hilo es cronológico y el backend ordena por created_at.
    setComments((current) => [...current, toComment(created)]);
  };

  const removeComment = async (commentId: string) => {
    await seismicAPI.deleteWindowComment(channel, commentId);
    setComments((current) => current.filter((c) => c.id !== commentId));
  };

  return { comments, status, addComment, removeComment };
}
