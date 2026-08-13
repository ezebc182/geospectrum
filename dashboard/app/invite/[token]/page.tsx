'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Activity, Eye, EyeOff, LogIn, MailX, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { ApiStatusError, login, registerWithInvitation, validateInvitationToken } from '@/lib/auth';
import { getLocaleCookie, setLocaleCookie } from '@/lib/locale';
import { passwordStrength } from '@/lib/password-strength';
import type { InvitationValidation } from '@/lib/types';
import { cn } from '@/lib/utils';

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
 *
 * i18n (i18n-dashboard, Fase 7): el copy vive en el ns `invite` de
 * messages/{es,en}.json. El idioma inicial se SIEMBRA desde el `locale` de
 * la invitación (respuesta de validate): si el visitante no tiene cookie
 * NEXT_LOCALE, la página la setea y refresca — así el primer login
 * post-aceptación aterriza en el dashboard en ese idioma. Si ya había
 * cookie (elección explícita previa), la siembra NO la pisa. El switcher
 * global del header permite cambiar en caliente como en toda la app.
 */

type ValidationState =
  | { kind: 'loading' }
  | { kind: 'valid'; invitation: InvitationValidation }
  | { kind: 'invalid' } // 404: token desconocido
  | { kind: 'gone' } // 410: expirada / revocada / ya usada
  | { kind: 'error' }; // red caída u otro fallo no contemplado

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const router = useRouter();
  const t = useTranslations('invite');
  const [state, setState] = React.useState<ValidationState>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;

    validateInvitationToken(token)
      .then((invitation) => {
        if (cancelled) return;
        setState({ kind: 'valid', invitation });
        // Siembra del idioma del invitado (Decision 3): el locale de la
        // invitación manda SOLO si el visitante no eligió antes — con
        // cookie previa (válida), su elección explícita gana y no se pisa.
        if (getLocaleCookie() === null) {
          setLocaleCookie(invitation.locale);
          router.refresh();
        }
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
  }, [token, router]);

  return (
    <div className="dark relative flex min-h-dvh flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_55%)]"
      />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
          <span className="font-heading text-lg font-semibold tracking-tight">GeoSpectrum</span>
        </Link>

        {/* Switcher global (cookie + refresh), reemplaza al toggle propio
            que tenía la página: la elección acá vale para toda la app. */}
        <LocaleSwitcher />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card/70 p-8 backdrop-blur">
          {state.kind === 'loading' && (
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          )}

          {state.kind === 'valid' && (
            <AcceptInvitation token={token} invitation={state.invitation} />
          )}

          {state.kind === 'invalid' && (
            <InvitationError title={t('errors.invalidTitle')} message={t('errors.invalidMessage')} />
          )}

          {state.kind === 'gone' && (
            <InvitationError title={t('errors.goneTitle')} message={t('errors.goneMessage')} />
          )}

          {state.kind === 'error' && (
            <InvitationError title={t('errors.networkTitle')} message={t('errors.networkMessage')} />
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

/** Barra de fuerza: 4 segmentos, color según score (1–4). Solo feedback
 * visual — la política real la valida el backend. */
function StrengthMeter({ password }: { password: string }) {
  const t = useTranslations('invite');
  const score = passwordStrength(password);
  if (score === 0) return null;

  // Los 4 niveles son un array en el diccionario (índice = score - 1),
  // misma jerarquía que el viejo INVITE_COPY — de ahí el t.raw.
  const levels = t.raw('accept.strengthLevels') as readonly string[];
  const colors = ['bg-destructive', 'bg-severity-high', 'bg-severity-moderate', 'bg-primary'];

  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors',
              level <= score ? colors[score - 1] : 'bg-border',
            )}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('accept.strengthLabel')}: {levels[score - 1]}
      </p>
    </div>
  );
}

/** Input de contraseña con el ojito adentro (patrón botón dentro del input). */
function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  visible,
  onToggleVisible,
  ariaInvalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  visible: boolean;
  onToggleVisible: () => void;
  ariaInvalid?: boolean;
}) {
  const t = useTranslations('invite');
  const ToggleIcon = visible ? EyeOff : Eye;
  return (
    <div className="relative mt-2">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="pr-10"
        aria-invalid={ariaInvalid || undefined}
      />
      <button
        type="button"
        onClick={onToggleVisible}
        aria-label={visible ? t('accept.hidePassword') : t('accept.showPassword')}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ToggleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
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
  const t = useTranslations('invite');
  const format = useFormatter();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // Se guarda la CLAVE del error (no el texto) para que el mensaje se
  // re-traduzca si el usuario cambia de idioma con el error visible.
  const [errorKey, setErrorKey] = React.useState<'errorGone' | 'errorConflict' | 'errorGeneric' | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  // El submit recién se habilita cuando la confirmación coincide (pulido QA).
  const canSubmit = !submitting && password.length > 0 && password === confirm;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorKey(null);
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
        setErrorKey('errorGone');
      } else if (err instanceof ApiStatusError && err.status === 409) {
        setErrorKey('errorConflict');
      } else {
        setErrorKey('errorGeneric');
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
      <p className="font-mono text-xs uppercase tracking-widest text-primary">
        {t('accept.kicker')}
      </p>
      <h1 className="mt-2 font-heading text-2xl font-bold tracking-tight">{t('accept.title')}</h1>

      {/* Email y rol READ-ONLY: vienen de la invitación, server-side. No hay
          (ni debe haber) ningún control para cambiarlos. */}
      <dl className="mt-4 space-y-1 rounded-lg border border-border bg-background/50 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('accept.emailLabel')}</dt>
          <dd className="truncate font-mono">{invitation.email}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('accept.roleLabel')}</dt>
          <dd className="font-medium">{t(`roles.${invitation.role}`)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{t('accept.expiresLabel')}</dt>
          {/* Antes formatExpiry con Intl crudo y locale clavado; ahora el
              formatter de next-intl con el locale activo (es-AR/en-US). */}
          <dd>{format.dateTime(new Date(invitation.expires_at), { dateStyle: 'long' })}</dd>
        </div>
      </dl>

      {errorKey && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {t(`accept.${errorKey}`)}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-5">
        <label htmlFor="invite-password" className="block text-sm font-medium">
          {t('accept.passwordLabel')}
        </label>
        <PasswordInput
          id="invite-password"
          value={password}
          onChange={setPassword}
          placeholder={t('accept.passwordPlaceholder')}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((v) => !v)}
        />
        <StrengthMeter password={password} />

        <label htmlFor="invite-password-confirm" className="mt-4 block text-sm font-medium">
          {t('accept.confirmLabel')}
        </label>
        <PasswordInput
          id="invite-password-confirm"
          value={confirm}
          onChange={setConfirm}
          placeholder={t('accept.confirmPlaceholder')}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((v) => !v)}
          ariaInvalid={mismatch}
        />
        {mismatch && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('accept.mismatch')}
          </p>
        )}

        <Button type="submit" className="mt-4 min-h-11 w-full" disabled={!canSubmit}>
          <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
          {submitting ? t('accept.submitting') : t('accept.submit')}
        </Button>
      </form>

      <div className="mt-5 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          {t('accept.divider')}
        </span>
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
        {t('accept.google')}
      </Button>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {/* La vieja pareja [prefijo, sufijo] es UNA clave ICU: el email va
            interpolado dentro del tag <mono> — texto visible idéntico. */}
        {t.rich('accept.googleHint', {
          email: invitation.email,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </p>
    </div>
  );
}
