/**
 * Panel de gestión de usuarios (admin+) — pestaña "Usuarios" de
 * /admin/access, la TERCERA y última etapa del embudo de accesos
 * (lista de espera → invitación → usuario, design.md Decision 7).
 *
 * Desactivar es un soft-delete: no borra nada, bloquea los tres caminos de
 * entrada (password, Google y las sesiones ya emitidas). Por eso pide
 * confirmación con AlertDialog, igual que revocar una invitación. Reactivar
 * NO la pide: restaurar acceso no es destructivo y no necesita fricción.
 *
 * i18n: el estado guarda el OUTCOME (kind + datos crudos), NUNCA el texto
 * ya resuelto — mismo patrón que InvitationsPanel. Si se guardara el string
 * traducido, un cambio de idioma en caliente dejaría el mensaje viejo en
 * pantalla.
 *
 * Los botones deshabilitados por jerarquía o por self son UX, NO seguridad:
 * el backend rechaza igual (409/403). Por eso cada deshabilitado explica su
 * porqué en texto accesible (title + aria-describedby) en vez de quedar
 * solo gris.
 */

'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Ban, CheckCircle2, KeyRound, RefreshCw, Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { ApiStatusError, deactivateUser, listUsers, reactivateUser } from '@/lib/auth';
import { useAuth } from '@/hooks/use-auth';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ROLE_LEVEL } from '@/lib/types';
import type { UserListItem, UserPublic } from '@/lib/types';

const ADMIN_ROLES = ['admin', 'superadmin'];

/** Claves de `admin.users.errors.*` — el status del backend se traduce a
 * una CLAVE, no a un texto (función pura de módulo). */
type ActionErrorKey =
  | 'self'
  | 'hierarchy'
  | 'notFound'
  | 'conflict'
  | 'deactivateGeneric'
  | 'reactivateGeneric';

/** Resultado fallido de una acción: kind + datos crudos. El texto se
 * resuelve al render con t(), así el cambio de idioma re-traduce lo ya
 * mostrado (patrón InvitationsPanel). */
type ActionOutcome = { kind: 'failed'; errorKey: ActionErrorKey; email: string };

/** Razón por la que la acción de desactivar está vedada para una fila.
 * `null` = la acción está habilitada. */
type DisabledReason = 'self' | 'hierarchy' | null;

/**
 * Traduce el error del backend a la clave del mensaje accionable. La matriz
 * de design.md § Interfaces / Contracts: 403 jerarquía, 404 inexistente,
 * 409 self o estado ya alcanzado. Los dos 409 se distinguen por el mensaje
 * del backend ("cannot deactivate your own account" / "cannot manage your
 * own account" vs "already deactivated" / "is not deactivated").
 */
function actionErrorKey(err: unknown, fallback: ActionErrorKey): ActionErrorKey {
  if (err instanceof ApiStatusError) {
    if (err.status === 403) {
      return 'hierarchy';
    }
    if (err.status === 404) {
      return 'notFound';
    }
    if (err.status === 409) {
      return err.message.includes('own account') ? 'self' : 'conflict';
    }
  }
  return fallback;
}

/**
 * Espejo del guard de jerarquía del backend: nadie se gestiona a sí mismo,
 * y sólo se gestionan roles ESTRICTAMENTE menores al propio (src/models/
 * user.py). Devolver la RAZÓN y no un booleano es lo que permite explicar
 * el deshabilitado en vez de dejarlo mudo.
 */
export function disabledReasonFor(target: UserListItem, actor: UserPublic): DisabledReason {
  if (target.id === actor.id) {
    return 'self';
  }
  if (ROLE_LEVEL[target.role] >= ROLE_LEVEL[actor.role]) {
    return 'hierarchy';
  }
  return null;
}

/** Mismas opciones de fecha que los otros listados admin, con el locale
 * activo vía useFormatter. */
const DATE_OPTIONS = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
} as const;

