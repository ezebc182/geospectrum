'use client';

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Activity, LogIn } from 'lucide-react';

import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { Button } from '@/components/ui/button';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Login SOLO con Google (decisión del 2026-08-06, junto al cierre
 * invitation-only): el form de email/password se retiró de la UI — el
 * acceso es por invitación consumida vía el email verificado de Google
 * (ver src/services/auth_service.py, Decision 5 de email-invitations).
 * Los endpoints de password siguen existiendo en el backend (gateados por
 * token de invitación) para la futura página /invite/[token].
 *
 * Estética: la misma identidad "sala de control" de la landing — dark
 * forzado, pulsos de epicentro de fondo (CSS puro, respetan
 * prefers-reduced-motion vía motion-reduce).
 */

/**
 * Mapeo de los códigos de error que el backend anexa como
 * `?error=<código>` al redirigir a `/login` tras un fallo del flujo
 * OAuth de Google (ver `src/main.py`, callback `GET /auth/google/callback`).
 * Códigos exactos: `google_oauth_cancelled`, `google_oauth_token_exchange_failed`,
 * `google_oauth_invalid_id_token`, `google_oauth_email_not_verified`,
 * `google_no_invitation` (cierre invitation-only), y cualquier
 * `google_oauth_<valor-de-error-de-google>` (ej. `access_denied`) que no
 * matchee las claves conocidas cae en el mensaje genérico. Los mensajes
 * salen del diccionario (ns `auth.oauthErrors`) en el locale activo —
 * incluido el rechazo por falta de invitación (Requirement MODIFIED
 * "Login sin alta abierta y con error claro de invitación").
 */
type AuthTranslator = ReturnType<typeof useTranslations<'auth'>>;

function resolveGoogleOAuthError(code: string, t: AuthTranslator): string {
  switch (code) {
    case 'google_oauth_cancelled':
      return t('oauthErrors.cancelled');
    case 'google_oauth_token_exchange_failed':
      return t('oauthErrors.tokenExchangeFailed');
    case 'google_oauth_invalid_id_token':
      return t('oauthErrors.invalidIdToken');
    case 'google_oauth_email_not_verified':
      return t('oauthErrors.emailNotVerified');
    case 'google_no_invitation':
      return t('oauthErrors.noInvitation');
    default:
      // Cualquier otro `google_oauth_<algo>` no mapeado explícitamente
      // (ej. `google_oauth_access_denied`) es un rechazo por parte de Google.
      return code.startsWith('google_oauth_')
        ? t('oauthErrors.googleRejected')
        : t('oauthErrors.generic');
  }
}

/** Pulso de epicentro decorativo. Tamaños/posiciones fijos: es escenografía. */
function EpicenterPulse({ className }: { className: string }) {
  return (
    <span aria-hidden="true" className={`absolute ${className}`}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/20 motion-reduce:animate-none" />
      <span className="relative block h-full w-full rounded-full bg-primary/30" />
    </span>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const searchParams = useSearchParams();
  const t = useTranslations('auth');
  // Se guarda el CÓDIGO y se resuelve el mensaje en el render: así un
  // cambio de idioma en caliente re-traduce el error visible sin re-leer
  // los search params.
  const [errorCode, setErrorCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) {
      setErrorCode(oauthError);
    }
  }, [searchParams]);

  const error = errorCode !== null ? resolveGoogleOAuthError(errorCode, t) : null;

  function handleGoogleLogin() {
    // Redirect completo de navegador (NO fetch/XHR): el flujo de Google es
    // Authorization Code y requiere navegación real para que el browser
    // reciba y siga el 302 a accounts.google.com.
    window.location.href = `${API_BASE_URL}/auth/google/login`;
  }

  return (
    <div className="dark relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* Fondo: gradiente radial + pulsos de epicentro repartidos, la misma
          semántica visual que el globo de la landing sin pagar un WebGL. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_55%)]"
      />
      <EpicenterPulse className="left-[12%] top-[22%] h-3 w-3" />
      <EpicenterPulse className="right-[18%] top-[35%] h-2 w-2" />
      <EpicenterPulse className="bottom-[20%] left-[28%] h-2.5 w-2.5" />
      <EpicenterPulse className="bottom-[30%] right-[10%] h-3 w-3" />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
          <span className="font-heading text-lg font-semibold tracking-tight">GeoSpectrum</span>
        </Link>
        {/* Un visitante anónimo (invitado nuevo) también necesita poder
            cambiar el idioma — sin sesión el switcher solo escribe la cookie. */}
        <LocaleSwitcher />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card/70 p-8 backdrop-blur">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            {t('badge')}
          </p>
          <h1 className="mt-2 font-heading text-2xl font-bold tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t('subtitle')}
          </p>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button type="button" className="mt-6 min-h-12 w-full text-base" onClick={handleGoogleLogin}>
            <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('googleButton')}
          </Button>

          <p className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground">
            {t('noInvitation')}{' '}
            <Link href="/" className="text-primary underline-offset-2 hover:underline">
              geospectrum.org
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
