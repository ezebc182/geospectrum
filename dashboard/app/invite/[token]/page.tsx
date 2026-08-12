'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, Eye, EyeOff, LogIn, MailX, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiStatusError, login, registerWithInvitation, validateInvitationToken } from '@/lib/auth';
import { INVITE_COPY, passwordStrength } from '@/lib/invite-i18n';
import type { InviteCopy } from '@/lib/invite-i18n';
import type { InvitationLocale, InvitationValidation } from '@/lib/types';
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
 * i18n (pulido post-QA): todo el copy vive en lib/invite-i18n.ts (ES/EN).
 * El idioma inicial es el `locale` de la invitación (respuesta de validate);
 * el toggle de arriba permite cambiarlo en caliente.
 */

type ValidationState =
  | { kind: 'loading' }
  | { kind: 'valid'; invitation: InvitationValidation }
  | { kind: 'invalid' } // 404: token desconocido
  | { kind: 'gone' } // 410: expirada / revocada / ya usada
  | { kind: 'error' }; // red caída u otro fallo no contemplado

function formatExpiry(iso: string, locale: InvitationLocale): string {
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-AR' : 'en-US', {
    dateStyle: 'long',
  }).format(new Date(iso));
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = React.use(params);
  const [state, setState] = React.useState<ValidationState>({ kind: 'loading' });
  const [locale, setLocale] = React.useState<InvitationLocale>('es');

  React.useEffect(() => {
    let cancelled = false;

    validateInvitationToken(token)
      .then((invitation) => {
        if (cancelled) return;
        setState({ kind: 'valid', invitation });
        // El idioma del email en que llegó el link manda como default; el
        // toggle sigue disponible para cambiarlo en caliente.
        setLocale(invitation.locale === 'en' ? 'en' : 'es');
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

  const copy = INVITE_COPY[locale];

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

        <LocaleSwitcher locale={locale} onChange={setLocale} ariaLabel={copy.localeSwitcherAria} />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card/70 p-8 backdrop-blur">
          {state.kind === 'loading' && (
            <p className="text-sm text-muted-foreground">{copy.loading}</p>
          )}

          {state.kind === 'valid' && (
            <AcceptInvitation token={token} invitation={state.invitation} copy={copy} locale={locale} />
          )}

          {state.kind === 'invalid' && (
            <InvitationError title={copy.errors.invalidTitle} message={copy.errors.invalidMessage} />
          )}

          {state.kind === 'gone' && (
            <InvitationError title={copy.errors.goneTitle} message={copy.errors.goneMessage} />
          )}

          {state.kind === 'error' && (
            <InvitationError title={copy.errors.networkTitle} message={copy.errors.networkMessage} />
          )}
        </div>
      </main>
    </div>
  );
}

/** Toggle ES/EN — dos botones, el activo resaltado. Sin persistencia: la
 * página se visita una sola vez y el default ya viene de la invitación. */
function LocaleSwitcher({
  locale,
  onChange,
  ariaLabel,
}: {
  locale: InvitationLocale;
  onChange: (locale: InvitationLocale) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-lg border border-border text-xs font-medium"
    >
      {(['es', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={locale === option}
          onClick={() => onChange(option)}
          className={cn(
            'px-3 py-1.5 uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            locale === option
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted/60',
          )}
        >
          {option === 'es' ? 'ES' : 'EN'}
        </button>
      ))}
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
function StrengthMeter({ password, copy }: { password: string; copy: InviteCopy }) {
  const score = passwordStrength(password);
  if (score === 0) return null;

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
        {copy.accept.strengthLabel}: {copy.accept.strengthLevels[score - 1]}
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
  copy,
  ariaInvalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  visible: boolean;
  onToggleVisible: () => void;
  copy: InviteCopy;
  ariaInvalid?: boolean;
}) {
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
        aria-label={visible ? copy.accept.hidePassword : copy.accept.showPassword}
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
  copy,
  locale,
}: {
  token: string;
  invitation: InvitationValidation;
  copy: InviteCopy;
  locale: InvitationLocale;
}) {
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
        {copy.accept.kicker}
      </p>
      <h1 className="mt-2 font-heading text-2xl font-bold tracking-tight">{copy.accept.title}</h1>

      {/* Email y rol READ-ONLY: vienen de la invitación, server-side. No hay
          (ni debe haber) ningún control para cambiarlos. */}
      <dl className="mt-4 space-y-1 rounded-lg border border-border bg-background/50 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{copy.accept.emailLabel}</dt>
          <dd className="truncate font-mono">{invitation.email}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{copy.accept.roleLabel}</dt>
          <dd className="font-medium">{copy.roles[invitation.role] ?? invitation.role}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{copy.accept.expiresLabel}</dt>
          <dd>{formatExpiry(invitation.expires_at, locale)}</dd>
        </div>
      </dl>

      {errorKey && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {copy.accept[errorKey]}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-5">
        <label htmlFor="invite-password" className="block text-sm font-medium">
          {copy.accept.passwordLabel}
        </label>
        <PasswordInput
          id="invite-password"
          value={password}
          onChange={setPassword}
          placeholder={copy.accept.passwordPlaceholder}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((v) => !v)}
          copy={copy}
        />
        <StrengthMeter password={password} copy={copy} />

        <label htmlFor="invite-password-confirm" className="mt-4 block text-sm font-medium">
          {copy.accept.confirmLabel}
        </label>
        <PasswordInput
          id="invite-password-confirm"
          value={confirm}
          onChange={setConfirm}
          placeholder={copy.accept.confirmPlaceholder}
          visible={showPassword}
          onToggleVisible={() => setShowPassword((v) => !v)}
          copy={copy}
          ariaInvalid={mismatch}
        />
        {mismatch && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {copy.accept.mismatch}
          </p>
        )}

        <Button type="submit" className="mt-4 min-h-11 w-full" disabled={!canSubmit}>
          <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
          {submitting ? copy.accept.submitting : copy.accept.submit}
        </Button>
      </form>

      <div className="mt-5 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          {copy.accept.divider}
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
        {copy.accept.google}
      </Button>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {copy.accept.googleHint[0]}
        <span className="font-mono">{invitation.email}</span>
        {copy.accept.googleHint[1]}
      </p>
    </div>
  );
}
