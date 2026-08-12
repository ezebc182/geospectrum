/**
 * Panel de gestión de invitaciones (admin+) — pestaña "Invitaciones" de
 * /admin/access. Antes vivía como página propia en /admin/invitations; se
 * movió acá al unificar la administración de accesos (pulido post-QA).
 *
 * La creación es un flujo en DOS pasos y la UI muestra el resultado de CADA
 * paso por separado (requisito del spec): (1) `POST /auth/invitations` al
 * backend devuelve el token en claro una única vez; (2) con ese token se
 * llama a `POST /api/invitations/send` (route de Next) que dispara el email.
 * Una invitación creada cuyo email falló queda visible como tal — badge
 * "email sin confirmar" — con "reenviar" como recuperación.
 *
 * El backend es la autoridad de permisos (require_min_role(ADMIN)); el gate
 * client-side vive en la página contenedora (/admin/access).
 */

'use client';

import * as React from 'react';
import useSWR from 'swr';
import { Ban, CheckCircle2, MailPlus, MailWarning, RefreshCw, XCircle } from 'lucide-react';

import {
  ApiStatusError,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  sendInvitationEmail,
} from '@/lib/auth';
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
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ROLE_LEVEL } from '@/lib/types';
import type {
  Invitation,
  InvitationLocale,
  InvitationStatus,
  InvitationWithToken,
  UserRole,
} from '@/lib/types';

const ADMIN_ROLES = ['admin', 'superadmin'];

/** Rol preseleccionado del form — el de menor privilegio, a propósito. */
const DEFAULT_ROLE: UserRole = 'viewer';

/** Orden de presentación en el selector (de menos a más privilegio). */
const ALL_ROLES: UserRole[] = ['viewer', 'moderador', 'admin', 'superadmin'];

const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Administrador',
  moderador: 'Moderador',
  viewer: 'Observador',
};

const LOCALE_LABELS: Record<InvitationLocale, string> = {
  es: 'Español',
  en: 'English',
};

const STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  revoked: 'Revocada',
  expired: 'Expirada',
};

/** Resultado de un paso del flujo (crear/regenerar y enviar) — se muestran
 * por separado para que "creada pero el email falló" sea inconfundible. */
