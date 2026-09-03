'use client';

/**
 * Tarjeta del tablero de feedback (design, Decision 6). Muestra tipo, resumen
 * del body (texto plano con `line-clamp`), autor, fecha y el comentario del
 * admin si existe, diferenciado del texto del tester.
 *
 * Con `canManage`:
 * - asa de arrastre (`useDraggable`, patrón attributes/listeners/setNodeRef
 *   de SortableSpectrogramCard) — el asa es un botón propio para que el click
 *   sobre la tarjeta no compita con el drag;
 * - menú "Mover a…" (Radix, operable por teclado) con los CINCO estados y el
 *   actual `aria-disabled`: el fallback que teclado, lectores de pantalla y
 *   touch necesitan.
 * Sin `canManage` no se renderiza NINGÚN control de gestión: no hay un "modo
 * deshabilitado" que un cliente pueda forzar desde DevTools.
 */

import * as React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, MoreHorizontal } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FEEDBACK_STATUSES, type FeedbackReport, type FeedbackStatus } from '@/lib/feedback';
import { cn } from '@/lib/utils';

import { CARD_DATE_FORMAT, FeedbackCardDetail } from './FeedbackCardDetail';

interface FeedbackCardProps {
  report: FeedbackReport;
  canManage: boolean;
  onMove: (id: string, status: FeedbackStatus) => void;
  onComment: (id: string, comment: string | null) => void;
}

export function FeedbackCard({ report, canManage, onMove, onComment }: FeedbackCardProps) {
  const t = useTranslations('feedback');
  const format = useFormatter();
  const [detailOpen, setDetailOpen] = React.useState(false);

  // `data.status` viaja en el evento de drag: `resolveDrop` lo compara con la
  // columna destino para no emitir nada al soltar en la misma columna.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: report.id,
    disabled: !canManage,
    data: { status: report.status },
  });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow-sm',
        isDragging && 'ring-2 ring-ring',
      )}
    >
      <header className="flex items-center gap-2">
        <Badge variant={report.type === 'bug' ? 'destructive' : 'secondary'}>{t(`widget.types.${report.type}`)}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {format.dateTime(new Date(report.created_at), CARD_DATE_FORMAT)}
        </span>

        {canManage && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('board.moveTo')} title={t('board.moveTo')}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t('board.moveTo')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {FEEDBACK_STATUSES.map((status) => {
                  const isCurrent = status === report.status;
                  return (
                    <DropdownMenuItem
                      key={status}
                      // Radix: `disabled` ⇒ aria-disabled="true" y onSelect no dispara.
                      disabled={isCurrent}
                      onSelect={() => onMove(report.id, status)}
                      className={cn(status === 'discarded' && 'border-t border-border mt-1 pt-2')}
                    >
                      <span className="flex-1">{t(`status.${status}`)}</span>
                      {isCurrent && <Check aria-hidden="true" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={t('board.dragHandle')}
              title={t('board.dragHandle')}
              className="inline-flex size-7 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing [&_svg]:size-4"
            >
              <GripVertical />
            </button>
          </>
        )}
      </header>

      {/* Texto del tester: SIEMPRE texto plano (escape por defecto de React). */}
      <p className="line-clamp-3 whitespace-pre-line break-words">{report.body}</p>

      {report.admin_comment !== null && (
        <div data-slot="admin-comment" className="rounded-md border-l-2 border-primary bg-primary/5 px-2 py-1.5">
          <p className="text-xs font-medium text-primary">{t('comment.label')}</p>
          <p className="line-clamp-2 whitespace-pre-line break-words">{report.admin_comment}</p>
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={report.author_email}>
          {report.author_email}
        </span>
        <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setDetailOpen(true)}>
          {t('board.openDetail')}
        </Button>
      </footer>

      <FeedbackCardDetail
        report={report}
        canManage={canManage}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onComment={onComment}
      />
    </article>
  );
}
