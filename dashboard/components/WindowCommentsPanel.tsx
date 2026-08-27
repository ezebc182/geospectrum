'use client';

/**
 * Hilo de conversación de la ventana analizada. Presentational puro: el
 * estado vive en use-window-comments, acá entran datos y salen callbacks.
 *
 * El botón de borrar aparece SOLO en los mensajes propios: el backend
 * respondería 404 para lo ajeno igual, pero ofrecer un botón que va a
 * fallar es mentirle al usuario.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { CommentsStatus, WindowComment } from '@/hooks/use-window-comments';

interface WindowCommentsPanelProps {
  comments: WindowComment[];
  status: CommentsStatus;
  currentUserEmail: string | null;
  onSend: (body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  /** Modo apunte: armar el clic-sobre-la-onda que fija el ancla. */
  annotateArmed?: boolean;
  onToggleAnnotate?: () => void;
  /** Ancla pendiente para el próximo mensaje (fijada por el clic en la onda). */
  pendingAnchorMs?: number | null;
  onClearAnchor?: () => void;
}

/** "12:01:00Z" — UTC explícito, igual que el resto de la pantalla. */
function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(11, 19)}Z`;
}

export function WindowCommentsPanel({
  comments,
  status,
  currentUserEmail,
  onSend,
  onDelete,
  annotateArmed = false,
  onToggleAnnotate,
  pendingAnchorMs = null,
  onClearAnchor,
}: WindowCommentsPanelProps) {
  const t = useTranslations('station');
  const [draft, setDraft] = useState('');
  const [failed, setFailed] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    try {
      await onSend(body);
      setDraft('');
      setFailed(false);
    } catch {
      // El borrador NO se limpia: perder el texto escrito por un hipo de red
      // es peor que mostrar el error.
      setFailed(true);
    }
  };

  return (
    <div className="mt-4 rounded border border-border p-4" data-testid="window-comments">
      <h3 className="mb-2 text-sm font-semibold text-foreground">{t('commentsTitle')}</h3>

      {status === 'error' && (
        <p className="mb-2 text-sm text-red-500">{t('commentsLoadError')}</p>
      )}

      {comments.length === 0 && status !== 'error' ? (
        <p data-testid="window-comments-empty" className="mb-2 text-sm text-muted-foreground">
          {t('commentsEmpty')}
        </p>
      ) : (
        <ul className="mb-3 space-y-2">
          {comments.map((comment) => (
            <li
              key={comment.id}
              data-testid="window-comment"
              className="flex items-start gap-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs text-muted-foreground">
                  {comment.authorEmail} · {timeLabel(comment.createdAt)}
                  {comment.anchorTimeMs !== null && (
                    <span className="ml-2 rounded bg-sky-500/15 px-1 text-sky-600">
                      ⚓ {timeLabel(new Date(comment.anchorTimeMs).toISOString())}
                    </span>
                  )}
                </span>
                <p className="whitespace-pre-wrap break-words text-foreground">{comment.body}</p>
              </div>
              {comment.authorEmail === currentUserEmail && (
                <button
                  type="button"
                  aria-label={t('commentsDelete')}
                  onClick={() => onDelete(comment.id).catch(() => setFailed(true))}
                  className="rounded bg-muted px-1.5 text-xs text-foreground hover:bg-muted/80"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {onToggleAnnotate && (
          <button
            type="button"
            data-testid="annotate-toggle"
            aria-pressed={annotateArmed}
            onClick={onToggleAnnotate}
            className={`rounded px-2 py-0.5 text-xs ${
              annotateArmed
                ? 'bg-sky-600 text-white'
                : 'bg-muted text-foreground hover:bg-muted/80'
            }`}
          >
            {annotateArmed ? t('commentsAnnotateArmed') : t('commentsAnnotate')}
          </button>
        )}
        {pendingAnchorMs !== null && (
          <span
            data-testid="pending-anchor"
            className="flex items-center gap-1 rounded bg-sky-500/15 px-2 py-0.5 font-mono text-xs text-sky-600"
          >
            ⚓ {timeLabel(new Date(pendingAnchorMs).toISOString())}
            <button
              type="button"
              aria-label={t('commentsClearAnchor')}
              onClick={onClearAnchor}
              className="rounded px-1 hover:bg-sky-500/20"
            >
              ×
            </button>
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          data-testid="window-comment-input"
          type="text"
          maxLength={500}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('commentsPlaceholder')}
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
        <button
          type="submit"
          className="rounded bg-muted px-3 py-1 text-sm text-foreground hover:bg-muted/80"
        >
          {t('commentsSend')}
        </button>
      </form>
      {failed && <p className="mt-1 text-xs text-red-500">{t('commentsSendError')}</p>}
    </div>
  );
}