interface StepResult {
  label: string;
  ok: boolean;
  detail?: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Traduce el error del paso 1 (createInvitation) a un mensaje accionable.
 * Los dos 409 del backend se distinguen por el mensaje (mismo código en la
 * matriz de Decision 3): pendiente duplicada vs email ya con cuenta. */
function createErrorMessage(err: unknown): string {
  if (err instanceof ApiStatusError) {
    if (err.status === 403) {
      return 'No podés invitar a un rol superior al tuyo.';
    }
    if (err.status === 409) {
      return err.message.includes('pending')
        ? 'Ya existe una invitación pendiente para ese email — usá "Reenviar" desde la tabla.'
        : 'Ese email ya tiene una cuenta en la plataforma.';
    }
  }
  return 'No se pudo crear la invitación. Intentá de nuevo en unos segundos.';
}

export function InvitationsPanel() {
  const { user } = useAuth();
  const isAdmin = user !== null && ADMIN_ROLES.includes(user.role);

  const { data, error, isLoading, isValidating, mutate } = useSWR<Invitation[]>(
    // Clave null si no hay permisos: SWR ni siquiera dispara el fetch — no
    // renderizar datos también significa no pedirlos.
    isAdmin ? 'invitations' : null,
    listInvitations,
  );

  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<UserRole>(DEFAULT_ROLE);
  const [emailLocale, setEmailLocale] = React.useState<InvitationLocale>('es');
  const [creating, setCreating] = React.useState(false);
  const [steps, setSteps] = React.useState<StepResult[] | null>(null);

  // Id en vuelo: deshabilita SOLO la fila afectada, no toda la tabla.
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // QA: la cookie de sesión es única por browser — loguearse como invitado en
  // otra pestaña PISA la sesión admin y el listado empieza a dar 401/403.
  // El mensaje tiene que decir eso, no un genérico de "verificá tu sesión".
  const sessionLost =
    error instanceof ApiStatusError && (error.status === 401 || error.status === 403);

  // Roles que el usuario actual puede otorgar: nivel <= al propio (espejo
  // del guard de escalación del backend, que es el enforcement real).
  const grantableRoles = React.useMemo(
    () => (user ? ALL_ROLES.filter((r) => ROLE_LEVEL[r] <= ROLE_LEVEL[user.role]) : []),
    [user],
  );

  /** Paso 2 compartido por crear y reenviar: dispara el email con el token
   * en claro recién recibido y devuelve el StepResult correspondiente. */
  async function sendStep(invitation: InvitationWithToken): Promise<StepResult> {
    try {
      await sendInvitationEmail({
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.token,
        expiresAt: invitation.expires_at,
        // El idioma viaja con la invitación (migración 010): el reenvío
        // conserva el que se eligió al crear.
        locale: invitation.locale,
      });
      return { label: 'Email enviado', ok: true, detail: `El link viaja a ${invitation.email}.` };
    } catch {
      return {
        label: 'Email NO enviado',
        ok: false,
        detail:
          'La invitación quedó creada y pendiente — usá "Reenviar" en la tabla para reintentar.',
      };
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSteps(null);
    setCreating(true);

    let invitation: InvitationWithToken;
    try {
      invitation = await createInvitation(email, role, emailLocale);
    } catch (err: unknown) {
      setSteps([{ label: 'Invitación no creada', ok: false, detail: createErrorMessage(err) }]);
      setCreating(false);
      return;
    }

    const created: StepResult = {
      label: 'Invitación creada',
      ok: true,
      detail: `${invitation.email} como ${ROLE_LABELS[invitation.role]}.`,
    };
    setSteps([created, await sendStep(invitation)]);
    // Éxito → form limpio para la próxima invitación (pulido QA): email
    // vacío y rol/idioma de vuelta al default.
    setEmail('');
    setRole(DEFAULT_ROLE);
    setEmailLocale('es');
    await mutate();
    setCreating(false);
  }

  async function handleResend(target: Invitation) {
    setSteps(null);
    setBusyId(target.id);

    let regenerated: InvitationWithToken;
    try {
      // Regenera token + expiración en el backend: el link viejo queda
      // muerto y el email SIEMPRE sale con el link NUEVO.
      regenerated = await resendInvitation(target.id);
    } catch {
      setSteps([
        {
          label: 'Reenvío fallido',
          ok: false,
          detail: `No se pudo regenerar la invitación de ${target.email}.`,
        },
      ]);
      setBusyId(null);
      return;
    }

    const step1: StepResult = {
      label: 'Invitación regenerada',
      ok: true,
      detail: `Link nuevo para ${regenerated.email} — el anterior quedó invalidado.`,
    };
    setSteps([step1, await sendStep(regenerated)]);
    await mutate();
    setBusyId(null);
  }

  async function handleRevoke(target: Invitation) {
    setSteps(null);
    setBusyId(target.id);
    try {
      await revokeInvitation(target.id);
      await mutate();
    } catch {
      setSteps([
        {
          label: 'Revocación fallida',
          ok: false,
          detail: `No se pudo revocar la invitación de ${target.email}.`,
        },
      ]);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MailPlus className="h-4 w-4 text-primary" aria-hidden="true" />
            Nueva invitación
          </CardTitle>
          <CardDescription>
            El rol se hereda de la invitación — solo podés otorgar roles hasta tu propio nivel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="invitation-email" className="mb-2 block text-sm font-medium">
                Email
              </label>
              <Input
                id="invitation-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="persona@ejemplo.com"
              />
            </div>
            <div>
              <label htmlFor="invitation-role" className="mb-2 block text-sm font-medium">
                Rol
              </label>
              {/* Select nativo a propósito: no hay componente Select en ui/ y
                  un DropdownMenu de Radix pelea con inputs (typeahead se come
                  las teclas — memoria del proyecto). */}
              <select
                id="invitation-role"
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
                className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {grantableRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="invitation-locale" className="mb-2 block text-sm font-medium">
                Idioma del email
              </label>
              {/* Idioma en que sale el email de invitación (y en que abre la
                  página /invite). Default español; el reenvío lo conserva. */}
              <select
                id="invitation-locale"
                value={emailLocale}
                onChange={(event) => setEmailLocale(event.target.value as InvitationLocale)}
                className="flex h-9 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(['es', 'en'] as const).map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" className="min-h-9" disabled={creating}>
              {creating ? 'Invitando…' : 'Invitar'}
            </Button>
          </form>

          {steps && (
            <ul className="mt-4 space-y-1" aria-live="polite">
              {steps.map((step) => (
                <li key={step.label} className="flex items-start gap-2 text-sm">
                  {step.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  )}
                  <span>
                    <span className={step.ok ? 'font-medium' : 'font-medium text-destructive'}>
                      {step.label}
                    </span>
                    {step.detail && <span className="text-muted-foreground"> {step.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Invitaciones enviadas</CardTitle>
              <CardDescription className="mt-1.5">
                El estado se deriva en el backend; &quot;email sin confirmar&quot; significa que el
                envío nunca se confirmó — reenviá para generar un link nuevo.
              </CardDescription>
            </div>
            {/* Refetch sin recargar la página (pulido QA). */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-9 shrink-0"
              onClick={() => mutate()}
              disabled={isValidating}
              aria-label="Actualizar listado"
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
              {sessionLost
                ? 'Tu sesión cambió o expiró — volvé a iniciar sesión.'
                : 'No se pudo cargar el listado. Verificá tu sesión e intentá de nuevo.'}
            </p>
          )}

          {data && data.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Todavía no hay invitaciones. Creá la primera con el formulario de arriba.
            </p>
          )}

          {data && data.length > 0 && (
            <ul className="divide-y divide-border">
              {data.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  busy={busyId === invitation.id}
                  onRevoke={() => handleRevoke(invitation)}
                  onResend={() => handleResend(invitation)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: InvitationStatus }) {
  if (status === 'accepted') {
    return (
      <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        {STATUS_LABELS.accepted}
      </Badge>
    );
  }
  if (status === 'revoked') {
    return (
      <Badge variant="destructive" className="gap-1">
        <Ban className="h-3 w-3" aria-hidden="true" />
        {STATUS_LABELS.revoked}
      </Badge>
    );
  }
  if (status === 'expired') {
    return (
      <Badge variant="secondary" className="gap-1">
        {STATUS_LABELS.expired}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      {STATUS_LABELS.pending}
    </Badge>
  );
}

function InvitationRow({
  invitation,
  busy,
  onRevoke,
  onResend,
}: {
  invitation: Invitation;
  busy: boolean;
  onRevoke: () => void;
  onResend: () => void;
}) {
  // Reenviar y revocar solo tienen sentido (y el backend solo las acepta)
  // sobre pendientes y expiradas: una aceptada es un usuario ya creado y una
  // revocada ya está fuera de juego. Ocultar > deshabilitar acá — no mostrar
  // acciones que la API va a rechazar con 409.
  const actionable = invitation.status === 'pending' || invitation.status === 'expired';

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1 truncate font-mono text-sm">{invitation.email}</span>
      <span className="text-xs text-muted-foreground">{ROLE_LABELS[invitation.role]}</span>
      <span
        className="font-mono text-xs tabular-nums text-muted-foreground"
        title={`Creada ${formatDate(invitation.created_at)}`}
      >
        vence {formatDate(invitation.expires_at)}
      </span>

      <StatusBadge status={invitation.status} />

      {invitation.status === 'pending' && invitation.email_sent_at === null && (
        <Badge variant="secondary" className="gap-1">
          <MailWarning className="h-3 w-3" aria-hidden="true" />
          email sin confirmar
        </Badge>
      )}

      {actionable && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="min-h-9"
            disabled={busy}
            onClick={onResend}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {busy ? 'Procesando…' : 'Reenviar'}
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive" className="min-h-9" disabled={busy}>
                Revocar
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Revocar la invitación?</AlertDialogTitle>
                <AlertDialogDescription>
                  El link enviado a <span className="font-mono">{invitation.email}</span> deja de
                  funcionar de inmediato. Esta acción no se puede deshacer — si te arrepentís vas a
                  tener que crear una invitación nueva.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={onRevoke}>Revocar</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </li>
  );
}