export function UsersPanel() {
  const t = useTranslations('admin.users');
  const { user } = useAuth();
  const isAdmin = user !== null && ADMIN_ROLES.includes(user.role);

  const { data, error, isLoading, isValidating, mutate } = useSWR<UserListItem[]>(
    // Clave null sin permisos: SWR ni dispara el fetch (patrón
    // InvitationsPanel) — no renderizar datos es también no pedirlos.
    isAdmin ? 'users' : null,
    listUsers,
  );

  const [outcome, setOutcome] = React.useState<ActionOutcome | null>(null);

  // Id en vuelo: deshabilita SOLO la fila afectada, no todo el listado.
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Igual que en invitaciones: la cookie de sesión es única por browser, así
  // que un 401/403 del listado suele ser "tu sesión cambió", no un fallo de
  // la API. Un 403 acá también puede significar que TE desactivaron.
  const sessionLost =
    error instanceof ApiStatusError && (error.status === 401 || error.status === 403);

  async function handleDeactivate(target: UserListItem) {
    setOutcome(null);
    setBusyId(target.id);
    try {
      await deactivateUser(target.id);
      await mutate();
    } catch (err: unknown) {
      setOutcome({
        kind: 'failed',
        errorKey: actionErrorKey(err, 'deactivateGeneric'),
        email: target.email,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(target: UserListItem) {
    setOutcome(null);
    setBusyId(target.id);
    try {
      await reactivateUser(target.id);
      await mutate();
    } catch (err: unknown) {
      setOutcome({
        kind: 'failed',
        errorKey: actionErrorKey(err, 'reactivateGeneric'),
        email: target.email,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" aria-hidden="true" />
              {t('title')}
            </CardTitle>
            <CardDescription className="mt-1.5">{t('description')}</CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-9 shrink-0"
            onClick={() => mutate()}
            disabled={isValidating}
            aria-label={t('refreshAria')}
          >
            <RefreshCw
              className={isValidating ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
              aria-hidden="true"
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">
            {sessionLost ? t('sessionLost') : t('loadError')}
          </p>
        )}

        {/* El error de una acción NO reemplaza la lista (spec: "la lista
            sigue utilizable, sin pantalla en blanco"). */}
        {outcome && (
          <p role="alert" aria-live="polite" className="mb-3 text-sm text-destructive">
            {t(`errors.${outcome.errorKey}`, { email: outcome.email })}
          </p>
        )}

        {data && data.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
        )}

        {data && data.length > 0 && (
          <ul className="divide-y divide-border">
            {data.map((listed) => (
              <UserRow
                key={listed.id}
                user={listed}
                disabledReason={user ? disabledReasonFor(listed, user) : 'hierarchy'}
                isSelf={user?.id === listed.id}
                busy={busyId === listed.id}
                onDeactivate={() => handleDeactivate(listed)}
                onReactivate={() => handleReactivate(listed)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ deactivated }: { deactivated: boolean }) {
  const t = useTranslations('admin.users');

  if (deactivated) {
    return (
      <Badge variant="destructive" className="gap-1">
        <Ban className="h-3 w-3" aria-hidden="true" />
        {t('status.deactivated')}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      {t('status.active')}
    </Badge>
  );
}

function UserRow({
  user,
  disabledReason,
  isSelf,
  busy,
  onDeactivate,
  onReactivate,
}: {
  user: UserListItem;
  disabledReason: DisabledReason;
  isSelf: boolean;
  busy: boolean;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const t = useTranslations('admin.users');
  const tRoles = useTranslations('admin.roles');
  const format = useFormatter();

  const deactivated = user.deactivated_at !== null;
  const blocked = disabledReason !== null;

  // El porqué del deshabilitado viaja en un elemento asociado por
  // aria-describedby (no sólo en el title): un lector de pantalla lo
  // anuncia aunque el botón esté deshabilitado.
  const reasonId = `user-action-reason-${user.id}`;
  const reasonText = blocked ? t(`disabledReason.${disabledReason}`) : null;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1 truncate font-mono text-sm">
        {user.email}
        {isSelf && <span className="ml-2 text-xs text-muted-foreground">({t('you')})</span>}
      </span>

      <span className="text-xs text-muted-foreground">{tRoles(user.role)}</span>

      {/* Origen: los dos badges pueden convivir (cuenta con password que
          después se auto-linkeó con Google). */}
      <span className="flex gap-1">
        {user.has_google && (
          <Badge variant="secondary" className="gap-1">
            {t('origin.google')}
          </Badge>
        )}
        {user.has_password && (
          <Badge variant="secondary" className="gap-1">
            <KeyRound className="h-3 w-3" aria-hidden="true" />
            {t('origin.password')}
          </Badge>
        )}
      </span>

      <span
        className="font-mono text-xs tabular-nums text-muted-foreground"
        title={
          deactivated
            ? t('deactivatedTooltip', {
                date: format.dateTime(new Date(user.deactivated_at as string), DATE_OPTIONS),
              })
            : t('createdTooltip', {
                date: format.dateTime(new Date(user.created_at), DATE_OPTIONS),
              })
        }
      >
        {format.dateTime(
          new Date(deactivated ? (user.deactivated_at as string) : user.created_at),
          DATE_OPTIONS,
        )}
      </span>

      <StatusBadge deactivated={deactivated} />

      {reasonText && (
        <span id={reasonId} className="sr-only">
          {reasonText}
        </span>
      )}

      {deactivated ? (
        // Reactivar NO pide confirmación: restaurar acceso no es destructivo.
        <Button
          size="sm"
          variant="outline"
          className="min-h-9"
          disabled={busy || blocked}
          title={reasonText ?? undefined}
          aria-describedby={reasonText ? reasonId : undefined}
          onClick={onReactivate}
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {busy ? t('processing') : t('reactivate')}
        </Button>
      ) : blocked ? (
        // Deshabilitado por self o jerarquía: se muestra SIN AlertDialog —
        // un trigger deshabilitado de Radix no abre nada, y así el motivo
        // queda asociado al botón real.
        <Button
          size="sm"
          variant="destructive"
          className="min-h-9"
          disabled
          title={reasonText ?? undefined}
          aria-describedby={reasonId}
        >
          {t('deactivate')}
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="destructive" className="min-h-9" disabled={busy}>
              {busy ? t('processing') : t('deactivate')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('deactivateDialogTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t.rich('deactivateDialogDescription', {
                  email: user.email,
                  mono: (chunks) => <span className="font-mono">{chunks}</span>,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('deactivateCancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={onDeactivate}>
                {t('deactivateConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}
