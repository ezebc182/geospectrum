'use client';

/**
 * Tablero Kanban de feedback (design, Decision 6). Agrupa los reportes por
 * `status`, renderiza las cuatro columnas del flujo en orden fijo y
 * `discarded` como quinta columna SEPARADA (separador + variante propia).
 *
 * Con `canManage` envuelve todo en un `DndContext` (PointerSensor con
 * `distance: 5` — el de spectrograms/page.tsx — más KeyboardSensor). Sin
 * `canManage` NO monta el contexto: las columnas son divs planos y arrastrar
 * no hace nada. La decisión del drop vive en `resolveDrop`, función pura
 * testeable sin puntero: sin destino o misma columna ⇒ no se emite nada.
 */

import * as React from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useTranslations } from 'next-intl';

import { Separator } from '@/components/ui/separator';
import { FLOW_STATUSES, isFeedbackStatus, type FeedbackReport, type FeedbackStatus } from '@/lib/feedback';

import { FeedbackColumn } from './FeedbackColumn';

export interface FeedbackBoardProps {
  reports: FeedbackReport[];
  canManage: boolean;
  onMove: (id: string, status: FeedbackStatus) => void;
  onComment: (id: string, comment: string | null) => void;
}

/** Lo mínimo de un `DragEndEvent` que la decisión necesita (tipado laxo para
 * poder testearla sin fabricar el evento completo de dnd-kit). */
export interface DropLike {
  active: { id: string | number; data: { current?: { status?: unknown } | undefined } };
  over: { id: string | number } | null;
}

/** Decide si un drop mueve una tarjeta: devuelve `{id, status}` solo cuando hay
 * columna destino válida y distinta de la de origen. */
export function resolveDrop({ active, over }: DropLike): { id: string; status: FeedbackStatus } | null {
  if (over === null) return null;
  if (!isFeedbackStatus(over.id)) return null;
  if (active.data.current?.status === over.id) return null;
  return { id: String(active.id), status: over.id };
}

/** Agrupa por status ordenando cada columna por `created_at` DESC (lo más
 * nuevo arriba). La API ya devuelve DESC; ordenar acá hace al tablero
 * independiente del orden con el que llegue la lista. */
function groupByStatus(reports: FeedbackReport[]): Record<FeedbackStatus, FeedbackReport[]> {
  const groups: Record<FeedbackStatus, FeedbackReport[]> = {
    new: [],
    in_analysis: [],
    in_progress: [],
    done: [],
    discarded: [],
  };
  for (const report of reports) groups[report.status].push(report);
  for (const status of Object.keys(groups) as FeedbackStatus[]) {
    groups[status].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return groups;
}

export function FeedbackBoard({ reports, canManage, onMove, onComment }: FeedbackBoardProps) {
  const t = useTranslations('feedback.board');
  const groups = React.useMemo(() => groupByStatus(reports), [reports]);

  const columns = (
    <div className="flex items-start gap-4 overflow-x-auto pb-2">
      <div role="group" aria-label={t('flowGroup')} className="flex items-start gap-3">
        {FLOW_STATUSES.map((status) => (
          <FeedbackColumn
            key={status}
            status={status}
            reports={groups[status]}
            canManage={canManage}
            onMove={onMove}
            onComment={onComment}
          />
        ))}
      </div>
      <Separator orientation="vertical" className="h-auto min-h-[12rem] self-stretch" />
      <FeedbackColumn
        status="discarded"
        variant="discarded"
        reports={groups.discarded}
        canManage={canManage}
        onMove={onMove}
        onComment={onComment}
      />
    </div>
  );

  if (!canManage) return columns;

  return (
    <ManagedBoard onMove={onMove}>{columns}</ManagedBoard>
  );
}

/** El DndContext y sus sensores viven en un componente aparte: los hooks de
 * sensores solo se ejecutan cuando hay gestión (sin `canManage` ni siquiera
 * se instancian). */
function ManagedBoard({
  onMove,
  children,
}: {
  onMove: (id: string, status: FeedbackStatus) => void;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const drop = resolveDrop(event);
    if (drop) onMove(drop.id, drop.status);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
      {children}
    </DndContext>
  );
}
