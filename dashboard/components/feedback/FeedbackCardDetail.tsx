'use client';

/**
 * Detalle de una tarjeta del tablero de feedback (design, Decision 6):
 * body completo como texto plano (`whitespace-pre-wrap`, jamás HTML
 * inyectado), contexto técnico (ruta, URL como link seguro,
 * navegador) y, si la tarjeta ya se movió, desde cuándo está en su columna.
 *
 * Con `canManage` agrega el editor del comentario del admin: un solo campo
 * precargado con el comentario vigente, "Guardar" manda el texto y "Vaciar"
 * manda `null` (el backend borra el par comentario/timestamp).
 */

import * as React from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FeedbackReport, FeedbackStatus } from '@/lib/feedback';
import { cn } from '@/lib/utils';

/** Tope espejo del CHECK de `admin_comment` (migración 019). */
const MAX_COMMENT = 2000;

/** Formato de fecha compartido por tarjeta y detalle: día legible + hora en
 * 24 h. Va inline (no en `formats`) porque la zona la aporta el provider. */
export const CARD_DATE_FORMAT = {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
} as const;

// Mismas clases que el textarea del widget (no existe ui/textarea.tsx).
const TEXTAREA_CLASS =
  'min-h-24 w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30';

interface FeedbackCardDetailProps {
  report: FeedbackReport;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComment: (id: string, comment: string | null) => void;
}

interface CommentEditorProps {
  report: FeedbackReport;
  onComment: (id: string, comment: string | null) => void;
}

/** Editor del comentario del admin. Se monta con `key={admin_comment}` desde
 * el detalle: si el backend revierte el comentario (rollback), el borrador
 * vuelve al valor vigente en vez de quedar mostrando algo que no se guardó. */
function CommentEditor({ report, onComment }: CommentEditorProps) {
  const t = useTranslations('feedback.comment');
  const [draft, setDraft] = React.useState(report.admin_comment ?? '');
  const trimmed = draft.trim();

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`feedback-comment-${report.id}`} className="text-sm font-medium">
        {t('label')}
      </label>
      <textarea
        id={`feedback-comment-${report.id}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={MAX_COMMENT}
        placeholder={t('placeholder')}
        className={TEXTAREA_CLASS}
      />
      <p className="text-right text-xs text-muted-foreground" aria-live="polite">
        {t('counter', { count: String(draft.length), max: String(MAX_COMMENT) })}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={report.admin_comment === null && trimmed.length === 0}
          onClick={() => onComment(report.id, null)}
        >
          {t('clear')}
        </Button>
        <Button type="button" size="sm" disabled={trimmed.length === 0} onClick={() => onComment(report.id, trimmed)}>
          {t('save')}
        </Button>
      </div>
    </div>
  );
}

export function FeedbackCardDetail({ report, canManage, open, onOpenChange, onComment }: FeedbackCardDetailProps) {
  const t = useTranslations('feedback');
  const format = useFormatter();
  const status: FeedbackStatus = report.status;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('board.detailTitle')}</DialogTitle>
          <DialogDescription>
            {t('board.createdAt', { date: format.dateTime(new Date(report.created_at), CARD_DATE_FORMAT) })}
            {' · '}
            {report.author_email}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={report.type === 'bug' ? 'destructive' : 'secondary'}>{t(`widget.types.${report.type}`)}</Badge>
          <Badge variant={status === 'discarded' ? 'outline' : 'default'}>{t(`status.${status}`)}</Badge>
          {/* `status_changed_at` es null hasta el primer movimiento: sin fecha no
              se muestra nada (spec: "el detalle lo muestra solo cuando existe"). */}
          {report.status_changed_at !== null && (
            <span className="text-muted-foreground">
              {t('board.movedAt', { date: format.dateTime(new Date(report.status_changed_at), CARD_DATE_FORMAT) })}
            </span>
          )}
        </div>

        <p className="text-sm whitespace-pre-wrap break-words">{report.body}</p>

        {!canManage && report.admin_comment !== null && (
          <div data-slot="admin-comment" className="rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2 text-sm">
            <p className="text-xs font-medium text-primary">{t('comment.label')}</p>
            <p className="whitespace-pre-wrap break-words">{report.admin_comment}</p>
          </div>
        )}

        {canManage && <CommentEditor key={report.admin_comment ?? ''} report={report} onComment={onComment} />}

        <section aria-label={t('board.technicalContext')} className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">{t('board.technicalContext')}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t('board.route')}</dt>
            <dd className="break-all font-mono">{report.route}</dd>
            <dt className="text-muted-foreground">{t('board.url')}</dt>
            <dd className="break-all">
              <a
                href={report.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn('font-mono text-primary underline-offset-2 hover:underline')}
              >
                {report.url}
              </a>
            </dd>
            <dt className="text-muted-foreground">{t('board.userAgent')}</dt>
            <dd className="break-all">{report.user_agent}</dd>
          </dl>
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('board.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
