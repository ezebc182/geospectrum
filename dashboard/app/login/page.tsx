'use client';

import * as React from 'react';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/** Ruta protegida a la que se redirige tras un login exitoso. */
const DEFAULT_REDIRECT = '/';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Mapeo de los códigos de error que el backend anexa como
 * `?error=<código>` al redirigir a `/login` tras un fallo del flujo
 * OAuth de Google (ver `src/main.py`, callback `GET /auth/google/callback`).
 * Códigos exactos: `google_oauth_cancelled`, `google_oauth_token_exchange_failed`,
 * `google_oauth_invalid_id_token`, `google_oauth_email_not_verified`, y
 * cualquier `google_oauth_<valor-de-error-de-google>` (ej. `access_denied`)
 * que no matchee las claves conocidas cae en el mensaje genérico de abajo.
 */
const GOOGLE_OAUTH_ERROR_MESSAGES: Record<string, string> = {
  google_oauth_cancelled: 'Cancelaste el inicio de sesión con Google.',
  google_oauth_token_exchange_failed: 'No se pudo completar el inicio de sesión con Google.',
  google_oauth_invalid_id_token: 'No se pudo completar el inicio de sesión con Google.',
  google_oauth_email_not_verified:
    'Tu cuenta de Google no tiene el email verificado. Verificalo con Google e intentá de nuevo.',
};

function resolveGoogleOAuthError(code: string): string {
  if (code in GOOGLE_OAUTH_ERROR_MESSAGES) {
    return GOOGLE_OAUTH_ERROR_MESSAGES[code];
  }
  // Cualquier otro `google_oauth_<algo>` no mapeado explícitamente
  // (ej. `google_oauth_access_denied`) es un rechazo por parte de Google.
  if (code.startsWith('google_oauth_')) {
    return 'Google rechazó el inicio de sesión.';
  }
  return 'No se pudo completar el inicio de sesión con Google.';
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    const oauthError = searchParams.get('error');
    if (oauthError) {
      setError(resolveGoogleOAuthError(oauthError));
    }
  }, [searchParams]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      router.push(DEFAULT_REDIRECT);
    } catch {
      // Mensaje genérico a propósito: el backend ya responde 401
      // indistinguible entre "email no existe" y "password incorrecto"
      // (ver specs/auth/spec.md, Requirement: Login) — la UI respeta esa
      // ambigüedad y no intenta adivinar cuál de los dos campos falló.
      setError('Credenciales inválidas. Verificá tu email y contraseña.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleGoogleLogin() {
    // Redirect completo de navegador (NO fetch/XHR): el flujo de Google es
    // Authorization Code y requiere navegación real para que el browser
    // reciba y siga el 302 a accounts.google.com.
    window.location.href = `${API_BASE_URL}/auth/google/login`;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Activity className="mb-2 h-8 w-8 text-primary" />
          <CardTitle>GeoSpectrum</CardTitle>
          <CardDescription>Iniciá sesión para acceder al monitoreo</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                Contraseña
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Ingresando…' : 'Ingresar'}
            </Button>
          </form>

          <div className="my-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase text-muted-foreground">o</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogleLogin}
            disabled={submitting}
          >
            Iniciar sesión con Google
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
