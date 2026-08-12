'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, LogIn, MailX, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiStatusError, login, registerWithInvitation, validateInvitationToken } from '@/lib/auth';
import type { InvitationValidation } from '@/lib/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Página PÚBLICA de aceptación de invitación (email-invitations, Decision 5).
 * Vive fuera de `(app)` — mismo criterio que `login/` — y el middleware la
 * tiene en la allowlist (`/invite` en PUBLIC_PATHS): un visitante sin sesión
 * llega acá directo desde el link del email, sin redirect a /login.
 *
 * Al montar valida el token contra `GET /auth/invitations/validate` (NO
 * consume — validar N veces deja la invitación igual de pendiente):
 * - 200 → email + rol READ-ONLY (el rol viene de la invitación, server-side;
 *   acá no existe ningún control para elegirlo) y dos caminos de alta:
 *   password (register + login encadenados) o Google (SIN token — el
 *   backend consume por match del email verificado de Google, Decision 5).
 * - 404 → "invitación no válida"; 410 → "vencida/revocada". En error NO se
 *   renderiza formulario ni botón de Google.
 */

/** Nombres visibles de los roles — espejo de UserRole, solo presentación. */
const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin',
  admin: 'Administrador',
  moderador: 'Moderador',
  viewer: 'Observador',
};

type ValidationState =
  | { kind: 'loading' }
  | { kind: 'valid'; invitation: InvitationValidation }
  | { kind: 'invalid' } // 404: token desconocido
  | { kind: 'gone' } // 410: expirada / revocada / ya usada
  | { kind: 'error' }; // red caída u otro fallo no contemplado

function formatExpiry(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'long' }).format(new Date(iso));
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const [state, setState] = React.useState<ValidationState>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;

    validateInvitationToken(token)
      .then((invitation) => {
        if (!cancelled) setState({ kind: 'valid', invitation });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiStatusError && err.status === 404) {
          setState({ kind: 'invalid' });
        } else if (err instanceof ApiStatusError && err.status === 410) {
          setState({ kind: 'gone' });
        } else {
          setState({ kind: 'error' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="dark relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_55%)]"
      />

      <header className="relative z-10 mx-auto w-full max-w-6xl px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
          <span className="font-heading text-lg font-semibold tracking-tight">GeoSpectrum</span>
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card/70 p-8 backdrop-blur">
          {state.kind === 'loading' && (
            <p className="text-sm text-muted-foreground">Validando tu invitación…</p>
          )}

          {state.kind === 'valid' && <AcceptInvitation token={token} invitation={state.invitation} />}

          {state.kind === 'invalid' && (
            <InvitationError
              title="Invitación no válida"
              message="Este link de invitación no existe. Revisá que la URL esté completa o pedile a quien te invitó que la genere de nuevo."
            />
          )}

          {state.kind === 'gone' && (
            <InvitationError
              title="Invitación vencida o revocada"
              message="Este link ya no sirve: la invitación expiró, fue revocada o ya se usó. Pedile a quien te invitó que la reenvíe — el reenvío genera un link nuevo."
            />
          )}

          {state.kind === 'error' && (
            <InvitationError
              title="No se pudo validar la invitación"
              message="Hubo un problema de conexión al validar el link. Recargá la página para intentar de nuevo."
            />
          )}
        </div>
      </main>
    </div>
  );
}

/** Estado de error: mensaje claro y NADA más — sin formulario ni botón de
 * Google (criterio de aceptación explícito del spec). */
function InvitationError({ title, message }: { title: string; message: string }) {
  return (
    <div role="alert">
      <MailX className="h-8 w-8 text-destructive" aria-hidden="true" />
      <h1 className="mt-4 font-heading text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>
    </div>
  );
}

function AcceptInvitation({
  token,
  invitation,
}: {
  token: string;
  invitation: InvitationValidation;
}) {
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      // Register NO emite cookie (Decision 5): tras el 201 se encadena el
      // login existente con las mismas credenciales y recién ahí hay sesión.
      await registerWithInvitation(invitation.email, password, token);
      await login(invitation.email, password);
      // Navegación dura (no router.push): fuerza pasar por el middleware con
      // la cookie fresca y re-hidratar useAuth desde cero en (app).
      window.location.href = '/';
    } catch (err: unknown) {
      if (err instanceof ApiStatusError && err.status === 410) {
        setError(
          'La invitación dejó de ser válida mientras completabas el alta. Pedí un reenvío del link.',
        );
      } else if (err instanceof ApiStatusError && err.status === 409) {
        setError('Este email ya tiene una cuenta. Entrá desde la página de login.');
      } else {
        setError('No se pudo crear la cuenta. Intentá de nuevo en unos segundos.');
      }
      setSubmitting(false);
    }
  }

  function handleGoogle() {
    // SIN token a propósito (Decision 5): el backend consume la invitación
    // por match del email verificado que entrega Google, no por el link.
    // Redirect completo de navegador — el flujo OAuth necesita navegación real.
    window.location.href = `${API_BASE_URL}/auth/google/login`;
  }

  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-widest text-primary">Invitación</p>
      <h1 className="mt-2 font-heading text-2xl font-bold tracking-tight">
        Te invitaron a GeoSpectrum
      </h1>

      {/* Email y rol READ-ONLY: vienen de la invitación, server-side. No hay
          (ni debe haber) ningún control para cambiarlos. */}
      <dl className="mt-4 space-y-1 rounded-lg border border-border bg-background/50 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="truncate font-mono">{invitation.email}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Rol</dt>
          <dd className="font-medium">{ROLE_LABELS[invitation.role] ?? invitation.role}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Válida hasta</dt>
          <dd>{formatExpiry(invitation.expires_at)}</dd>
        </div>
      </dl>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-5">
        <label htmlFor="invite-password" className="block text-sm font-medium">
          Elegí una contraseña
        </label>
        <Input
          id="invite-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Mínimo 8 caracteres"
          className="mt-2"
        />
        <Button type="submit" className="mt-4 min-h-11 w-full" disabled={submitting}>
          <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
          {submitting ? 'Creando tu cuenta…' : 'Crear cuenta y entrar'}
        </Button>
      </form>

      <div className="mt-5 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-widest text-muted-foreground">o</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        type="button"
        variant="outline"
        className="mt-5 min-h-11 w-full"
        onClick={handleGoogle}
        disabled={submitting}
      >
        <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
        Continuar con Google
      </Button>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Usá la cuenta de Google de <span className="font-mono">{invitation.email}</span> — la
        invitación está atada a ese email.
      </p>
    </div>
  );
}
