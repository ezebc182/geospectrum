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
import { getScreenshotDownloadUrl, type FeedbackReport, type FeedbackStatus } from '@/lib/feedback';
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

interface ScreenshotLightboxProps {
  reportId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Elemento al que vuelve el foco al cerrar. El lightbox no se abre desde
   * un `DialogTrigger asChild` (el thumbnail decide abrir por estado propio,
   * no por composición de Radix), así que Radix no conoce el trigger real y
   * el foco por default vuelve al `<body>` — se fuerza acá con
   * `onCloseAutoFocus`. */
  triggerRef: React.RefObject<HTMLElement | null>;
}

/** Lightbox de la captura completa (design.md Decision 4): re-pide SIEMPRE
 * `getScreenshotDownloadUrl` al abrirse, nunca reusa la URL del thumbnail —
 * la firmada expira a los 5 min y el thumbnail pudo pedirse hace rato.
 * Reusa `ui/dialog.tsx` (Escape/click afuera los maneja Radix; la
 * devolución de foco se fuerza acá, ver `triggerRef`): no hace falta un
 * primitivo `Lightbox` dedicado para un solo uso. */
function ScreenshotLightbox({ reportId, open, onOpenChange, triggerRef }: ScreenshotLightboxProps) {
  const t = useTranslations('feedback.board');
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    getScreenshotDownloadUrl(reportId)
      .then((result) => {
        if (!cancelled) setUrl(result?.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reportId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={t('screenshotLightboxTitle')}
        className="sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('screenshotLightboxTitle')}</DialogTitle>
        </DialogHeader>
        {url !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- URL firmada externa (R2), no un asset de Next.
          <img src={url} alt={t('screenshotLightboxTitle')} className="max-h-[75vh] w-full rounded-md object-contain" />
        ) : (
          <p className="text-sm text-muted-foreground">{t('screenshotUnavailable')}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ScreenshotThumbnailProps {
  reportId: string;
}

/** Thumbnail condicional (design.md Decision 4): pide
 * `getScreenshotDownloadUrl` al montarse; sin `screenshot_key` en el reporte
 * este componente NUNCA se monta (el guard vive en el caller), así que acá
 * adentro no hace falta chequearlo de nuevo. Un fallo (401/404/500, `null` o
 * excepción) degrada a un estado de "no disponible" con texto descriptivo,
 * sin lanzar ni tirar el resto de la tarjeta/detalle. */
export function ScreenshotThumbnail({ reportId }: ScreenshotThumbnailProps) {
  const t = useTranslations('feedback.board');
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    getScreenshotDownloadUrl(reportId)
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setFailed(true);
          return;
        }
        setUrl(result.url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  if (failed) {
    return <p className="text-xs text-muted-foreground">{t('screenshotUnavailable')}</p>;
  }

  if (url === null) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-slot="screenshot-thumbnail"
        aria-label={t('screenshotThumbnailAlt')}
        onClick={() => setLightboxOpen(true)}
        // `<button>` ya activa con Enter/Space en el DOM real, pero jsdom no
        // simula la acción por default de teclado sobre elementos nativos —
        // handler explícito para que `fireEvent.keyDown` sea determinista en
        // los tests (mismo motivo documentado en otros triggers del repo).
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setLightboxOpen(true);
          }
        }}
        className="w-fit overflow-hidden rounded-md border border-border focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada externa (R2), no un asset de Next. */}
        <img src={url} alt={t('screenshotThumbnailAlt')} className="block h-20 w-20 object-cover" />
      </button>
      <ScreenshotLightbox reportId={reportId} open={lightboxOpen} onOpenChange={setLightboxOpen} triggerRef={buttonRef} />
    </>
  );
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

        {report.screenshot_key !== null && <ScreenshotThumbnail reportId={report.id} />}

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
