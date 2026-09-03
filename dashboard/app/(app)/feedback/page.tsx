'use client';

/**
 * Tablero de feedback `/feedback` (change feedback-beta-testers, design
 * Decisions 5 y 7). UNA sola página para todos los roles: lo que cambia por
 * rol es `canManage`, no la visibilidad.
 *
 * - `canManage` sale de `useAuth().user.role` con el MISMO mecanismo literal de
 *   `AppSidebar.tsx` (`ADMIN_ROLES` local). Es UX: el juez es el 403 del
 *   backend, que acá se trata como un rechazo más.
 * - Datos con `useSWR` y actualización optimista con `rollbackOnError`: la
 *   tarjeta se muestra en destino mientras el PUT vuela y SOLO el 200 la
 *   consolida; 403/422/red/401 la devuelven a su columna con aviso.
 * - El aviso se guarda como DATO (`outcome.kind` + status), nunca como texto
 *   traducido (patrón UsersPanel), para que un cambio de idioma en caliente
 *   no deje texto viejo.
 */

import * as React from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';

import { FeedbackBoard } from '@/components/feedback/FeedbackBoard';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { ApiStatusError } from '@/lib/auth';
import {
  FEEDBACK_SWR_KEY,
  listFeedbackReports,
  updateFeedbackComment,
  updateFeedbackStatus,
  type FeedbackReport,
  type FeedbackStatus,
} from '@/lib/feedback';

// Mismo patrón que AppSidebar.tsx:41 y admin/access/page.tsx:29 (const local;
// consolidar en lib/ queda fuera del change — "funcionalidad antes que deuda").
const ADMIN_ROLES = ['admin', 'superadmin'];

/** Resultado de la última acción fallida, como dato. `status: null` = fallo
 * de red (sin respuesta HTTP). */
type Outcome = { kind: 'moveFailed' | 'commentFailed'; status: number | null } | { kind: 'sessionExpired' };

/** El helper devuelve `null` ante 401: acá eso es un fallo más (revertir y
 * avisar), así que se convierte en excepción para que SWR haga el rollback. */
class SessionExpiredError extends Error {
  constructor() {
    super('session expired');
    this.name = 'SessionExpiredError';
  }
}

function unwrap(updated: FeedbackReport | null): FeedbackReport {
  if (updated === null) throw new SessionExpiredError();
  return updated;
}

function replaceById(list: FeedbackReport[] | null | undefined, updated: FeedbackReport): FeedbackReport[] {
  return (list ?? []).map((report) => (report.id === updated.id ? updated : report));
}

function moveLocally(list: FeedbackReport[] | null | undefined, id: string, status: FeedbackStatus): FeedbackReport[] {
  return (list ?? []).map((report) => (report.id === id ? { ...report, status } : report));
}

function commentLocally(list: FeedbackReport[] | null | undefined, id: string, comment: string | null): FeedbackReport[] {
  return (list ?? []).map((report) => (report.id === id ? { ...report, admin_comment: comment } : report));
}

function toOutcome(kind: 'moveFailed' | 'commentFailed', err: unknown): Outcome {
  if (err instanceof SessionExpiredError) return { kind: 'sessionExpired' };
  return { kind, status: err instanceof ApiStatusError ? err.status : null };
}

export default function FeedbackPage() {
  const t = useTranslations('feedback');
  const { user } = useAuth();
  const canManage = user !== null && ADMIN_ROLES.includes(user.role);

  const { data, error, isLoading, isValidating, mutate } = useSWR(FEEDBACK_SWR_KEY, listFeedbackReports);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  // `null` = el GET devolvió 401 (sesión vencida); `undefined` = todavía no cargó.
  const sessionLost = data === null;
  const reports = data ?? [];

  const onMove = (id: string, status: FeedbackStatus) => {
    setOutcome(null);
    // El `mutate` del design (Decision 7): la promesa resuelve la lista con el
    // item que devolvió el PUT reemplazando al optimista; si rechaza, SWR
    // restaura la lista previa (rollbackOnError) y el aviso sale del catch.
    mutate(
      updateFeedbackStatus(id, status).then((updated) => replaceById(reports, unwrap(updated))),
      {
        optimisticData: (current) => moveLocally(current, id, status),
        rollbackOnError: true,
        populateCache: true,
        revalidate: false,
      },
    ).catch((err: unknown) => setOutcome(toOutcome('moveFailed', err)));
  };

  const onComment = (id: string, comment: string | null) => {
    setOutcome(null);
    mutate(
      updateFeedbackComment(id, comment).then((updated) => replaceById(reports, unwrap(updated))),
      {
        optimisticData: (current) => commentLocally(current, id, comment),
        rollbackOnError: true,
        populateCache: true,
        revalidate: false,
      },
    ).catch((err: unknown) => setOutcome(toOutcome('commentFailed', err)));
  };

  const outcomeText = (value: Outcome): string => {
    if (value.kind === 'sessionExpired') return t('errors.sessionExpired');
    if (value.kind === 'moveFailed' && value.status === 403) return t('errors.forbidden');
    return t(`errors.${value.kind}`);
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{t('board.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('board.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOutcome(null);
            void mutate();
          }}
          disabled={isValidating}
          aria-busy={isValidating || undefined}
        >
          <RefreshCw className={isValidating ? 'animate-spin' : undefined} />
          {isValidating ? t('board.refreshing') : t('board.refresh')}
        </Button>
      </header>

      {outcome && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {outcomeText(outcome)}
        </p>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t('board.loadError')}
        </p>
      ) : sessionLost ? (
        <p role="alert" className="text-sm text-destructive">
          {t('errors.sessionExpired')}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('board.loading')}
        </p>
      ) : (
        <FeedbackBoard reports={reports} canManage={canManage} onMove={onMove} onComment={onComment} />
      )}
    </div>
  );
}
