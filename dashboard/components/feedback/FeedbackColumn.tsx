'use client';

/**
 * Columna del tablero de feedback: zona de drop (`useDroppable({ id: status })`),
 * encabezado i18n con contador y `aria-label` PROPIO por estado — Descartado
 * no es "otro Hecho" ni para la vista ni para un lector de pantalla.
 *
 * Fuera de un DndContext (modo lectura) `useDroppable` es inerte: no hay
 * sensores, no hay registro, no hay nada que un cliente pueda forzar.
 */

import { useDroppable } from '@dnd-kit/core';
import { useTranslations } from 'next-intl';

import type { FeedbackReport, FeedbackStatus } from '@/lib/feedback';
import { cn } from '@/lib/utils';

import { FeedbackCard } from './FeedbackCard';

interface FeedbackColumnProps {
  status: FeedbackStatus;
  reports: FeedbackReport[];
  canManage: boolean;
  onMove: (id: string, status: FeedbackStatus) => void;
  onComment: (id: string, comment: string | null) => void;
  /** `discarded` se dibuja distinto (borde punteado, fondo apagado). */
  variant?: 'flow' | 'discarded';
}

export function FeedbackColumn({ status, reports, canManage, onMove, onComment, variant = 'flow' }: FeedbackColumnProps) {
  const t = useTranslations('feedback');
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: !canManage });
  const label = t(`status.${status}`);

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      data-status={status}
      className={cn(
        'flex min-h-[12rem] w-72 shrink-0 flex-col gap-2 rounded-xl border p-2 transition-colors',
        variant === 'discarded'
          ? 'border-dashed border-muted-foreground/40 bg-muted/40 text-muted-foreground'
          : 'border-border bg-background',
        isOver && 'border-primary bg-primary/5',
      )}
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <h2 className={cn('text-sm font-semibold', variant === 'discarded' && 'italic')}>{label}</h2>
        <span className="text-xs text-muted-foreground">{t('board.count', { count: reports.length })}</span>
      </header>

      {reports.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t('board.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {reports.map((report) => (
            <FeedbackCard key={report.id} report={report} canManage={canManage} onMove={onMove} onComment={onComment} />
          ))}
        </div>
      )}
    </section>
  );
}
